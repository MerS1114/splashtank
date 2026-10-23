// Quick check that the built page works: it loads without errors, the sim runs and moves water,
// the main panels and tools respond, and narrow band turns on and off. Exits with code 1 on any failure.
// Runs headless Chromium with a software GPU (SwiftShader), so it is slow but needs no graphics card.
// Usage: npm test   (or: node tests/smoke.js after building)
const chromium = require('@sparticuz/chromium').default; const puppeteer = require('puppeteer-core');
const { PAGE, OUT } = require('./paths');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, ok, info) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!ok) fails.push(name); };
(async () => {
  const exe = await chromium.executablePath();
  const br = await puppeteer.launch({ executablePath: exe, args: [...chromium.args, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'], headless: 'shell' });
  const pg = await br.newPage(); await pg.setViewport({ width: 1440, height: 900 });
  const errs = []; pg.on('pageerror', (e) => errs.push('page: ' + e.message)); pg.on('console', (m) => { const t = m.text(); if (/error|invalid/i.test(t) && !/favicon/.test(t)) errs.push('console: ' + t.slice(0, 300)); });
  await pg.goto('file://' + PAGE); await wait(6000);
  const ev = (f, ...a) => pg.evaluate(f, ...a);
  const info = await ev(() => ({ api: !!window.__splash, engine: window.__splash && window.__splash.S.engine, n: window.__splash && window.__splash.getSim().N }));
  check('page loads with its test hooks', info.api, info);
  check('starting water is there', info.n > 0, info.n);
  // run the sim for a few seconds: water should move
  await pg.click('#btn-play'); await wait(5000); await pg.click('#btn-play'); await wait(500);
  const run = await ev(() => ({ frame: window.__splash.S.frame, n: window.__splash.getSim().N, draw: window.__splash.drawCount() }));
  check('the sim steps', run.frame > 0, run);
  check('points are drawn', run.draw > 0, run.draw);
  // panels and tools
  for (const t of ['scene', 'object', 'sim', 'display']) { await pg.click('#ptabs [data-ptab=' + t + ']'); await wait(150); }
  check('properties tabs switch', await ev(() => document.querySelector('#panel').dataset.ptab === 'display'));
  await pg.click('#shelf [data-tool=move]'); await wait(200);
  check('move tool shows the gizmo when something is selected', await ev(() => { const s = window.__splash; if (!s.selSet.size) s.select(s.objs[0]); return true; }) && await ev(() => window.__splash.S.gizmo));
  await pg.click('#shelf [data-tool=select]');
  // narrow band on and off (FLIP only)
  if (info.engine === 'flip') {
    await ev(() => { window.__splash.S.nbOn = true; window.__splash.resetSim(0); }); await wait(800);
    await pg.click('#btn-play'); await wait(3000); await pg.click('#btn-play'); await wait(400);
    const on = await ev(() => window.__splash.getSim().nbOn);
    await ev(() => { window.__splash.S.nbOn = false; window.__splash.resetSim(0); }); await wait(800);
    await pg.click('#btn-play'); await wait(3000); await pg.click('#btn-play'); await wait(400);
    const off = await ev(() => window.__splash.getSim().nbOn);
    check('narrow band turns on and off', on === true && off === false, { on, off });
  } else console.log('skip narrow band (engine ' + info.engine + ', no WebGPU here)');
  await pg.screenshot({ path: OUT + '/smoke.png' });
  check('no errors on the page', errs.length === 0, errs.slice(0, 5));
  await br.close();
  console.log(fails.length ? '\n' + fails.length + ' check(s) failed' : '\nall checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed: ' + e.stack); process.exit(1); });
