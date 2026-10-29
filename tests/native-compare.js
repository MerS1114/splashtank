// The page's side of comparing it with the native program (native/): bakes a scene file at a live spacing for some seconds and writes
// the bake's per-frame measurements (cache.diag: water centre, speeds, height histogram, substeps) and its time to a JSON file, which
// native/tools/compare.js sets against a native bake of the same scene.
// node tests/native-compare.js scene.json [live spacing 0.02] [seconds 1] [out test-output/native/page.json]
const { open, wait, until, done } = require('./lib');
const fs = require('fs'), path = require('path');
const SCN = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const SP = +(process.argv[3] || 0.02), SEC = +(process.argv[4] || 1), OUT = process.argv[5] || 'test-output/native/page.json';
(async () => {
  const t = await open('Dam break', { spacing: SP });
  await t.ev((d) => window.__splash.applySceneData(d), SCN); await wait(2000);
  await t.pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), SP); await wait(2000);
  const r0 = await t.ev((sec) => { const x = window.__splash; x.S.bk.dur = sec; const r = x.bakeRes(); return { d: r.d, maxN: r.maxN, gpu: x.S.gpu && x.S.gpu.name }; }, SEC);
  console.log('page bake: spacing ' + r0.d + ', Max points ' + r0.maxN + ', GPU ' + r0.gpu);
  const t0 = Date.now();
  await t.ev(() => { const x = window.__splash; x.setPtab('bake'); document.querySelector('#btn-bakew').click(); });
  await wait(1000); await until(t, () => !window.__splash.S.baking, 3600e3, 1000);
  const wall = (Date.now() - t0) / 1000;
  const r = await t.ev(() => { const c = window.__splash.S.cache; return { seconds: c.seconds, b: c.b, d: c.d, diag: c.diag }; });
  r.wall = wall; r.spacing = SP;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(r));
  console.log('baked ' + (r.diag.length - 1) + ' frames in ' + r.seconds.toFixed(1) + ' s (wall ' + wall.toFixed(1) + ' s); wrote ' + OUT);
  await done(t);
})();
