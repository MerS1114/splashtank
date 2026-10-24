// Whitewater pass over a bake: bakes Meteor lake coarsely (about 3 min), runs Make whitewater, prints whitewater per frame before and after and saves screenshots.
const { open, wait, until, done } = require('./lib');
(async () => {
  const t = await open('Meteor lake', { spacing: 0.08 });
  await t.ev(() => { const s = window.__splash; s.S.nbLook = true; s.setPtab('bake'); document.querySelector('#btn-bake').click(); });
  await wait(200000); await t.ev(() => document.querySelector('#btn-cancel').click());
  await until(t, () => !window.__splash.S.baking, 120000, 2000);
  const sp = () => t.ev(() => window.__splash.S.cache.frames.map((f) => (f.sp ? f.sp.alive : 0)));
  const before = await sp(); console.log('frames', before.length, 'whitewater before', JSON.stringify(before.filter((_, i) => i % 6 === 0)));
  await t.ev(() => { window.__splash.S.ct = 36; }); await wait(1500); await t.shot('wwpass_before');
  const t0 = Date.now();
  await t.ev(() => document.querySelector('#c-ww').click());
  await until(t, () => !window.__splash.S.wwPass, 1500000, 3000);
  console.log('pass took', ((Date.now() - t0) / 1000).toFixed(0), 's:', await t.ev(() => document.querySelector('#ww-status').textContent));
  const after = await sp(); console.log('whitewater after ', JSON.stringify(after.filter((_, i) => i % 6 === 0)));
  console.log('kinds at 36', JSON.stringify(await t.ev(() => { const f = window.__splash.S.cache.frames[36]; const c = [0, 0, 0, 0]; if (f.sp) for (let i = 0; i < f.sp.n; i++) c[(f.sp.pk[i] >>> 29) & 3]++; return { spray: c[0], foam: c[1], mist: c[2], bubble: c[3] }; })));
  await t.ev(() => { window.__splash.S.ct = 36.0; }); await wait(1500); await t.shot('wwpass_after');
  await done(t);
})();
