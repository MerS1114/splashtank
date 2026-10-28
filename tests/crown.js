// The crown of an impact over time: steps a scene from the start and saves a side-on picture every few frames, with how much water
// stands above the still surface and how high the highest water is, inside and outside a ring around the impact (a crown is water up
// high in a ring, a dome is water up in the middle). node tests/crown.js [scene "Meteor lake"] [spacing 0.03] [frames per picture 6]
// [pictures 10] [name crown] [js run in the page after the reset, e.g. "S.ballistic=false"]
const { open, wait, done } = require('./lib');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.03), CH = +(process.argv[4] || 6), NC = +(process.argv[5] || 10);
const TAG = process.argv[6] || 'crown', OV = process.argv[7] || '';
(async () => {
  const t = await open(SC, { spacing: SP });
  // side-on view, a little above the water
  await t.ev((OV) => {
    const s = window.__splash, S = s.S, sim = s.getSim(); if (OV) eval(OV);
    if (sim && sim.opt) { sim.opt.ballistic = S.ballistic; sim.opt.mg = S.mg; sim.opt.settle = S.settle; }
    const c = s.getCam(); if (c) { c.position.set(0, S.dom.h * 0.45, S.dom.d * 1.9); c.lookAt(0, S.dom.h * 0.3, 0); c.updateMatrixWorld(); if (s.cam && s.cam.target) s.cam.target.set(0, S.dom.h * 0.3, 0); }
  }, OV);
  let surf = null;
  for (let k = 0; k <= NC; k++) {
    const r = await t.ev(async (CH, k, surf) => {
      const s = window.__splash, sim = s.getSim();
      if (k > 0) for (let f = 0; f < CH; f++) { s.stepOnce(); await sim.dev.queue.onSubmittedWorkDone(); }
      const n = sim.N, b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bPos, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]);
      await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange()).slice(); b.unmap(); b.destroy();
      const h = sim.h, B = sim.b, cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2, R = 0.5 * Math.min(B.x1 - B.x0, B.z1 - B.z0);
      if (surf === null) { const y = []; for (let i = 0; i < n; i++) if (a[i * 4 + 1] > -1e5) y.push(a[i * 4 + 1]); y.sort((p, q) => p - q); surf = y[Math.floor(y.length * 0.98)]; }
      // above the surface by more than 3 cells: in the middle (r < 0.15 R), in a ring (0.15-0.6 R), further out
      const up = [0, 0, 0], top = [-1e9, -1e9, -1e9];
      for (let i = 0; i < n; i++) { const y = a[i * 4 + 1]; if (y < surf + 3 * h) continue; const r = Math.hypot(a[i * 4] - cx, a[i * 4 + 2] - cz) / R; const j = r < 0.15 ? 0 : r < 0.6 ? 1 : 2; up[j]++; top[j] = Math.max(top[j], y); }
      return { surf, f: s.S.frame, sub: s.S.lastSub, mid: up[0], ring: up[1], out: up[2], topMid: Math.round((top[0] - surf) / h), topRing: Math.round((top[1] - surf) / h) };
    }, CH, k, surf);
    surf = r.surf;
    console.log('f' + r.f + ' sub ' + r.sub + ' up: middle ' + r.mid + ' ring ' + r.ring + ' outside ' + r.out + ', highest middle ' + r.topMid + ' ring ' + r.topRing + ' cells');
    await wait(700); if (k > 0) await t.shot(TAG + '_' + String(k).padStart(2, '0'));
  }
  await done(t);
})();
