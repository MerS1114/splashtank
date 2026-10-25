// FLIP helpers for bakes and the live view on the CPU side: whitewater codes, drip samples, cache frames, the bake report numbers, and the GPU bake loop.
// the same 32-bit packing as the shader: top bit, two bits of kind (00 spray, 10 mist, 01 foam, 11 bubble), 8 bits of speed in quarter units
// per second, then the direction (spray, mist) or how much life is left (foam, bubbles)
function packSprayJS(vx, vy, vz, kind, lifeFrac, seed) {
  kind = kind === true ? 1 : (kind | 0);
  const s = Math.hypot(vx, vy, vz);
  let code = (0x80000000 | (Math.min(Math.floor(s * 4), 255) << 21)) >>> 0;
  code = (code | [0, 0x40000000, 0x20000000, 0x60000000][kind & 3]) >>> 0;
  seed = seed >>> 0;   // as wwSeed in the shader: look-only extras keep their places from frame to frame
  if (kind >= 2) return (code | ((((seed & 2047) | 1) << 10) >>> 0) | Math.round(Math.max(0, Math.min(1, lifeFrac || 0)) * 1023)) >>> 0;
  if (kind === 1) return (code | (seed & 0xFFFFF) | 1) >>> 0;
  let nx = 0, ny = 1, nz = 0; if (s > 1e-6) { nx = vx / s; ny = vy / s; nz = vz / s; }
  const l = Math.abs(nx) + Math.abs(ny) + Math.abs(nz); let px = nx / l, py = ny / l;
  if (nz < 0) { const qx = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1), qy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1); px = qx; py = qy; }
  const u = Math.max(0, Math.min(1023, Math.round((px * 0.5 + 0.5) * 1023))), w = Math.max(0, Math.min(1023, Math.round((py * 0.5 + 0.5) * 1023)));
  return (code | (w << 10) | u) >>> 0;
}
// drip samples on a collider, from its distance grid: grid points near the surface, moved onto it along the gradient, about one per solver
// cell of surface (at most 6000). 8 floats each: local position, collider number, local normal, wetness (starts dry).
const DRIP_CACHE = new Map();
function dripSamples(sdf, h, k) {
  const key = sdf.id + '|' + h.toFixed(5);
  let base = DRIP_CACHE.get(key);
  if (!base) {
    const [nx, ny, nz] = sdf.dims, c = sdf.cell, d = sdf.data, o = sdf.origin, pts = [];
    const at = (i, j, q) => d[Math.min(nx - 1, Math.max(0, i)) + nx * (Math.min(ny - 1, Math.max(0, j)) + ny * Math.min(nz - 1, Math.max(0, q)))];
    for (let q = 1; q < nz - 1; q++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const v = d[i + nx * (j + ny * q)]; if (Math.abs(v) > 0.6 * c) continue;
      let gx = at(i + 1, j, q) - at(i - 1, j, q), gy = at(i, j + 1, q) - at(i, j - 1, q), gz = at(i, j, q + 1) - at(i, j, q - 1);
      const gl = Math.hypot(gx, gy, gz); if (gl < 1e-9) continue; gx /= gl; gy /= gl; gz /= gl;
      pts.push(o[0] + i * c - gx * v, o[1] + j * c - gy * v, o[2] + q * c - gz * v, gx, gy, gz);
    }
    const nsurf = pts.length / 6, want = Math.max(100, Math.min(6000, Math.round(nsurf * c * c / (h * h))));
    const step = Math.max(1, nsurf / want), out = [];
    let sd = 7 + (sdf.id | 0); const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (let t = rnd() * step; t < nsurf; t += step) { const i = Math.floor(t) * 6; out.push(pts[i], pts[i + 1], pts[i + 2], 0, pts[i + 3], pts[i + 4], pts[i + 5], 0); }
    base = new Float32Array(out); DRIP_CACHE.set(key, base);
    if (DRIP_CACHE.size > 32) DRIP_CACHE.delete(DRIP_CACHE.keys().next().value);
  }
  const a = base.slice(); for (let i = 3; i < a.length; i += 8) a[i] = k;
  return a;
}
// live whitewater slots for a cache frame: an even sample of at most about cap points, positions across the box like the water. The sample goes
// by slot number, so a point that stays alive stays in the sample from frame to frame (sampling by count would pick different points each frame).
const wwSeedJS = (j) => Math.imul(j, 2654435761) >>> 11;
const wwKeepJS = (j) => (Math.imul(j * 7919 + 104729, 2654435761) >>> 0) / 4294967296;   // a stable per-slot draw: the sample changes little as the count changes
function packSprayFrame(sd, b, cap, foamLife) {
  foamLife = foamLife || 3;
  let alive = 0; for (let j = 0; j < sd.n; j++) if (sd.p[j * 4 + 3] > 0) alive++;
  const share = alive > cap ? cap / alive : 1, keep = (j) => sd.p[j * 4 + 3] > 0 && (share >= 1 || wwKeepJS(j) < share);
  let m = 0; for (let j = 0; j < sd.n; j++) if (keep(j)) m++;
  m = Math.min(m, cap);
  const pos = new Uint16Array(m * 3), pk = new Uint32Array(m);
  const kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0);
  let k = 0;
  for (let j = 0; j < sd.n && k < m; j++) {
    if (!keep(j)) continue;
    pos[k * 3] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4] - b.x0) * kx))); pos[k * 3 + 1] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4 + 1] - b.y0) * ky)));
    pos[k * 3 + 2] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4 + 2] - b.z0) * kz)));
    pk[k] = packSprayJS(sd.v[j * 4], sd.v[j * 4 + 1], sd.v[j * 4 + 2], Math.round(sd.v[j * 4 + 3]), sd.p[j * 4 + 3] / foamLife, wwSeedJS(j)); k++;
  }
  return { n: k, pos, pk, alive };
}
// Per-frame measurements for the bake report: where the water is, how fast, how much left or went bad.
function bakeDiag(dst, n, b, vcap) {
  const H = 16, hist = new Array(H).fill(0), hy = (b.y1 - b.y0) / H, cap = Math.min(vcap || 14, 63) * 0.98, e = 1e-3;
  let alive = 0, bad = 0, out = 0, capped = 0, foamy = 0, sx = 0, sy = 0, sz = 0, ss = 0, smax = 0, fl = 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = dst[i * 4], y = dst[i * 4 + 1], z = dst[i * 4 + 2], w = dst[i * 4 + 3];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w))) { bad++; continue; }
    if (y < -1e5) continue;
    alive++;
    const lv = Math.floor(w / 64), sp = w - lv * 64;
    sx += x; sy += y; sz += z; ss += sp; if (sp > smax) smax = sp; fl += lv; if (lv >= 8) foamy++;
    if (sp >= cap) capped++;
    if (x < b.x0 - e || x > b.x1 + e || y < b.y0 - e || y > b.y1 + e || z < b.z0 - e || z > b.z1 + e) out++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    hist[Math.max(0, Math.min(H - 1, Math.floor((y - b.y0) / hy)))]++;
  }
  const a = Math.max(alive, 1);
  return { alive, gone: n - alive - bad, nonFinite: bad, outsideBox: out, atWaterSpeedLimit: capped, meanSpeed: ss / a, maxSpeed: smax, meanFoam: fl / a / 15, foamyPoints: foamy,
    center: [sx / a, sy / a, sz / a], bbox: alive ? [x0, y0, z0, x1, y1, z1] : null, heightHist: hist };
}
// Same contract as runBakeGpu. Substeps adapt to the fastest particle of the last frame so fast splashes get small steps and calm frames get few.
async function runBakeFlipGpu(desc, gpu, onFrame, isCancelled) {
  const sim = new FlipSim(gpu.dev, { d: desc.d, maxN: desc.maxN, size: desc.size, open: desc.open, ratio: desc.cellRatio });
  await sim.whenReady;   // the shared pipelines, compiled once per device
  sim.recycle = false; sim.cap = desc.maxN; sim.opt.fastAir = !!desc.fastAir; sim.opt.sort = !!desc.sortP; sim.opt.p2gWin = !!desc.p2gWin;
  if (desc.spr && desc.sprayCap) sim.setSprayCap(desc.sprayCap);
  if (desc.nbLook) sim.setDeepLook(true);
  const runner = new SceneRunner(sim);
  const oc = desc.ocean && desc.ocean.on ? desc.ocean : null, nbc = desc.nb && (desc.nb.on || oc) ? desc.nb : null;
  if (nbc || oc) nbSeed(sim, desc.fills, nbc || { on: true, band: 3 }, oc, 0, desc.g, 1);
  else for (const f of desc.fills) {
    if (f.t === 'box') sim.fillBox(f.x0, f.x1, f.y0, f.y1, f.z0, f.z1);
    else if (f.t === 'vol') fillVolume(sim, f);
    else sim.fillSphere(f.x, f.y, f.z, f.r, 0, f.vy || 0, 0);
  }
  const dst = new Float32Array(desc.maxN * 4);
  const fps = desc.fps, F = desc.frames, dtF = 1 / fps, minSub = desc.substeps, cfl = desc.cfl || 1.5, maxSub = Math.max(minSub, desc.maxSub || 16);
  const ev = desc.events.slice().sort((a, b) => a.t - b.t); let ei = 0;
  const t0 = Date.now();
  const sampleAll = (t) => desc.objs.map((o) => sampleObjState(o, t));
  let vmax = 2;
  for (const o of sampleAll(0)) if (o.kind === 'emitter') vmax = Math.max(vmax, o.speed || 0);
  if (sim.N > 0) await sim.prime({ g: desc.g, iters: desc.iters, cols: [] });   // size the block pool for the starting water
  let n = await sim.readbackInto(dst);
  onFrame(packFrameBuf(dst, n, sim.b, sampleAll(0), desc.scale), { f: 0, F, n, elapsed: 0, full: false, diag: Object.assign(bakeDiag(dst, n, sim.b, desc.vmaxW), { sub: 0, blockPool: sim.scap }) });
  let ok = true;
  for (let f = 1; f <= F; f++) {
    const objV = objSpeed(sampleAll((f - 1) * dtF), sampleAll(f * dtF), dtF, desc.colMax);   // objects' own motion during this frame is known ahead
    const sub = Math.max(minSub, Math.min(maxSub, Math.ceil(dtF * Math.max(vmax, objV) / (cfl * sim.h)))), dt = dtF / sub, tf0 = performance.now(), ovf0 = sim.ovfTotal || 0;
    for (let s = 0; s < sub; s++) {
      const t = (f - 1) * dtF + (s + 1) * dt;
      while (ei < ev.length && ev[ei].t <= t) { const e = ev[ei++]; sim.fillSphere(e.x, e.y, e.z, e.r, 0, -1, 0); }
      runner.step(dt, sampleAll(t), { g: desc.g, iters: desc.iters, flip: desc.flip, comp: desc.comp, wind: desc.wind, drag: desc.drag, foamTau: desc.foamTau, gust: desc.gust, foamSens: desc.foamSens, colMax: desc.colMax, vmax: desc.vmaxW, scale: desc.scale || 1, vs: desc.scale || 1, tear: desc.tear || 0, spr: desc.spr || null,
        nb: nbc, ocean: oc, time: t, air: desc.air || null, drip: desc.drip || null });
    }
    n = await sim.readbackInto(dst);
    let mv = 0; for (let i = 0; i < n; i++) { const w = dst[i * 4 + 3] % 64; if (w > mv) mv = w; }
    if (sim.stats && sim.stats.vmax > mv) mv = sim.stats.vmax;
    for (const o of sampleAll(f * dtF)) if (o.kind === 'emitter' && o.on) mv = Math.max(mv, o.speed || 0);
    vmax = Math.max(1, mv);
    const st = sim.stats || {};
    const diag = Object.assign(bakeDiag(dst, n, sim.b, desc.vmaxW), { sub, objectSpeed: objV, fastestParticle: st.vmax, fluidCells: st.fluid, blocksUsed: st.sc, blockPool: sim.scap,
      blocksNoRoom: (sim.ovfTotal || 0) - ovf0, ms: performance.now() - tf0 });
    const frame = packFrameBuf(dst, n, sim.b, sampleAll(f * dtF), desc.scale);
    if (sim.sprayCap) { const sd = await sim.readSpray(); if (sd) { frame.sp = packSprayFrame(sd, sim.ab || sim.b, 200000, (desc.spr && desc.spr.ww && desc.spr.ww.foamLife) || 3); diag.sprayPoints = frame.sp.alive; frame.sb = Object.assign({}, sim.ab || sim.b); } }
    if (desc.nbLook) { const dd = await sim.readDeep(); if (dd && dd.n) { frame.dp = packDeep(dd.p, dd.n, sim.b, desc.scale); diag.deepPoints = dd.n; } }
    onFrame(frame, { f, F, n, elapsed: (Date.now() - t0) / 1000, full: sim.N >= sim.cap, sub, diag });
    if (isCancelled()) { ok = false; break; }
    await new Promise((r) => setTimeout(r, 0));
  }
  sim.destroy();
  return ok;
}

