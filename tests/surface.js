// Surface drawing (Display > Draw water: Surface): runs a scene for a few seconds, then screenshots it as points and as a surface, and
// times a draw each way. node tests/surface.js [scene] [spacing]
const { open, wait, done } = require('./lib');
(async () => {
  const sc = process.argv[2] || 'Dam break', t = await open(sc, { spacing: +(process.argv[3] || 0.05) });
  await t.ev(() => document.querySelector('#btn-play').click()); await wait(+(process.argv[4] || 20000));
  await t.ev(() => document.querySelector('#btn-play').click()); await wait(1500);
  const time = () => t.ev(() => { const s = window.__splash, gl = s.renderer.getContext(); const t0 = performance.now(); for (let i = 0; i < 4; i++) { s.renderView(s.getCam()); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } return +((performance.now() - t0) / 4).toFixed(1); });
  const name = sc.replace(/ /g, '');
  await t.shot('surface_' + name + '_points'); const msP = await time();
  await t.ev(() => document.querySelector('#seg-surf [data-v="1"]').click()); await wait(1500);
  await t.shot('surface_' + name); const msS = await time();
  console.log('draw ms: points', msP, 'surface', msS);
  await done(t);
})();
