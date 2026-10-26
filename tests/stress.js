// Heavier, longer runs for a real graphics card: several scenes and spacings in turn, each in a fresh browser, each with a bake.
//   SPLASH_GPU=1 node tests/stress.js            (Windows PowerShell: $env:SPLASH_GPU = "1"; npm run stress)
//   node tests/stress.js quick                    a short version of the same cases (for checking the script itself)
// For each case: bake (the given seconds and quality), then the Smoothness test (20 s live from the start, then 10 s of the bake), bake
// playback drawn as a surface, and the Solver benchmark. Writes test-output/stress-report.txt (a summary first, then every case in full)
// and a screenshot per case. Takes about an hour on a fast card; the densest cases may hit the GPU's memory, which the report says.
const fs = require('fs');
const { open, wait, until, done, OUT } = require('./lib');
const { REAL } = require('./browser');
const QUICK = process.argv[2] === 'quick';
// scene, spacing, bake seconds, bake quality (1 Preview = the spacing, 1.5 Final, 2 Fine)
const CASES = QUICK ? [['Dam break', 0.08, 1, 1]] : [
  ['Meteor lake', 0.03, 6, 1.5],     // the usual scene, a Final bake: about 3x the points of the live view
  ['Meteor lake', 0.02, 6, 1],       // denser live view and a Preview bake at 0.02
  ['Meteor lake', 0.015, 4, 1],      // densest narrow band case
  ['Dam break', 0.025, 4, 1],        // full depth (no narrow band): every point simulated and drawn
];
const summary = [], full = [];
const say = (s) => { console.log(s); full.push(s); };
(async () => {
  say('SplashTank stress report, ' + new Date().toISOString() + (REAL ? '' : '  (software GPU: SwiftShader, not real hardware)'));
  for (const [sc, sp, bakeS, q] of CASES) {
    const name = sc + ' ' + sp + ', bake ' + bakeS + ' s at ' + (q === 1 ? 'Preview' : q === 1.5 ? 'Final' : 'Fine');
    say(''); say('======== ' + name + ' ========');
    let t;
    try {
      t = await open(sc, { spacing: sp });
      await t.ev(() => { window.__smoothSecs = 20; });
      if (full.length < 4) {
        const info = await t.ev(async () => { const a = navigator.gpu && await navigator.gpu.requestAdapter(); const i = a && (a.info || (a.requestAdapterInfo && await a.requestAdapterInfo())); return { gpu: i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') : 'no WebGPU', ua: navigator.userAgent }; });
        say('GPU: ' + info.gpu + '. Browser: ' + info.ua);
        if (/swiftshader/i.test(info.gpu) && REAL) say('WARNING: the browser fell back to a software GPU. Numbers below are not the graphics card.');
      }
      // bake
      await t.ev((s, qq) => { const x = window.__splash; x.S.bk.dur = s; x.S.bkDetail = qq; x.setPtab('bake'); document.querySelector('#btn-bake').click(); }, bakeS, q);
      const t0 = Date.now(); await until(t, () => !window.__splash.S.baking, 4 * 3600e3, 3000);
      const bk = await t.ev(() => { const c = window.__splash.S.cache; if (!c) return null; let w = 0, sp = 0; for (const f of c.frames) { w = Math.max(w, f.n); sp = Math.max(sp, f.sp ? f.sp.n : 0); } return { frames: c.frames.length, maxN: w, ww: sp, mb: Math.round(c.frames.reduce((a, f) => a + (f.p32 ? f.p32.byteLength + f.sf.byteLength : f.pos.byteLength + f.spd.byteLength), 0) / 1048576), d: c.d, status: document.querySelector('#bake-status').textContent }; });
      const bakeSec = Math.round((Date.now() - t0) / 1000);
      say('Bake: ' + (bk ? bk.frames + ' frames in ' + bakeSec + ' s (' + (bakeSec / Math.max(1, bk.frames - 1)).toFixed(1) + ' s a frame), up to ' + bk.maxN + ' water points and ' + bk.ww + ' whitewater shown, spacing ' + bk.d.toFixed(4) + ', about ' + bk.mb + ' MB of water. ' + bk.status : 'nothing baked'));
      await t.ev(() => { window.__splash.S.ct = 0; }); await wait(1500);
      // the Performance tab's tests
      const run = async (label, fn) => {
        await t.ev((f) => { window.__splash.setPtab('perf'); window.__gpuDone = false; window.__splash[f]().finally(() => { window.__gpuDone = true; }); }, fn);
        await until(t, () => window.__gpuDone, 4 * 3600e3, 3000);
        const txt = await t.ev(() => document.querySelector('#bench-out').value);
        say(''); say('---- ' + label + ' ----'); say(txt); return txt;
      };
      const sm = await run('Smoothness test', 'runSmooth');
      // bake playback with the water drawn as a surface
      const surf = await t.ev(async () => {
        const x = window.__splash; if (!x.S.cache) return null;
        x.S.tab = 'bake'; x.S.surface = true; x.S.ct = 0; x.setCPlay(true);
        await new Promise((r) => setTimeout(r, 2000));
        const d0 = x.perf.draws || 0, t0 = performance.now(); await new Promise((r) => setTimeout(r, 10000));
        const fps = ((x.perf.draws || 0) - d0) / ((performance.now() - t0) / 1000);
        x.setCPlay(false); return { fps: +fps.toFixed(1) };
      });
      say(''); say('Bake playback drawn as a surface: ' + (surf ? surf.fps + ' frames a second' : 'no bake'));
      await wait(1000); await t.shot('stress_' + sc.replace(/ /g, '') + '_' + String(sp).replace('.', '') + '_surface');
      await t.ev(() => { window.__splash.S.surface = false; }); await wait(800);
      await t.shot('stress_' + sc.replace(/ /g, '') + '_' + String(sp).replace('.', '') + '_points');
      await t.ev(() => { window.__splash.S.tl.t = 0; }); await wait(1000);
      const bm = await run('Solver benchmark', 'runBenchmark');
      // one line per case for the summary
      const m = (re, txt) => { const r = txt.match(re); return r ? r[1] : '?'; };
      summary.push(name + ': live ' + m(/\((\d+)% of real time\)/, sm) + '% of real time with ' + m(/real time\)\. (\S+) particles/, sm) + ' particles, GPU busy ' + m(/GPU was busy ([\d.]+) ms/, sm) + ' ms a step; bake ' + (bk ? (bakeSec / Math.max(1, bk.frames - 1)).toFixed(1) + ' s a frame, ' + bk.maxN + ' points' : 'none') +
        '; playback ' + m(/Bake playback[^\n]*\n\s+([\d.]+) frames a second/, sm) + ' frames a second as points, ' + (surf ? surf.fps : '?') + ' as a surface; benchmark GPU busy ' + m(/A\. reference[^\n]*\n[^\n]*GPU busy ([\d.]+) ms/, bm) + ' ms a step.');
    } catch (e) { say('This case failed: ' + (e && e.stack || e)); summary.push(name + ': failed (' + (e && e.message || e) + ')'); }
    if (t) { full.push('errors on the page: ' + JSON.stringify(t.errs.slice(0, 6))); await done(t); }
    fs.writeFileSync(OUT + '/stress-report.txt', ['SUMMARY', ...summary, '', ...full].join('\n') + '\n');
  }
  console.log('\nSUMMARY\n' + summary.join('\n'));
  console.log('\nSaved test-output/stress-report.txt and stress_*.png.');
})().catch((e) => { console.log('ERR', e && e.stack || e); process.exit(1); });
