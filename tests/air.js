// The air field (Air field > Real air flow): steps Meteor lake and reads the air grid. Prints, every few frames, the air velocity just
// below and beside the falling meteor (air pushed out ahead of it: down below, sideways beside), the meteor's own velocity, how far the
// air is from incompressible (mean |divergence| x cell / mean speed, over cells that are not water or objects), the mean and fastest air,
// and how much spray is above the lake. Runs with Real air flow on and off. node tests/air.js [scene] [spacing 0.04] [frames 40] [runs "on,off"]
const { open, done } = require('./lib');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.04), FR = +(process.argv[4] || 40), RUNS = (process.argv[5] || 'on,off').split(',');
(async () => {
  for (const run of RUNS) {
    const t = await open(SC, { spacing: SP });
    const r = await t.ev(async (run, FR) => {
      const s = window.__splash, S = s.S; S.airReal = run === 'on'; S.airFeel = run === 'on'; s.resetSim(0); await new Promise((q) => setTimeout(q, 300));
      const sim = s.getSim(), met = s.objs.find((o) => o.kind === 'sphere' || o.shape === 'sphere') || s.objs[0];
      const readAir = async () => { const ad = sim.airDims; if (!ad) return null; const n = ad.n, b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bAir, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange()).slice(); b.unmap(); b.destroy(); return { a, ad }; };
      const B = sim.b, out = []; let prev = null;
      for (let f = 1; f <= FR; f++) {
        s.stepOnce(); await sim.dev.queue.onSubmittedWorkDone();
        const mp = { x: met.pos.x - S.org.x, y: met.pos.y - S.org.y, z: met.pos.z - S.org.z };
        const mv = prev ? { x: (mp.x - prev.x) * 60, y: (mp.y - prev.y) * 60, z: (mp.z - prev.z) * 60 } : { x: 0, y: 0, z: 0 }; prev = mp;
        if (f % 4) continue;
        const A = await readAir(); if (!A) { out.push('f' + f + ' no air grid'); continue; }
        const { a, ad } = A, h = ad.h, idx = (i, j, k) => Math.max(0, Math.min(ad.nx - 1, i)) + ad.nx * (Math.max(0, Math.min(ad.ny - 1, j)) + ad.ny * Math.max(0, Math.min(ad.nz - 1, k)));
        const at = (x, y, z) => { const c = idx(Math.floor((x - B.x0) / h), Math.floor((y - B.y0) / h), Math.floor((z - B.z0) / h)) * 4; return [a[c], a[c + 1], a[c + 2], a[c + 3]]; };
        const R = (met.mesh && met.mesh.v) ? Math.max(...met.mesh.v.map((q) => Math.hypot(q[0], q[1], q[2]))) : 0.35;
        const below = at(mp.x, mp.y - 1.6 * R, mp.z), side = at(mp.x + 1.6 * R, mp.y, mp.z);
        let dv = 0, sp = 0, m = 0, top = 0;
        for (let k = 1; k < ad.nz - 1; k++) for (let j = 1; j < ad.ny - 1; j++) for (let i = 1; i < ad.nx - 1; i++) {
          const c = idx(i, j, k) * 4; if (a[c + 3] > 0.5) continue;
          const d = (a[idx(i + 1, j, k) * 4] - a[idx(i - 1, j, k) * 4] + a[idx(i, j + 1, k) * 4 + 1] - a[idx(i, j - 1, k) * 4 + 1] + a[idx(i, j, k + 1) * 4 + 2] - a[idx(i, j, k - 1) * 4 + 2]) / 2;
          const v = Math.hypot(a[c], a[c + 1], a[c + 2]); dv += Math.abs(d); sp += v; m++; top = Math.max(top, v);
        }
        const sc = S.scale || 1, f2 = (v) => (v * sc).toFixed(1);
        out.push('f' + f + ' meteor v (' + f2(mv.x) + ',' + f2(mv.y) + ',' + f2(mv.z) + ') m/s; air below (' + f2(below[0]) + ',' + f2(below[1]) + ',' + f2(below[2]) + ') beside (' + f2(side[0]) + ',' + f2(side[1]) + ',' + f2(side[2]) + '); off incompressible ' + (sp > 0 ? (dv / sp).toFixed(3) : '-') + '; air mean ' + f2(sp / Math.max(m, 1)) + ' fastest ' + f2(top) + ' m/s');
      }
      return out;
    }, run, FR);
    console.log('== Real air flow ' + run); for (const l of r) console.log('  ' + l);
    await t.shot('air_' + run); await done(t);
  }
})();
