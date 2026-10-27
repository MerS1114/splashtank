// Settled water left out of the pressure solve (Speed-ups > Settled water skips pressure): bakes a scene with it on and off (the same
// steps either way) and prints the water points per frame, the share of water cells left out, and the bake time; screenshots of the last
// frame. node tests/settle.js [scene "Meteor lake"] [spacing 0.06] [bake seconds 2] [tolerance, default the app's]
const { open, wait, until, done } = require('./lib');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.06), SEC = +(process.argv[4] || 2), TOL = process.argv[5] ? +process.argv[5] : 0;
(async () => {
  for (const on of [true, false]) {
    const t = await open(SC, { spacing: SP });
    await t.ev((o, tol) => { const s = window.__splash; s.S.settle = o; s.getSim().opt.settle = o; if (tol) s.S.settleTol = tol; }, on, TOL);
    await t.ev((s) => { const x = window.__splash; x.S.bk.dur = s; x.setPtab('bake'); document.querySelector('#seg-bkdetail [data-v="1"]').click(); document.querySelector('#btn-bakew').click(); }, SEC);
    const t0 = Date.now(); await until(t, () => !window.__splash.S.baking, 3600e3, 2000);
    const r = await t.ev(() => { const c = window.__splash.S.cache; return { n: c.frames.filter((f, i) => i % 6 === 0).map((f) => f.n), settled: (c.diag || []).filter((d, i) => i % 6 === 0).map((d) => d.fluidCells ? Math.round(100 * (d.settled || 0) / d.fluidCells) : null) }; });
    console.log(JSON.stringify({ settle: on, seconds: Math.round((Date.now() - t0) / 1000), ...r }));
    await t.ev(() => window.__splash.setCPlay(false)); await wait(500);
    await t.pg.keyboard.down('Shift'); await t.pg.keyboard.press('ArrowRight'); await t.pg.keyboard.up('Shift'); await wait(3000);
    await t.shot('settle_' + (on ? 'on' : 'off'));
    await done(t);
  }
})();
