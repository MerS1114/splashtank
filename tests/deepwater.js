// A saved scene file stepped in chunks, with a picture after each: water cells (the volume), particles, and the surface height far from
// the middle (median of the highest water per column, in cells above the ocean level). For narrow band water lost or gained under impacts.
// node tests/deepwater.js scene.json [spacing 0.04] [frames per chunk 12] [chunks 5] [picture name] [js run in the page after the reset]
const { open, wait, done } = require('./lib');
const fs = require('fs');
const SCN = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const SP = +(process.argv[3] || 0.04), CH = +(process.argv[4] || 12), NC = +(process.argv[5] || 5), TAG = process.argv[6] || 'deepwater', OV = process.argv[7] || '';
(async () => {
  const t = await open('Meteor lake', { spacing: SP });
  await t.ev((d) => window.__splash.applySceneData(d), SCN); await wait(2000);
  await t.pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), SP); await wait(2000);
  await t.pg.waitForFunction(() => { const s = window.__splash; return s && s.getSim() && s.getSim().ready !== false; }, { timeout: 180000 });
  await t.ev(async (OV) => { const s = window.__splash; s.resetSim(); await new Promise((q) => setTimeout(q, 500)); if (OV) eval(OV); }, OV);
  for (let c = 1; c <= NC; c++) {
    const r = await t.ev(async (CH) => {
      const s = window.__splash, sim = s.getSim();
      for (let f = 0; f < CH; f++) { s.stepOnce(); await sim.dev.queue.onSubmittedWorkDone(); }
      await new Promise((q) => setTimeout(q, 300));
      const n = sim.N, b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bPos, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]);
      await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange());
      // the highest water in each column of cells, away from the meteor: the surface height far out
      const B = sim.b, h = sim.h, nx = Math.ceil((B.x1 - B.x0) / h), nz = Math.ceil((B.z1 - B.z0) / h), top = new Float32Array(nx * nz).fill(-1e9); let alive = 0;
      for (let i = 0; i < n; i++) { const y = a[i * 4 + 1]; if (y < -1e5) continue; alive++; const ix = Math.floor((a[i * 4] - B.x0) / h), iz = Math.floor((a[i * 4 + 2] - B.z0) / h); if (ix >= 0 && iz >= 0 && ix < nx && iz < nz) top[ix * nz + iz] = Math.max(top[ix * nz + iz], y); }
      b.unmap(); b.destroy();
      const far = []; for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) { const x = B.x0 + (ix + 0.5) * h, z = B.z0 + (iz + 0.5) * h; if (Math.hypot(x - (B.x0 + B.x1) / 2, z - (B.z0 + B.z1) / 2) > 0.3 * Math.min(B.x1 - B.x0, B.z1 - B.z0) && top[ix * nz + iz] > -1e8) far.push(top[ix * nz + iz]); }
      far.sort((p, q) => p - q);
      const lvl = s.S.ocean.level * s.S.dom.h + s.S.min.y;
      return { f: s.S.frame, sub: s.S.lastSub, fluid: sim.stats && sim.stats.fluid, alive, N: n, farSurf: far.length ? +((far[far.length >> 1] - lvl) / h).toFixed(1) : null };
    }, CH);
    console.log(JSON.stringify(r));
    await wait(800); await t.shot(TAG + '_' + c);
  }
  await done(t);
})();
