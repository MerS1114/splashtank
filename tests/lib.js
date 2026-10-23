// Shared start-up for the tests, so a new check is a few lines:
//   const { open, wait, done } = require('./lib');
//   (async () => { const t = await open('Dam break'); ... console.log(await t.ev(() => window.__splash.S.frame)); await done(t); })();
// open() launches headless Chromium with the software GPU, loads the built page, optionally picks a scene and a spacing,
// and collects page errors in t.errs. t.ev(fn, ...args) runs fn in the page; t.shot(name) saves test-output/name.png.
const chromium = require('@sparticuz/chromium').default; const puppeteer = require('puppeteer-core');
const { PAGE, OUT } = require('./paths');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(scene, opts) {
  opts = opts || {};
  const exe = await chromium.executablePath();
  const br = await puppeteer.launch({ executablePath: exe, args: [...chromium.args, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'], headless: 'shell' });
  const pg = await br.newPage(); await pg.setViewport({ width: opts.width || 1440, height: opts.height || 900 });
  const errs = []; pg.on('pageerror', (e) => errs.push('page: ' + e.message)); pg.on('console', (m) => { const t = m.text(); if (/error|invalid/i.test(t)) errs.push(t.slice(0, 300)); });
  await pg.goto('file://' + (opts.page || PAGE)); await wait(6000);
  if (scene) { await pg.select('#scene', scene); await wait(3000); }
  if (opts.spacing) { await pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), opts.spacing); await wait(1500); }
  return { br, pg, errs, ev: (f, ...a) => pg.evaluate(f, ...a), shot: (name) => pg.screenshot({ path: OUT + '/' + name + '.png' }) };
}
// wait until fn() (run in the page) returns something truthy, checking every `every` ms, up to `ms`
async function until(t, fn, ms, every) { const t0 = Date.now(); let v; while (Date.now() - t0 < (ms || 60000)) { v = await t.ev(fn); if (v) return v; await wait(every || 1000); } return v; }
async function done(t) { console.log('errs', JSON.stringify(t.errs.slice(0, 6))); await t.br.close(); }
module.exports = { open, until, done, wait, OUT };
