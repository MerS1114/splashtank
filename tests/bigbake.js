// A big narrow band bake from a saved scene file: the starting water must reach across the whole tank and the ocean must stay up.
// Bakes the scene at its own bake detail and prints, every few frames, the points, the points the bake allowed itself (it raises Max
// points so the starting water fits), how far the water reaches across x and z, the water's mean height and the deep water points.
// node tests/bigbake.js scene.json [live spacing 0.024] [bake seconds 0.75] [Max points, default the scene's] [frames a print 3]
const { open, wait, until, done } = require('./lib');
const fs = require('fs');
const SCN = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const SP = +(process.argv[3] || 0.024), SEC = +(process.argv[4] || 0.75), CAP = +(process.argv[5] || 0), EVERY = +(process.argv[6] || 3);
(async () => {
  const t = await open('Meteor lake', { spacing: SP });
  await t.ev((d) => window.__splash.applySceneData(d), SCN); await wait(2000);
  await t.pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), SP); await wait(2000);
  if (CAP) await t.ev((c) => { window.__splash.S.cap = c; }, CAP);
  const r0 = await t.ev((sec) => { const x = window.__splash; x.S.bk.dur = sec; const r = x.bakeRes(); return { d: r.d, maxN: r.maxN, limit: Math.floor(x.S.gpu.dev.limits.maxStorageBufferBindingSize / 48) }; }, SEC);
  console.log('bake spacing ' + r0.d + ', Max points ' + r0.maxN + ', most points one buffer holds with APIC ' + r0.limit);
  const t0 = Date.now();
  await t.ev(() => { const x = window.__splash; x.setPtab('bake'); document.querySelector('#btn-bakew').click(); });
  await wait(3000); await until(t, () => !window.__splash.S.baking, 3600e3, 3000);
  const r = await t.ev((EVERY) => {
    const x = window.__splash, c = x.S.cache;
    const st = document.querySelector('#bake-status');
    return { status: st ? st.textContent : '', cap: c.pointCap, rows: (c.diag || []).filter((d, i) => i % EVERY === 0).map((d) => ({ f: d.f, n: d.n, need: d.startNeed, x: d.bbox ? [+d.bbox[0].toFixed(2), +d.bbox[3].toFixed(2)] : null, z: d.bbox ? [+d.bbox[2].toFixed(2), +d.bbox[5].toFixed(2)] : null, meanY: d.center ? +d.center[1].toFixed(3) : null, deep: d.deepPoints })) };
  }, EVERY);
  console.log('bake took ' + Math.round((Date.now() - t0) / 1000) + ' s; ' + r.status);
  for (const w of r.rows) console.log(JSON.stringify(w));
  await t.ev(() => window.__splash.setCPlay(false)); await wait(500);
  await t.pg.keyboard.down('Shift'); await t.pg.keyboard.press('ArrowRight'); await t.pg.keyboard.up('Shift'); await wait(3000);
  await t.shot('bigbake_last');
  await done(t);
})();