// Whitewater made afterwards from a finished water bake, Houdini style: the water is not simulated again. For each baked frame the
// particles are loaded with the velocity worked out from where they are in the next frame (a bake keeps every particle in its place),
// deep water points (narrow band look) are loaded as still water so the grid knows the water is there, and the whitewater stages run
// over the frame in substeps while the particles move on towards the next frame. The result replaces each frame's whitewater.
// desc: the scene now (colliders with their distance grids, whitewater settings). onProgress(f, F); isCancelled() stops it.
async function runWhitewaterPass(c, desc, gpu, onProgress, isCancelled) {
  const fr = c.frames, F = fr.length, cd = c.desc || {}, b = c.b, fps = c.fps, dtF = 1 / fps;
  if (F < 2 || !desc.spr || !desc.sprayCap) return false;
  let maxD = 0; for (const f of fr) if (f.dp) maxD = Math.max(maxD, f.dp.n);
  const ratio = cd.cellRatio || desc.cellRatio || 2, copies = Math.max(1, Math.min(8, Math.round(Math.pow(ratio, 3))));   // a deep cell holds as many particles as a full water cell
  const sim = new FlipSim(gpu.dev, { d: c.d, maxN: c.maxN + maxD * copies + 16, size: cd.size || desc.size, open: cd.open !== undefined ? cd.open : desc.open, ratio });
  await sim.whenReady;
  sim.recycle = false; sim.cap = sim.MAXN; sim.opt.sort = false; sim.opt.fastAir = !!desc.fastAir; sim.wwOnly = true;
  sim.setSprayCap(desc.sprayCap);
  const runner = new SceneRunner(sim), h = sim.h, scale = desc.scale || 1, foamLife = (desc.spr.ww && desc.spr.ww.foamLife) || 3;
  const meshes = desc.objs.filter((o) => o.kind === 'mesh');
  const par = (t) => ({ g: desc.g, iters: 1, flip: 0.95, comp: 6, wind: desc.wind, drag: desc.drag, foamTau: desc.foamTau, gust: desc.gust, foamSens: desc.foamSens, colMax: desc.colMax,
    vmax: desc.vmaxW, scale, vs: scale, tear: 0, spr: desc.spr, nb: null, ocean: null, time: t, air: desc.air || null, drip: desc.drip || null });
  const spdK = c.spdMs ? 1 / 16 / (c.scale || 1) : 1 / 16;   // speed byte to scene units a second
  const pS = sim.pS, vS = sim.vS, J = h * 0.25;
  let ok = true;
  for (let f = 1; f < F; f++) {
    const A = fr[f - 1], Bf = fr[f]; let n = 0, vmax = 0;
    for (let i = 0; i < A.n; i++, n++) {
      const pa = framePoint(A, b, i), k = n * 4;
      if (pa[3] === 255) { pS[k] = 0; pS[k + 1] = -1.0e6; pS[k + 2] = 0; pS[k + 3] = 0; vS[k] = vS[k + 1] = vS[k + 2] = vS[k + 3] = 0; continue; }
      let vx = 0, vy = 0, vz = 0;
      if (i < Bf.n) {
        const pb = framePoint(Bf, b, i);
        if (pb[3] !== 255) {
          vx = (pb[0] - pa[0]) * fps; vy = (pb[1] - pa[1]) * fps; vz = (pb[2] - pa[2]) * fps;
          // a slot the narrow band gave to another particle jumps further than either speed allows: no velocity for that frame
          const u = Math.hypot(vx, vy, vz), s = Math.max(pa[3], pb[3]) * spdK;
          if (Math.max(pa[3], pb[3]) < 191 && u > 2 * s + 2 * h * fps) { vx = vy = vz = 0; }
        }
      }
      pS[k] = pa[0]; pS[k + 1] = pa[1]; pS[k + 2] = pa[2]; pS[k + 3] = 0;
      vS[k] = vx; vS[k + 1] = vy; vS[k + 2] = vz; vS[k + 3] = pa[4] / 15;   // the white-water level the bake gave it (impacts, churn)
      vmax = Math.max(vmax, vx * vx + vy * vy + vz * vz);
    }
    if (A.dp) for (let i = 0; i < A.dp.n; i++) {
      const pd = framePoint(A.dp, b, i, A.q); if (pd[3] === 255) continue;
      for (let m = 0; m < copies; m++, n++) {
        const k = n * 4;
        pS[k] = pd[0] + ((m & 1) ? J : -J); pS[k + 1] = pd[1] + ((m & 2) ? J : -J); pS[k + 2] = pd[2] + ((m & 4) ? J : -J); pS[k + 3] = 0;
        vS[k] = vS[k + 1] = vS[k + 2] = vS[k + 3] = 0;
      }
    }
    sim.N = n;
    sim.dev.queue.writeBuffer(sim.bPos, 0, pS, 0, n * 4); sim.dev.queue.writeBuffer(sim.bVel, 0, vS, 0, n * 4);
    const sub = Math.max(2, Math.min(8, Math.ceil(dtF * Math.sqrt(vmax) / (1.5 * h)))), dt = dtF / sub;
    for (let s = 0; s < sub; s++) { const t = (f - 1) * dtF + (s + 1) * dt; runner.step(dt, meshes.map((o) => sampleObjState(o, t)), par(t)); }
    const sd = await sim.readSpray();
    let sp = sd ? packSprayFrame(sd, sim.ab || sim.b, 200000, foamLife) : null;
    const fq = Bf.p32 ? Bf.q || c.q : null; if (sp && fq) sp = { n: sp.n, p32: packPos32(sp.pos, sp.n, fq), pk: sp.pk, alive: sp.alive };
    if (sp && sp.n) { Bf.sp = sp; Bf.sb = Object.assign({}, sim.ab || sim.b); } else { delete Bf.sp; delete Bf.sb; }
    Bf.wws = 2;   // made by Bake whitewater
    onProgress(f, F);
    if (isCancelled()) { ok = false; break; }
    await new Promise((r) => setTimeout(r, 0));
  }
  if (ok) { delete fr[0].sp; fr[0].wws = 2; }
  sim.destroy();
  return ok;
}
