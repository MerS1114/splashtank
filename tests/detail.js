// Detail pass (Bake > Detail): bakes the water of a scene, then bakes a region of it again finer, guided by the bake. Prints the time, the
// fine particles per frame and how much water stands above the still surface inside the region (bake against detail), and saves pictures
// of the same frame before and after. node tests/detail.js [scene "Meteor lake"] [spacing 0.06] [bake seconds 2] [detail 2] [frame to show 30]
const { open, wait, until, done } = require('./lib');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.06), SEC = +(process.argv[4] || 2), K = +(process.argv[5] || 2), FR = +(process.argv[6] || 30);
(async () => {
  const t = await open(SC, { spacing: SP });
  await t.ev((s) => { const x = window.__splash; x.S.bk.dur = s; x.setPtab('bake'); document.querySelector('#seg-bkdetail [data-v="1"]').click(); document.querySelector('#btn-bakew').click(); }, SEC);
  let t0 = Date.now(); await until(t, () => !window.__splash.S.baking, 3600e3, 1000);
  console.log('water bake: ' + Math.round((Date.now() - t0) / 1000) + ' s');
  // water above the still surface inside the region, per shown frame: a measure of the splash
  const measure = () => t.ev((fr) => {
    const x = window.__splash, c = x.S.cache, f = c.frames[fr], d = x.S.det, b = c.b;
    const r = { x0: b.x0 + (b.x1 - b.x0) * (d.cx - d.sx / 2), x1: b.x0 + (b.x1 - b.x0) * (d.cx + d.sx / 2), z0: b.z0 + (b.z1 - b.z0) * (d.cz - d.sz / 2), z1: b.z0 + (b.z1 - b.z0) * (d.cz + d.sz / 2) };
    const ys = []; const f0 = c.frames[0]; for (let i = 0; i < f0.n; i++) { const p = framePoint(f0, b, i); if (p[3] !== 255) ys.push(p[1]); } ys.sort((a, q) => a - q);
    const surf = ys[Math.floor(ys.length * 0.98)] + 3 * c.d * 2;
    let up = 0, top = -1e9, all = 0;
    for (let i = 0; i < f.n; i++) { const p = framePoint(f, b, i); if (p[3] === 255) continue; if (p[0] < r.x0 || p[0] > r.x1 || p[2] < r.z0 || p[2] > r.z1) continue; all++; if (p[1] > surf) { up++; top = Math.max(top, p[1]); } }
    return { pointsInRegion: all, aboveSurface: up, highest: +(top - surf).toFixed(3) };
  }, FR);
  const show = async (name) => { await t.ev((fr) => { const x = window.__splash; x.setCPlay(false); x.S.ct = fr; }, FR); await wait(2500); await t.shot(name); };
  console.log('bake, frame ' + FR + ': ' + JSON.stringify(await measure()));
  await show('detail_before');
  await t.ev((k) => { const x = window.__splash; x.S.det.k = k; document.querySelector('#c-det').click(); }, K);
  t0 = Date.now(); await wait(1000); await until(t, () => !window.__splash.S.detPass, 3600e3, 1000);
  const r = await t.ev(() => { const c = window.__splash.S.cache; return { status: document.querySelector('#det-status').textContent, det: c.det, frames: c.frames.length, fine: c.frames.filter((f, i) => i % 8 === 0).map((f) => f.det ? f.det.n : null) }; });
  console.log('detail pass: ' + Math.round((Date.now() - t0) / 1000) + ' s. ' + r.status);
  console.log('  fine particle slots every 8th frame: ' + JSON.stringify(r.fine));
  console.log('detail, frame ' + FR + ': ' + JSON.stringify(await measure()));
  await show('detail_after');
  await done(t);
})();
