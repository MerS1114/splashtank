// The timeline with a bake shown and in the live view: frame stepping (buttons and arrow keys), scrubbing, play, and the smoothness test.
// Usage: node tests/timeline.js
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
  const st = () => pg.evaluate(() => { const s = window.__splash; return { tab: s.S.tab, frame: s.S.frame, tlt: +s.S.tl.t.toFixed(3), ct: +s.S.ct.toFixed(2), cplay: s.S.cplay, playing: s.S.playing, lcPlay: s.S.lcPlay, kf: !document.querySelector('#kf').hidden, oldBar: !document.querySelector('#tl-cache').hidden, time: document.querySelector('#kf-time').textContent, hud: document.querySelector('#hud').textContent.slice(0, 90) }; });
  // live: one frame forward simulates, one back without a cache says so
  await pg.click('#kf-fnext'); await wait(2500);
  console.log('live step forward', JSON.stringify(await st()));
  await pg.click('#kf-fprev'); await wait(300);
  console.log('live step back (no cache yet)', JSON.stringify(await st()));
  // a short bake, shown on the normal timeline
  await pg.click('#seg-mode button[data-v=bake]'); await wait(200);
  await pg.evaluate(() => { const i = document.querySelector('#b-dur'); i.value = 1; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
  await pg.click('#btn-bake'); const t0 = Date.now();
  while (Date.now() - t0 < 400000) { await wait(3000); const t = await pg.evaluate(() => document.querySelector('#bake-status').textContent); if (/Baked|failed|ancel/.test(t)) { console.log('bake', t); break; } }
  await wait(500);
  console.log('bake shown', JSON.stringify(await st()));
  await pg.click('#kf-play'); await wait(300);   // pause
  await pg.evaluate(() => { window.__splash.S.ct = 5; }); await wait(200);
  await pg.keyboard.press('ArrowRight'); await wait(150); const a = await st();
  await pg.keyboard.press('ArrowRight'); await wait(150); const b = await st();
  await pg.keyboard.press('ArrowLeft'); await wait(150); const c = await st();
  console.log('arrows from 5', a.ct, b.ct, c.ct, 'paused', !c.cplay);
  await pg.click('#kf-fnext'); await wait(150); console.log('button forward', (await st()).ct);
  await pg.click('#kf-fprev'); await pg.click('#kf-fprev'); await wait(150); console.log('button back twice', (await st()).ct);
  // click the ruler at three quarters of the way
  const r = await pg.evaluate(() => { const e = document.querySelector('#kf-tracks .kf-ruler').getBoundingClientRect(); return { x: e.left + e.width * 0.75, y: e.top + e.height / 2 }; });
  await pg.mouse.click(r.x, r.y); await wait(200);
  console.log('ruler click at 3/4', JSON.stringify(await st()));
  await pg.keyboard.down('Shift'); await pg.keyboard.press('ArrowLeft'); await pg.keyboard.up('Shift'); await wait(150); console.log('shift+left', (await st()).ct);
  await pg.screenshot({ path: OUT + '/timeline_bake.png' });
  // the smoothness test, short
  await pg.evaluate(() => { window.__smoothSecs = 3; }); await pg.click('#ptabs [data-ptab=perf]'); await wait(200);
  await pg.click('#btn-smooth'); await wait(1000);
  for (let k = 0; k < 60; k++) { await wait(2000); const v = await pg.evaluate(() => document.querySelector('#bench-out').value); if (/Done|failed/.test(v)) { console.log(v); break; } }
  console.log('after test', JSON.stringify(await st()));
  console.log('errs', JSON.stringify(errs.slice(0, 6)));
  await br.close();
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
