// The page's side of comparing it with the native program (native/): bakes a scene file at a live spacing for some seconds and writes
// the bake's per-frame measurements (cache.diag: water centre, speeds, height histogram, substeps) and its time to a JSON file, which
// native/tools/compare.js sets against a native bake of the same scene.
// node tests/native-compare.js scene.json [live spacing 0.02] [seconds 1] [out test-output/native/page.json] [full]
// full: the whole bake with whitewater (the Bake button); wwpass: Bake water, then Bake whitewater over it (r.ww: whitewater points a frame);
// detail: Bake water, then Detail with its default region (r.det: fine points a frame, their centre and top);
// otherwise Bake water, the water only
const { open, wait, until, done } = require('./lib');
const fs = require('fs'), path = require('path');
const SCN = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const SP = +(process.argv[3] || 0.02), SEC = +(process.argv[4] || 1), OUT = process.argv[5] || 'test-output/native/page.json', FULL = process.argv[6] === 'full', WWPASS = process.argv[6] === 'wwpass', DETAIL = process.argv[6] === 'detail';
(async () => {
  const t = await open('Dam break', { spacing: SP });
  await t.ev((d) => window.__splash.applySceneData(d), SCN); await wait(2000);
  await t.pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), SP); await wait(2000);
  const r0 = await t.ev((sec) => { const x = window.__splash; x.S.bk.dur = sec; const r = x.bakeRes(); return { d: r.d, maxN: r.maxN, gpu: x.S.gpu && x.S.gpu.name }; }, SEC);
  console.log('page bake: spacing ' + r0.d + ', Max points ' + r0.maxN + ', GPU ' + r0.gpu);
  const t0 = Date.now();
  await t.ev((full) => { const x = window.__splash; x.setPtab('bake'); document.querySelector(full ? '#btn-bake' : '#btn-bakew').click(); }, FULL);
  await wait(1000); await until(t, () => !window.__splash.S.baking, 3600e3, 1000);
  if (WWPASS) { await t.ev(() => document.querySelector('#c-ww').click()); await wait(1000); await until(t, () => !window.__splash.S.wwPass, 3600e3, 1000); }
  if (DETAIL) { await t.ev(() => document.querySelector('#c-det').click()); await wait(1000); await until(t, () => !window.__splash.S.detPass, 3600e3, 1000); }
  const wall = (Date.now() - t0) / 1000;
  const r = await t.ev(() => { const c = window.__splash.S.cache; return { seconds: c.seconds, b: c.b, d: c.d, diag: c.diag, ww: c.frames.map((f) => (f.sp ? f.sp.alive || f.sp.n : 0)),
    det: c.det ? c.frames.map((f) => { let n = 0, sy = 0, top = -1e9; const d = f.det || { n0: 0, n: 0 }; for (let i = d.n0; i < d.n0 + d.n; i++) { const p = framePoint(f, c.b, i); if (p[3] === 255) continue; n++; sy += p[1]; top = Math.max(top, p[1]); } return { n, y: sy / Math.max(n, 1), top }; }) : null }; });
  r.wall = wall; r.spacing = SP;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(r));
  console.log('baked ' + (r.diag.length - 1) + ' frames in ' + r.seconds.toFixed(1) + ' s (wall ' + wall.toFixed(1) + ' s); wrote ' + OUT);
  await done(t);
})();
