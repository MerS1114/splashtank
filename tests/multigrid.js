// Multigrid pressure (Speed-ups > Multigrid pressure): steps a scene the same number of frames with plain red-black sweeps and with
// multigrid V-cycles, and prints how far each leaves the pressure from the exact solve (relative residual over every water cell: 0 exact,
// 1 no better than no pressure), and the water's mean height. node tests/multigrid.js [scene "Dam break"] [spacing 0.05] [frames 60] [correction weight 1] [on|off: only that one] [read the residual every n frames]
const { open, done } = require('./lib');
const SC = process.argv[2] || 'Dam break', SP = +(process.argv[3] || 0.05), FR = +(process.argv[4] || 60), W = +(process.argv[5] || 1), ONLY = process.argv[6], EV = +(process.argv[7] || Math.max(1, Math.round(FR / 6)));
(async () => {
  for (const mg of ONLY ? [ONLY === 'on'] : [false, true]) {
    const t = await open(SC, { spacing: SP });
    const r = await t.ev(async (mg, FR, W, EV) => {
      const s = window.__splash, sim = s.getSim(); s.S.mg = mg; sim.opt.mg = mg; sim.opt.mgW = W;
      const out = [];
      for (let f = 1; f <= FR; f++) {
        s.stepOnce(); await sim.dev.queue.onSubmittedWorkDone();
        if (f % EV === 0) { const q = await sim.presResidual(); out.push({ f, cells: q.cells, rel: +q.rel.toFixed(4) }); }
      }
      const n = sim.N, b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bPos, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]);
      await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange()); let y = 0, c = 0; for (let i = 0; i < n; i++) if (a[i * 4 + 1] > -1e5) { y += a[i * 4 + 1]; c++; } b.unmap(); b.destroy();
      return { res: out, meanY: +(y / c).toFixed(4), n: c };
    }, mg, FR, W, EV);
    console.log(JSON.stringify({ mg, ...r }));
    await t.shot('multigrid_' + (mg ? 'on' : 'off'));
    await done(t);
  }
})();
