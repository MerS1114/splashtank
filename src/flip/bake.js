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
  sim.recycle = false; sim.cap = desc.maxN; sim.opt.fastAir = !!desc.fastAir; sim.opt.sort = !!desc.sortP; sim.opt.p2gWin = !!desc.p2gWin; sim.opt.ballistic = desc.ballistic !== false; sim.opt.settle = !!desc.settle; sim.opt.settleTol = desc.settleTol; sim.opt.mg = !!desc.mg; sim.opt.sep = desc.sep || 0; sim.opt.apic = !!desc.apic;
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
    const diag = Object.assign(bakeDiag(dst, n, sim.b, desc.vmaxW), { sub, objectSpeed: objV, fastestParticle: st.vmax, fluidCells: st.fluid, settled: st.settled, blocksUsed: st.sc, blockPool: sim.scap,
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

// Detail pass (Houdini-style guided resimulation of a region): after a water bake, a second FLIP sim k times finer runs over just a box of
// the tank, guided by the bake. Each frame, from the coarse frame and the next one (particles keep their places, so their motion gives
// the velocity; bakes store none):
// - water is counted in coarse cells over the region; with narrow band, cells under the band's bottom count as deep water (or the deep
//   water points when the bake kept them);
// - a boundary layer two coarse cells wide inside each open side of the region is cleared and filled again from the coarse water, with its
//   velocity, so water flows in and out with the bake (sides on the tank's walls are walls);
// - inside, fine particles are pulled a little towards the coarse velocity of their cell (Follow the bake), so the detail keeps to the
//   bake's motion while finer splashes form;
// then the fine sim steps through the frame. The result replaces each frame: the bake's water inside the region is hidden and the fine
// water added after it (same frame layout, so playback, saving and Bake whitewater work as before). c.coarse keeps the bake's own frames.
// desc: the scene now (colliders, physics) plus desc.det = { box: {x0..z1}, k (2 or 3), pull (0-1 per frame) }.
function detailBox(b, box, hc) {   // the region inside the tank, at least four coarse cells a side
  const r = { x0: Math.max(b.x0, box.x0), x1: Math.min(b.x1, box.x1), y0: Math.max(b.y0, box.y0), y1: Math.min(b.y1, box.y1), z0: Math.max(b.z0, box.z0), z1: Math.min(b.z1, box.z1) };
  return (r.x1 - r.x0 < 4 * hc || r.y1 - r.y0 < 4 * hc || r.z1 - r.z0 < 4 * hc) ? null : r;
}
function unpack32(p32, n, q) {   // compact positions back to 16 bits a coordinate across the same box
  const out = new Uint16Array(n * 3), mx = (1 << q[0]) - 1, my = (1 << q[1]) - 1, mz = (1 << q[2]) - 1, sy = q[0], sz = q[0] + q[1];
  for (let i = 0; i < n; i++) { const v = p32[i]; out[i * 3] = Math.round((v & mx) / mx * 65535); out[i * 3 + 1] = Math.round(((v >>> sy) & my) / my * 65535); out[i * 3 + 2] = Math.round(((v >>> sz) & mz) / mz * 65535); }
  return out;
}
async function runDetailPass(c, desc, gpu, onProgress, isCancelled) {
  const src = c.coarse || c.frames, F = src.length, cd = c.desc || {}, b = c.b, fps = c.fps, dtF = 1 / fps, det = desc.det;
  if (F < 2 || !det) return false;
  const ratio = cd.cellRatio || desc.cellRatio || 2, hc = c.d * ratio, k = Math.max(2, Math.min(4, det.k | 0 || 2)), dF = c.d / k, restC = ratio * ratio * ratio;
  const R0 = detailBox(b, det.box, hc); if (!R0) throw new Error('The detail region is too small or outside the tank.');
  const spdK = c.spdMs ? 1 / 16 / (c.scale || 1) : 1 / 16, nbBake = !!((cd.nb && cd.nb.on && cd.nb.band < 1e4) || (cd.ocean && cd.ocean.on));
  // the coarse water over the region (and one cell around it), counted in coarse cells: particles, their velocity, deep water
  const gx0 = R0.x0 - hc, gy0 = R0.y0 - hc, gz0 = R0.z0 - hc;
  const NX = Math.ceil((R0.x1 - R0.x0) / hc) + 2, NY = Math.ceil((R0.y1 - R0.y0) / hc) + 2, NZ = Math.ceil((R0.z1 - R0.z0) / hc) + 2, NC = NX * NY * NZ;
  const cnt = new Float32Array(NC), vel = new Float32Array(NC * 3), deep = new Uint8Array(NC);
  const cellAt = (x, y, z) => { const i = Math.floor((x - gx0) / hc), j = Math.floor((y - gy0) / hc), q = Math.floor((z - gz0) / hc); return (i < 0 || j < 0 || q < 0 || i >= NX || j >= NY || q >= NZ) ? -1 : i + NX * (j + NY * q); };
  function occupy(A, Bn) {
    cnt.fill(0); vel.fill(0); deep.fill(0);
    for (let i = 0; i < A.n; i++) {
      const pa = framePoint(A, b, i); if (pa[3] === 255) continue;
      const ci = cellAt(pa[0], pa[1], pa[2]); if (ci < 0) continue;
      cnt[ci]++;
      if (Bn && i < Bn.n) {
        const pb = framePoint(Bn, b, i); if (pb[3] === 255) continue;
        const vx = (pb[0] - pa[0]) * fps, vy = (pb[1] - pa[1]) * fps, vz = (pb[2] - pa[2]) * fps, u = Math.hypot(vx, vy, vz), s = Math.max(pa[3], pb[3]) * spdK;
        if (Math.max(pa[3], pb[3]) < 191 && u > 2 * s + 2 * hc * fps) continue;   // a narrow band slot given to another particle: no velocity
        vel[ci * 3] += vx; vel[ci * 3 + 1] += vy; vel[ci * 3 + 2] += vz;
      }
    }
    for (let ci = 0; ci < NC; ci++) if (cnt[ci] > 0) { vel[ci * 3] /= cnt[ci]; vel[ci * 3 + 1] /= cnt[ci]; vel[ci * 3 + 2] /= cnt[ci]; }
    if (A.dp) { for (let i = 0; i < A.dp.n; i++) { const pd = framePoint(A.dp, b, i, A.q); if (pd[3] === 255) continue; const ci = cellAt(pd[0], pd[1], pd[2]); if (ci >= 0) deep[ci] = 1; } }
    else if (nbBake) {   // narrow band without its deep points: under the bottom of the band (a well filled cell) is water, moving with it
      for (let q = 0; q < NZ; q++) for (let i = 0; i < NX; i++) {
        let jb = -1; for (let j = 0; j < NY; j++) if (cnt[i + NX * (j + NY * q)] >= 0.5 * restC) { jb = j; break; }
        if (jb <= 0) continue;
        const cb = i + NX * (jb + NY * q);
        for (let j = 0; j < jb; j++) { const ci = i + NX * (j + NY * q); if (gy0 + (j + 0.5) * hc < b.y0 || cnt[ci] > 0) continue; deep[ci] = 1; vel[ci * 3] = vel[cb * 3]; vel[ci * 3 + 1] = vel[cb * 3 + 1]; vel[ci * 3 + 2] = vel[cb * 3 + 2]; }
      }
    }
  }
  // how many fine particles the region may hold: the most coarse water it ever had, in fine particles, with room to spare
  let most = 0;
  for (let f = 0; f < F; f++) { occupy(src[f], null); let m = 0; for (let ci = 0; ci < NC; ci++) m += deep[ci] ? restC : Math.min(cnt[ci], restC); most = Math.max(most, m); }
  const maxN = Math.ceil(most * k * k * k * 1.3) + 65536;
  if (maxN * 16 > (gpu.maxBuf || gpu.dev.limits.maxStorageBufferBindingSize || (1 << 27))) throw new Error('The detail region holds too much water for one GPU buffer here (' + Math.round(maxN / 1e6 * 10) / 10 + 'M points). Make it smaller or pick 2x.');
  // the fine sim over the region; a side on the tank's wall keeps the tank's wall, the others are open
  const near = (a, w) => Math.abs(a - w) < 0.5 * hc, tankOpen = cd.open !== undefined ? cd.open : desc.open;
  let open = 0; [[R0.x0, b.x0, 1], [R0.x1, b.x1, 2], [R0.y0, b.y0, 4], [R0.y1, b.y1, 8], [R0.z0, b.z0, 16], [R0.z1, b.z1, 32]].forEach(([r, w, bit]) => { if (!near(r, w) || (tankOpen & bit)) open |= bit; });
  const sim = new FlipSim(gpu.dev, { d: dF, maxN, size: [R0.x1 - R0.x0, R0.y1 - R0.y0, R0.z1 - R0.z0], open, ratio, org: [R0.x0, R0.y0, R0.z0] });
  await sim.whenReady;
  sim.recycle = false; sim.cap = maxN; sim.opt.sort = false; sim.opt.ballistic = desc.ballistic !== false; sim.opt.mg = !!desc.mg; sim.opt.sep = desc.sep || 0; sim.opt.apic = !!desc.apic;
  const R = sim.b, hF = sim.h, Lw = 2 * hc, runner = new SceneRunner(sim), scale = desc.scale || 1;
  const openSide = [(open & 1) && !near(R.x0, b.x0), (open & 2) && !near(R.x1, b.x1), (open & 4) && !near(R.y0, b.y0), (open & 8) && !near(R.y1, b.y1), (open & 16) && !near(R.z0, b.z0), (open & 32) && !near(R.z1, b.z1)];
  const inLayer = (x, y, z) => (openSide[0] && x - R.x0 < Lw) || (openSide[1] && R.x1 - x < Lw) || (openSide[2] && y - R.y0 < Lw) || (openSide[3] && R.y1 - y < Lw) || (openSide[4] && z - R.z0 < Lw) || (openSide[5] && R.z1 - z < Lw);
  const inside = (x, y, z) => x >= R.x0 && x <= R.x1 && y >= R.y0 && y <= R.y1 && z >= R.z0 && z <= R.z1;
  const par = (t) => ({ g: desc.g, iters: desc.iters, flip: desc.flip, comp: desc.comp, wind: desc.wind, drag: desc.drag, foamTau: desc.foamTau, gust: desc.gust, foamSens: desc.foamSens, colMax: desc.colMax,
    vmax: desc.vmaxW, scale, vs: scale, tear: desc.tear || 0, spr: null, nb: null, ocean: null, time: t, air: null, drip: null });
  const sampleAll = (t) => desc.objs.map((o) => sampleObjState(o, t));
  const pS = sim.pS, vS = sim.vS, dst = new Float32Array(maxN * 4), free = [];
  let n = 0, sd = 12345; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  // fills the coarse cells chosen by want(ci, centre) with fine particles on a jittered lattice, as full as the coarse water was, moving with it
  const m = Math.round(ratio * k), sub = hc / m;
  function seed(want) {
    for (let q = 0; q < NZ; q++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const ci = i + NX * (j + NY * q), full = deep[ci] ? 1 : Math.min(1, cnt[ci] / restC); if (full <= 0) continue;
      const cx = gx0 + i * hc, cy = gy0 + j * hc, cz = gz0 + q * hc;
      if (!want(cx + 0.5 * hc, cy + 0.5 * hc, cz + 0.5 * hc)) continue;
      for (let c3 = 0; c3 < m * m * m; c3++) {
        if (full < 1 && rnd() > full) continue;
        const x = cx + ((c3 % m) + 0.2 + 0.6 * rnd()) * sub, y = cy + ((Math.floor(c3 / m) % m) + 0.2 + 0.6 * rnd()) * sub, z = cz + (Math.floor(c3 / (m * m)) + 0.2 + 0.6 * rnd()) * sub;
        if (!inside(x, y, z) || !want(x, y, z)) continue;
        const s = free.length ? free.pop() : (n < maxN ? n++ : -1); if (s < 0) return;
        const o = s * 4; pS[o] = x; pS[o + 1] = y; pS[o + 2] = z; pS[o + 3] = 0; vS[o] = vel[ci * 3]; vS[o + 1] = vel[ci * 3 + 1]; vS[o + 2] = vel[ci * 3 + 2]; vS[o + 3] = 0;
      }
    }
  }
  const kill = (s) => { const o = s * 4; pS[o] = 0; pS[o + 1] = -1.0e6; pS[o + 2] = 0; pS[o + 3] = 0; vS[o] = vS[o + 1] = vS[o + 2] = vS[o + 3] = 0; free.push(s); };
  const upload = () => { sim.N = n; sim.dev.queue.writeBuffer(sim.bPos, 0, pS, 0, n * 4); sim.dev.queue.writeBuffer(sim.bVel, 0, vS, 0, n * 4); if (sim.opt.apic) { sim.ensureAff(); sim.zeroAff(0, n); } };
  const velStage = gpu.dev.createBuffer({ size: maxN * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  async function readBack() {
    const bytes = Math.max(n, 1) * 16, e = gpu.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bVel, 0, velStage, 0, bytes); gpu.dev.queue.submit([e.finish()]);
    await velStage.mapAsync(GPUMapMode.READ, 0, bytes); vS.set(new Float32Array(velStage.getMappedRange(0, bytes)).subarray(0, n * 4)); velStage.unmap();
    await sim.readbackInto(dst); pS.set(dst.subarray(0, n * 4));
  }
  // the bake's frame with its water inside the region hidden and the fine water after it, laid out as a bake frame
  const hide = (x, y, z) => x > R.x0 && x < R.x1 && y > R.y0 && y < R.y1 && z > R.z0 && z < R.z1;
  const NA = Math.max(...src.map((x) => x.n));   // the fine points start at the same number in every frame, so playback blends each with itself
  function merge(A, f) {
    const fine = packFrameBuf(dst, n, b, sampleAll(f * dtF), scale), nA = A.n, N = NA + fine.n;
    const pos = new Uint16Array(N * 3), spd = new Uint8Array(N).fill(255, nA, NA), fm = new Uint8Array(N);
    const kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0), Q = (v) => Math.max(0, Math.min(65535, Math.round(v)));
    for (let i = 0; i < nA; i++) {
      const p = framePoint(A, b, i);
      pos[i * 3] = Q((p[0] - b.x0) * kx); pos[i * 3 + 1] = Q((p[1] - b.y0) * ky); pos[i * 3 + 2] = Q((p[2] - b.z0) * kz);
      spd[i] = p[3] === 255 || hide(p[0], p[1], p[2]) ? 255 : p[3]; fm[i] = p[4] * 17;
    }
    pos.set(fine.pos, NA * 3); spd.set(fine.spd, NA); if (fine.fm) fm.set(fine.fm, NA);
    const out = { n: N, pos, spd, fm, objs: A.objs, wws: A.wws, det: { n0: NA, n: fine.n } };
    if (A.sp && A.sp.n) { out.sp = { n: A.sp.n, pos: A.sp.p32 ? unpack32(A.sp.p32, A.sp.n, A.q || c.q) : A.sp.pos, pk: A.sp.pk, alive: A.sp.alive }; if (A.sb) out.sb = A.sb; }
    if (A.dp && A.dp.n) {   // deep water points inside the region: the fine water is there now
      const dn = A.dp.n, dpos = new Uint16Array(dn * 3), dspd = new Uint8Array(dn);
      for (let i = 0; i < dn; i++) { const p = framePoint(A.dp, b, i, A.q); dpos[i * 3] = Q((p[0] - b.x0) * kx); dpos[i * 3 + 1] = Q((p[1] - b.y0) * ky); dpos[i * 3 + 2] = Q((p[2] - b.z0) * kz); dspd[i] = p[3] === 255 || hide(p[0], p[1], p[2]) ? 255 : p[3]; }
      out.dp = { n: dn, pos: dpos, spd: dspd };
    }
    let fr = out; const q = compactBits(b, dF);
    if (q) fr = compactFrame(out, q); else fr = compactFrameBox(out, b, dF) || out;
    if (fr.p32) fr.hid = markInterior(fr, b, dF);
    fr.det = out.det;
    return fr;
  }
  const outF = new Array(F);
  // frame 0: the region filled from the bake's first frame
  occupy(src[0], src[1]); seed(() => true); upload();
  if (n) await sim.prime({ g: desc.g, iters: desc.iters, cols: [] });
  await sim.readbackInto(dst); outF[0] = merge(src[0], 0); onProgress(0, F);
  let ok = true, vmax = 2;
  const pull = Math.max(0, Math.min(1, det.pull === undefined ? 0.15 : det.pull));
  for (let f = 1; f < F; f++) {
    const A = src[f - 1];
    occupy(A, src[f]);
    // leaving the region or in the boundary layer: gone; inside: pulled towards the coarse water's velocity
    for (let s = 0; s < n; s++) {
      const o = s * 4; if (pS[o + 1] < -1e5) continue;
      const x = pS[o], y = pS[o + 1], z = pS[o + 2];
      if (!inside(x, y, z) || inLayer(x, y, z)) { kill(s); continue; }
      if (pull > 0) { const ci = cellAt(x, y, z); if (ci >= 0 && cnt[ci] > 0) { vS[o] += pull * (vel[ci * 3] - vS[o]); vS[o + 1] += pull * (vel[ci * 3 + 1] - vS[o + 1]); vS[o + 2] += pull * (vel[ci * 3 + 2] - vS[o + 2]); } }
    }
    seed(inLayer);   // the layer again from the bake, with its velocity
    let v2 = 0; for (let s = 0; s < n; s++) { const o = s * 4; if (pS[o + 1] < -1e5) continue; const u = vS[o] * vS[o] + vS[o + 1] * vS[o + 1] + vS[o + 2] * vS[o + 2]; if (u > v2) v2 = u; }
    vmax = Math.max(1, Math.sqrt(v2));
    upload();
    const sub = Math.max(desc.substeps || 1, Math.min(Math.max(desc.maxSub || 16, 8) * k, Math.ceil(dtF * vmax / (1.5 * hF)))), dt = dtF / sub;
    for (let s = 0; s < sub; s++) { const t = (f - 1) * dtF + (s + 1) * dt; runner.step(dt, sampleAll(t), par(t)); }
    await readBack();
    outF[f] = merge(src[f], f);
    onProgress(f, F);
    if (isCancelled()) { ok = false; break; }
    await new Promise((r) => setTimeout(r, 0));
  }
  velStage.destroy(); sim.destroy();
  if (!ok) return false;
  if (!c.coarse) c.coarse = c.frames;
  c.frames = outF; c.det = { box: R, k, d: dF, pull, maxN: n };
  c.maxN = Math.max(...outF.map((x) => x.n));
  return true;
}
