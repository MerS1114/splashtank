// Whitewater, air field and dripping: runs a scene, counts the whitewater points by kind, and saves screenshots.
// Usage: node tests/ww.js [scene] [seconds] [spacing]   e.g. node tests/ww.js "Meteor lake" 20 0.08
const chromium = require('@sparticuz/chromium').default; const puppeteer = require('puppeteer-core');
const { PAGE, OUT } = require('./paths');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SC = process.argv[2] || 'Meteor lake', SEC = +(process.argv[3] || 6), SPACING = +(process.argv[4] || 0);
(async () => {
  const exe = await chromium.executablePath();
  const br = await puppeteer.launch({ executablePath: exe, args: [...chromium.args, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'], headless: 'shell' });
  const pg = await br.newPage(); await pg.setViewport({ width: 1440, height: 900 });
  const errs = []; pg.on('pageerror', (e) => errs.push('page: ' + e.message)); pg.on('console', (m) => { const t = m.text(); if (/error|invalid/i.test(t)) errs.push(t.slice(0, 400)); });
  await pg.goto('file://' + PAGE); await wait(6000);
  await pg.select('#scene', SC); await wait(3000);
  if (SPACING) { await pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), SPACING); await wait(1500); }
  const kinds = () => pg.evaluate(async () => {
    const s = window.__splash, sim = s.getSim(), sd = await sim.readSpray(); const c = [0, 0, 0, 0]; let air = null;
    if (sd) for (let j = 0; j < sd.n; j++) if (sd.p[j * 4 + 3] > 0) c[Math.round(sd.v[j * 4 + 3])]++;
    return { frame: s.S.frame, N: sim.N, spray: c[0], mist: c[1], foam: c[2], bubble: c[3], drip: sim.ndrip, air: sim.airDims && sim.airDims.n };
  });
  await pg.click('#btn-play');
  for (let t = 0; t < SEC; t += 2) { await wait(2000); console.log(JSON.stringify(await kinds())); }
  await pg.click('#btn-play'); await wait(500);
  await pg.screenshot({ path: OUT + '/ww_' + SC.replace(/ /g, '') + '.png' });
  await pg.select('#vh-colby', 'type'); await wait(400);
  await pg.screenshot({ path: OUT + '/ww_' + SC.replace(/ /g, '') + '_type.png' });
  console.log('errs', JSON.stringify(errs.slice(0, 6)));
  await br.close();
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
