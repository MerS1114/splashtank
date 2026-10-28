// Underwater blast: a sphere under the surface swells fast, holds, then collapses. Steps the scene and prints, every few frames, the
// sphere's size, how fast the water just outside the sphere moves outward (a growing collider must throw the water, not just shove it
// aside), the water above the still surface (count and highest, in cells) and the whitewater by kind, with a side-on picture each time.
// Runs each setting in turn: "flip", "apic" (Splash detail 0), "apic0.8" (Splash detail 0.8), or any number after apic.
// Another scene name (6th argument) runs that scene instead, without the sphere numbers: e.g. Meteor lake for its spray and mist.
// node tests/blast.js [apic0.8] [0.04 spacing] [6 frames a print] [10 prints] [scene]
const { open, wait, done } = require('./lib');
const SC = process.argv[6] || 'Underwater blast', RUNS = (process.argv[2] || 'apic0.8').split(','), SP = +(process.argv[3] || 0.04), CH = +(process.argv[4] || 6), NC = +(process.argv[5] || 10);
(async () => {
  const t = await open(SC, { spacing: SP });
  for (const run of RUNS) {
    await t.ev((run) => {
      const s = window.__splash, S = s.S; S.xfer = run.startsWith('apic') ? 'apic' : 'flip'; if (run.length > 4 && run.startsWith('apic')) S.apicFlip = +run.slice(4); else if (run === 'apic') S.apicFlip = 0;
      const sim = s.getSim(); if (sim && sim.opt) sim.opt.apic = S.xfer === 'apic';
      s.resetSim(0);
      const c = s.getCam(); if (c) { c.position.set(0, S.dom.h * 0.6, S.dom.d * 2.6); c.lookAt(0, S.dom.h * 0.4, 0); c.updateMatrixWorld(); if (s.cam && s.cam.target) s.cam.target.set(0, S.dom.h * 0.4, 0); }
    }, run);
    let surf = null;
    for (let k = 0; k <= NC; k++) {
      const r = await t.ev(async (CH, k, surf) => {
        const s = window.__splash, sim = s.getSim(), S = s.S;
        if (k > 0) for (let f = 0; f < CH; f++) { s.stepOnce(); await sim.dev.queue.onSubmittedWorkDone(); }
        const n = sim.N, rd = async (buf) => { const b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(buf, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange()).slice(); b.unmap(); b.destroy(); return a; };
        const a = await rd(sim.bPos), v = await rd(sim.bVel), h = sim.h;
        const o = s.objs.find((q) => q.name === 'Blast') || { pos: { x: 0, y: -1e6, z: 0 } }, rad = 0.12 * (o.sx || 1), cx = o.pos.x - S.simOrg.x, cy = o.pos.y - S.simOrg.y, cz = o.pos.z - S.simOrg.z;
        if (surf === null) { const y = []; for (let i = 0; i < n; i++) if (a[i * 4 + 1] > -1e5) y.push(a[i * 4 + 1]); y.sort((p, q) => p - q); surf = y[Math.floor(y.length * 0.98)]; }
        let up = 0, top = -1e9, shell = 0, vr = 0;
        for (let i = 0; i < n; i++) {
          const y = a[i * 4 + 1]; if (y < -1e5) continue;
          if (y > surf + 3 * h) { up++; top = Math.max(top, y); }
          const dx = a[i * 4] - cx, dy = y - cy, dz = a[i * 4 + 2] - cz, d = Math.hypot(dx, dy, dz);
          if (d > rad && d < rad + 3 * h) { shell++; vr += (v[i * 4] * dx + v[i * 4 + 1] * dy + v[i * 4 + 2] * dz) / d; }
        }
        const sd = await sim.readSpray(), c = [0, 0, 0, 0]; if (sd) for (let j = 0; j < sd.n; j++) if (sd.p[j * 4 + 3] > 0) c[Math.round(sd.v[j * 4 + 3])]++;
        return { surf, f: S.frame, sub: S.lastSub, scale: +(o.sx || 1).toFixed(2), vOut: +(shell ? vr / shell : 0).toFixed(2), up, top: up ? Math.round((top - surf) / h) : 0, spray: c[0], mist: c[1], foam: c[2], bubble: c[3] };
      }, CH, k, surf);
      surf = r.surf;
      console.log(run + ' f' + r.f + ' sub ' + r.sub + ' scale ' + r.scale + ' water outside the sphere moving out ' + r.vOut + ' m/s, above surface ' + r.up + ' (highest ' + r.top + ' cells), spray ' + r.spray + ' mist ' + r.mist + ' foam ' + r.foam + ' bubbles ' + r.bubble);
      await wait(500); if (k > 0) await t.shot((SC === 'Underwater blast' ? 'blast_' : SC.replace(/ /g, '') + '_') + run + '_' + String(k).padStart(2, '0'));
    }
  }
  if (t.errs.length) console.log('errors', JSON.stringify(t.errs.slice(0, 4)));
  await done(t);
})();
