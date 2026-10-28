// Bake > Accuracy: bakes the same scene with Normal and Accurate and prints, for each, the time, the substeps and pressure iterations per
// frame, the pressure left unsolved (Accurate measures it every frame) and the GPU's limits, with a picture of the same frame.
// node tests/accbake.js [scene "Meteor lake"] [spacing 0.04] [bake seconds 1.5] [frame to show 30]
const { open, until, wait, done } = require('./lib');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.04), SEC = +(process.argv[4] || 1.5), FR = +(process.argv[5] || 30);
(async () => {
  for (const mode of ['normal', 'accurate']) {
    const t = await open(SC, { spacing: SP });
    if (mode === 'normal') console.log('GPU limits: ' + JSON.stringify(await t.ev(() => { const d = window.__splash.getSim().dev.limits; return { storageBuffers: d.maxStorageBuffersPerShaderStage, bindingMB: Math.round(d.maxStorageBufferBindingSize / 1048576), apicKernel: window.__splash.getSim().pipes.g2pAo ? 'g2pAo (9 buffers)' : 'g2pA (8)' }; })));
    await t.ev((s, mode) => { const x = window.__splash; x.S.bk.dur = s; x.S.bkAcc = mode; x.setPtab('bake'); document.querySelector('#seg-bkdetail [data-v="1"]').click(); document.querySelector('#btn-bakew').click(); }, SEC, mode);
    const t0 = Date.now(); await wait(2000); await until(t, () => !window.__splash.S.baking, 3600e3, 1000);
    const r = await t.ev(() => { const c = window.__splash.S.cache, d = c.diag || []; const pick = (k) => d.map((q) => q[k]).filter((v) => v !== undefined && v !== null);
      const sub = pick('sub'), it = pick('iters'), un = pick('unsolved');
      return { frames: c.frames.length, sub: sub.length ? Math.max(...sub) + ' most, ' + (sub.reduce((a, b) => a + b, 0) / sub.length).toFixed(1) + ' mean' : '-', iters: it.length ? Math.min(...it) + '-' + Math.max(...it) : '-', unsolved: un.length ? (100 * Math.max(...un)).toFixed(2) + '% most, ' + (100 * un.reduce((a, b) => a + b, 0) / un.length).toFixed(2) + '% mean' : 'not measured' }; });
    console.log(mode + ': ' + Math.round((Date.now() - t0) / 1000) + ' s for ' + r.frames + ' frames; substeps ' + r.sub + '; pressure iterations ' + r.iters + '; unsolved ' + r.unsolved);
    await t.ev((fr) => { const x = window.__splash; x.setCPlay(false); x.S.ct = fr; }, FR); await wait(2500); await t.shot('accbake_' + mode);
    await done(t);
  }
})();
