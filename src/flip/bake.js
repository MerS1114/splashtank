// FLIP helpers for bakes and the live view on the CPU side: whitewater codes, drip samples, cache frames, the bake report numbers, and the GPU bake loop.
// the same 32-bit packing as the shader: top bit, two bits of kind (00 spray, 10 mist, 01 foam, 11 bubble), 8 bits of speed in quarter units
// per second, then the direction (spray, mist) or how much life is left (foam, bubbles)
function packSprayJS(vx, vy, vz, kind, lifeFrac) {
  kind = kind === true ? 1 : (kind | 0);
  const s = Math.hypot(vx, vy, vz);
  let code = (0x80000000 | (Math.min(Math.floor(s * 4), 255) << 21)) >>> 0;
  code = (code | [0, 0x40000000, 0x20000000, 0x60000000][kind & 3]) >>> 0;
  if (kind >= 2) return (code | Math.round(Math.max(0, Math.min(1, lifeFrac || 0)) * 1023)) >>> 0;
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
function packSprayFrame(sd, b, cap, foamLife) {
  foamLife = foamLife || 3;
  let alive = 0; for (let j = 0; j < sd.n; j++) if (sd.p[j * 4 + 3] > 0) alive++;
  const step = Math.max(1, Math.ceil(alive / cap));
  let m = 0; for (let j = 0; j < sd.n; j += step) if (sd.p[j * 4 + 3] > 0) m++;
  const pos = new Uint16Array(m * 3), pk = new Uint32Array(m);
  const kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0);
  let k = 0;
  for (let j = 0; j < sd.n && k < m; j += step) {
    if (!(sd.p[j * 4 + 3] > 0)) continue;
    pos[k * 3] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4] - b.x0) * kx))); pos[k * 3 + 1] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4 + 1] - b.y0) * ky)));
    pos[k * 3 + 2] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4 + 2] - b.z0) * kz)));
    pk[k] = packSprayJS(sd.v[j * 4], sd.v[j * 4 + 1], sd.v[j * 4 + 2], Math.round(sd.v[j * 4 + 3]), sd.p[j * 4 + 3] / foamLife); k++;
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
  sim.recycle = false; sim.cap = desc.maxN; sim.opt.fastAir = !!desc.fastAir; sim.opt.sort = !!desc.sortP;
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
  onFrame(packFrameBuf(dst, n, sim.b, sampleAll(0)), { f: 0, F, n, elapsed: 0, full: false, diag: Object.assign(bakeDiag(dst, n, sim.b, desc.vmaxW), { sub: 0, blockPool: sim.scap }) });
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
    const frame = packFrameBuf(dst, n, sim.b, sampleAll(f * dtF));
    if (sim.sprayCap) { const sd = await sim.readSpray(); if (sd) { frame.sp = packSprayFrame(sd, sim.b, 200000, (desc.spr && desc.spr.ww && desc.spr.ww.foamLife) || 3); diag.sprayPoints = frame.sp.alive; } }
    if (desc.nbLook) { const dd = await sim.readDeep(); if (dd && dd.n) { frame.dp = packDeep(dd.p, dd.n, sim.b); diag.deepPoints = dd.n; } }
    onFrame(frame, { f, F, n, elapsed: (Date.now() - t0) / 1000, full: sim.N >= sim.cap, sub, diag });
    if (isCancelled()) { ok = false; break; }
    await new Promise((r) => setTimeout(r, 0));
  }
  sim.destroy();
  return ok;
}
