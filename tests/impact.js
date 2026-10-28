// How hard an impact splashes, with the pressure speed-ups on and off: steps a scene through its impact (the same frames each time) and
// prints, every few frames, the pressure left unsolved, the share of water cells left out as settled, how much water stands above the
// still surface and how high the highest water is. Water that gives under an impact instead of being pushed aside shows as less water up.
// node tests/impact.js [scene "Meteor lake"] [spacing 0.03] [frames 72] [runs "settle,plain,mg,settle+mg"; add +noball for fast drops
// staying on the grid]. Runs differ by a third or so from run to run (the GPU adds particles in a different order each time).
const { open, done } = require('./lib');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.03), FR = +(process.argv[4] || 72);
const RUNS = (process.argv[5] || 'settle,plain,mg,settle+mg').split(',');
(async () => {
  for (const run of RUNS) {
    const t = await open(SC, { spacing: SP });
    const r = await t.ev(async (run, FR) => {
      const s = window.__splash, sim = s.getSim();
      const settle = run.includes('settle'), mg = run.includes('mg');
      s.S.settle = settle; s.S.mg = mg; sim.opt.settle = settle; sim.opt.mg = mg;
      if (run.includes('noball')) { s.S.ballistic = false; sim.opt.ballistic = false; }
      const ys = async () => {
        const n = sim.N, b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bPos, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]);
        await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange()); const y = []; for (let i = 0; i < n; i++) if (a[i * 4 + 1] > -1e5) y.push(a[i * 4 + 1]); b.unmap(); b.destroy(); return y;
      };
      const y0 = (await ys()).sort((p, q) => p - q); const surf = y0[Math.floor(y0.length * 0.98)], hh = sim.h || 0.03;
      const out = []; let peakUp = 0, peakTop = -1e9;
      for (let f = 1; f <= FR; f++) {
        s.stepOnce(); await sim.dev.queue.onSubmittedWorkDone();
        if (f % 6 === 0) {
          const y = await ys(); let up = 0, top = -1e9; for (const v of y) { if (v > surf + 3 * hh) up++; if (v > top) top = v; }
          const q = sim.presResidual ? await sim.presResidual() : { rel: NaN };
          peakUp = Math.max(peakUp, up); peakTop = Math.max(peakTop, top);
          out.push('f' + f + ' unsolved ' + (100 * q.rel).toFixed(1) + '% settled ' + (sim.stats && sim.stats.fluid ? Math.round(100 * sim.stats.settled / sim.stats.fluid) : 0) + '% up ' + up + ' top ' + ((top - surf) / hh).toFixed(0));
        }
      }
      return { lines: out, peakUp, peakTopCells: +((peakTop - surf) / hh).toFixed(0), n: y0.length };
    }, run, FR);
    console.log('== ' + run + ' (' + r.n + ' particles): most water above the surface ' + r.peakUp + ' particles, highest ' + r.peakTopCells + ' cells up');
    for (const l of r.lines) console.log('  ' + l);
    await t.shot('impact_' + run.replace('+', '_'));
    await done(t);
  }
})();
