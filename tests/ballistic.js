// Fast drops flying free (ballistic particles): bakes Meteor lake briefly with them on and off and compares the substeps per frame and
// the bake time, and counts the drops flying free during a live run. node tests/ballistic.js [spacing 0.08] [bake seconds 2.5]
const { open, wait, until, done } = require('./lib');
const SP = +(process.argv[2] || 0.08), SEC = +(process.argv[3] || 2.5);
(async () => {
  for (const on of [false, true]) {
    const t = await open('Meteor lake', { spacing: SP });
    await t.ev((o) => { const s = window.__splash; s.S.ballistic = o; s.getSim().opt.ballistic = o; }, on);
    // live: how many particles fly free at once
    await t.ev(() => document.querySelector('#btn-play').click());
    let most = 0, subMax = 0;
    for (let k = 0; k < 8; k++) {
      await wait(4000);
      const r = await t.ev(async () => {
        const s = window.__splash, sim = s.getSim(), n = sim.N;
        const b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bVel, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]);
        await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange()); let c = 0; for (let i = 0; i < n; i++) if (a[i * 4 + 3] >= 1.5) c++; b.unmap(); b.destroy();
        return { free: c, sub: s.S.lastSub || 1, t: s.S.tl.t };
      });
      most = Math.max(most, r.free); subMax = Math.max(subMax, r.sub);
    }
    await t.ev(() => document.querySelector('#btn-play').click()); await wait(1000);
    // bake
    await t.ev((s) => { const x = window.__splash; x.S.bk.dur = s; x.setPtab('bake'); document.querySelector('#seg-bkdetail [data-v="1"]').click(); document.querySelector('#btn-bakew').click(); }, SEC);
    const t0 = Date.now(); await until(t, () => !window.__splash.S.baking, 3600e3, 2000);
    const bk = await t.ev(() => { const c = window.__splash.S.cache; const subs = (c.diag || []).map((d) => d.sub || 1); return { frames: c.frames.length, subs: subs.reduce((a, b) => a + b, 0), subMax: Math.max(...subs), vpeak: Math.round(c.vpeak || 0), n: c.frames[c.frames.length - 1].n }; });
    console.log(JSON.stringify({ ballistic: on, liveFreeMost: most, liveSubMax: subMax, bakeSeconds: Math.round((Date.now() - t0) / 1000), bake: bk }));
    await t.shot('ballistic_' + (on ? 'on' : 'off'));
    await done(t);
  }
})();
