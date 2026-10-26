// The two tests Mer runs by hand, run for her and saved to a file: the Smoothness test and the Solver benchmark (Performance tab), on one
// scene, plus a screenshot of the view as points and as a surface. Meant for a real graphics card:
//   SPLASH_GPU=1 node tests/gpu.js ["Meteor lake"] [spacing 0.03] [bake seconds 0]
// (Windows PowerShell: $env:SPLASH_GPU=1; node tests/gpu.js). With a bake length above 0 it first bakes that many seconds at Preview
// quality, so the Smoothness test also times bake playback. Writes test-output/gpu-report.txt; a few minutes, longer with a bake.
const fs = require('fs');
const { open, wait, until, done, OUT } = require('./lib');
const { REAL } = require('./browser');
const SC = process.argv[2] || 'Meteor lake', SP = +(process.argv[3] || 0.03), BAKE = +(process.argv[4] || 0);
(async () => {
  const t = await open(SC, { spacing: SP });
  const out = [];
  const say = (s) => { console.log(s); out.push(s); };
  const info = await t.ev(async () => { const a = navigator.gpu && await navigator.gpu.requestAdapter(); const i = a && (a.info || (a.requestAdapterInfo && await a.requestAdapterInfo())); return { gpu: i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') : 'no WebGPU', ua: navigator.userAgent }; });
  say('SplashTank GPU report, ' + new Date().toISOString() + (REAL ? '' : '  (software GPU: SwiftShader, not real hardware)'));
  say('Scene ' + SC + ', spacing ' + SP + '. GPU: ' + info.gpu + '. Browser: ' + info.ua);
  if (/swiftshader/i.test(info.gpu) && REAL) say('WARNING: the browser fell back to a software GPU. Numbers below are not the graphics card.');
  if (BAKE > 0) {
    await t.ev((s) => { const x = window.__splash; x.S.bk.dur = s; x.S.bkDetail = 1; x.setPtab('bake'); document.querySelector('#btn-bake').click(); }, BAKE);
    const t0 = Date.now(); await until(t, () => !window.__splash.S.baking, 3 * 3600e3, 3000);
    say('Baked ' + BAKE + ' s at Preview quality in ' + Math.round((Date.now() - t0) / 1000) + ' s.');
    await t.ev(() => { window.__splash.S.ct = 0; }); await wait(1500);
  }
  // run one of the Performance tab's tests and wait for its last line
  const run = async (name, fn) => {
    await t.ev((f) => { window.__splash.setPtab('perf'); window.__gpuDone = false; window.__splash[f]().finally(() => { window.__gpuDone = true; }); }, fn);
    await until(t, () => window.__gpuDone, 3 * 3600e3, 3000);
    say(''); say('---- ' + name + ' ----'); say(await t.ev(() => document.querySelector('#bench-out').value));
  };
  await run('Smoothness test', 'runSmooth');
  await t.ev(() => { window.__splash.S.tl.t = 0; }); await wait(1000);
  await run('Solver benchmark', 'runBenchmark');
  fs.writeFileSync(OUT + '/gpu-report.txt', out.join('\n') + '\n');
  // how it looks: a few seconds of the live sim, as points and as a surface
  await t.ev(() => { window.__splash.setPtab('display'); document.querySelector('#btn-play').click(); }); await wait(8000);
  await t.ev(() => document.querySelector('#btn-play').click()); await wait(1500); await t.shot('gpu_points');
  await t.ev(() => document.querySelector('#seg-surf [data-v="1"]').click()); await wait(1500); await t.shot('gpu_surface');
  await t.ev(() => document.querySelector('#seg-surf [data-v="0"]').click());
  say(''); say('Saved test-output/gpu-report.txt, gpu_points.png and gpu_surface.png.');
  await done(t);
})().catch((e) => { console.log('ERR', e && e.stack || e); process.exit(1); });
