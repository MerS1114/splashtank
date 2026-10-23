// The bake shows in the viewport while it runs, and a cancelled bake keeps the frames it finished.
const chromium = require('@sparticuz/chromium').default; const puppeteer = require('puppeteer-core');
const { PAGE, OUT } = require('./paths');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const exe = await chromium.executablePath();
  const br = await puppeteer.launch({ executablePath: exe, args: [...chromium.args, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'], headless: 'shell' });
  const pg = await br.newPage(); await pg.setViewport({ width: 1440, height: 900 });
  const errs = []; pg.on('pageerror', (e) => errs.push('page: ' + e.message)); pg.on('console', (m) => { const t = m.text(); if (/error|invalid/i.test(t)) errs.push(t.slice(0, 300)); });
  await pg.goto('file://' + PAGE); await wait(6000);
  await pg.select('#scene', 'Dam break'); await wait(2500);
  await pg.click('#seg-mode button[data-v=bake]'); await wait(300);
  await pg.evaluate(() => { const s = document.querySelector('#b-dur'); s.value = 3; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await pg.click('#btn-bake');
  const st = () => pg.evaluate(() => { const s = window.__splash, c = s.S.cache; return { baking: s.S.baking, frames: c ? c.frames.length : 0, partial: c && c.partial, ct: +s.S.ct.toFixed(2), draw: s.drawCount(), status: document.querySelector('#bake-status').textContent.slice(0, 120) }; });
  for (let k = 0; k < 4; k++) { await wait(6000); console.log('during', JSON.stringify(await st())); }
  await pg.screenshot({ path: OUT + '/bake_during.png' });
  await pg.click('#btn-cancel');
  for (let k = 0; k < 30; k++) { await wait(2000); if (!(await pg.evaluate(() => window.__splash.S.baking))) break; }
  console.log('after cancel', JSON.stringify(await st()));
  await pg.evaluate(() => { window.__splash.S.ct = 2; }); await wait(800);
  await pg.screenshot({ path: OUT + '/bake_cancelled.png' });
  console.log('errs', JSON.stringify(errs.slice(0, 5)));
  await br.close();
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
