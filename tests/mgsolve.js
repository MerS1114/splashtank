// Pressure solve alone, the same problem for every method: runs a scene to a moment, then from zero pressure solves that step's
// pressure again with red-black sweeps (several counts) and with multigrid V-cycles (several counts and correction weights), and prints
// the relative residual each leaves (0 exact). node tests/mgsolve.js [scene "Meteor lake"] [spacing 0.05] [frames 30]
const { open, done } = require('./lib');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.05), FR = +(process.argv[4] || 30);
(async () => {
  const t = await open(SC, { spacing: SP });
  const r = await t.ev(async (FR) => {
    const s = window.__splash, sim = s.getSim(); sim.opt.mg = false; s.S.mg = false;
    for (let f = 0; f < FR; f++) { s.stepOnce(); await sim.dev.queue.onSubmittedWorkDone(); }
    // every water cell into the lists (the last step left settled ones out)
    sim.pf32[417] = 0; sim.dev.queue.writeBuffer(sim.bParams, 0, sim.pu);
    { const enc = sim.dev.createCommandEncoder(), ps = enc.beginComputePass(), P = sim.pipes;
      const run = (nm, f) => { ps.setPipeline(P[nm].pipeline); ps.setBindGroup(0, P[nm].bg); f(); };
      run('settleMark', () => ps.dispatchWorkgroupsIndirect(sim.bArgs, 64)); run('listClear', () => ps.dispatchWorkgroups(1)); run('buildList', () => ps.dispatchWorkgroupsIndirect(sim.bArgs, 64)); run('listArgs', () => ps.dispatchWorkgroups(1));
      ps.end(); sim.dev.queue.submit([enc.finish()]); await sim.dev.queue.onSubmittedWorkDone(); }
    sim.mgTop = sim.mgPlan(); sim.mgDense.forEach((q, k) => sim.pu32.set(q, 424 + 4 * k));
    const om = sim.omega(), out = [{ stats: sim.stats, N: sim.N, top: sim.mgTop, dense: sim.mgDense }];
    const solve = async (mg, iters, w, omega) => {
      sim.opt.mg = mg; sim.opt.mgW = w; sim.pf32[15] = omega; sim.pf32[420] = w;
      sim.dev.queue.writeBuffer(sim.bParams, 0, sim.pu);
      const enc = sim.dev.createCommandEncoder(); enc.clearBuffer(sim.bPres);
      const ps = enc.beginComputePass(); const st = sim.stages(sim.N, iters).find((x) => x.name === 'pressure'); st.fn(ps); ps.end();
      sim.dev.queue.submit([enc.finish()]); await sim.dev.queue.onSubmittedWorkDone();
      const q = await sim.presResidual(); out.push({ mg, iters, w, omega: +omega.toFixed(2), rel: +q.rel.toFixed(5), cells: q.cells });
    };
    for (const it of [30, 60, 120, 240]) await solve(false, it, 1, om);
    for (const it of [30]) await solve(false, it, 1, 1);
    for (const pre of [2, 4]) for (const omg of [1, 1.4, 1.7]) for (const it of [10, 30]) { sim.opt.mgPre = pre; await solve(true, it, 1, omg); out[out.length - 1].pre = pre; }
    return out;
  }, FR);
  for (const x of r) console.log(JSON.stringify(x));
  await done(t);
})();
