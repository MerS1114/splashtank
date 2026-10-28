// Whitewater, air field and dripping: runs a scene, counts the whitewater points by kind, and saves screenshots.
// Usage: node tests/ww.js [scene] [seconds] [spacing] [max whitewater]   e.g. node tests/ww.js "Meteor lake" 20 0.08
// slots: whitewater slots handed out so far (the kernels run over these); they reuse dead ones first, so they stay near the most alive at once.
const { launch, pageUrl } = require('./browser');
const { PAGE, OUT } = require('./paths');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SC = process.argv[2] || 'Meteor lake', SEC = +(process.argv[3] || 6), SPACING = +(process.argv[4] || 0), CAP = +(process.argv[5] || 0);   // CAP: Max whitewater, to test a full pool
(async () => {
  const br = await launch();
  const pg = await br.newPage(); await pg.setViewport({ width: 1440, height: 900 });
  const errs = []; pg.on('pageerror', (e) => errs.push('page: ' + e.message)); pg.on('console', (m) => { const t = m.text(); if (/error|invalid/i.test(t)) errs.push(t.slice(0, 400)); });
  await pg.goto(pageUrl(PAGE)); await wait(6000);
  await pg.select('#scene', SC); await wait(3000);
  if (SPACING) { await pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), SPACING); await wait(1500); }
  const kinds = () => pg.evaluate(async () => {
    const s = window.__splash, sim = s.getSim(), sd = await sim.readSpray(); const c = [0, 0, 0, 0]; let air = null;
    if (sd) for (let j = 0; j < sd.n; j++) if (sd.p[j * 4 + 3] > 0) c[Math.round(sd.v[j * 4 + 3])]++;
    return { frame: s.S.frame, N: sim.N, slots: sd ? sd.n : 0, spray: c[0], mist: c[1], foam: c[2], bubble: c[3], drip: sim.ndrip, air: sim.airDims && sim.airDims.n };
  });
  if (CAP) { await pg.evaluate((n) => { const s = window.__splash; s.S.sprCap = n; s.getSim().setSprayCap(n); }, CAP); await wait(500); }
  await pg.click('#btn-play');
  for (let t = 0; t < SEC; t += 2) { await wait(2000); console.log(JSON.stringify(await kinds())); }
  await pg.click('#btn-play'); await wait(500);
  await pg.screenshot({ path: OUT + '/ww_' + SC.replace(/ /g, '') + '.png' });
  await pg.select('#vh-colby', 'type'); await wait(400);
  await pg.screenshot({ path: OUT + '/ww_' + SC.replace(/ /g, '') + '_type.png' });
  console.log('errs', JSON.stringify(errs.slice(0, 6)));
  await br.close();
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
