// Surface drawing (Display > Draw water: Surface): runs a scene for a while, then screenshots it as points and as a surface in several
// variants, to tell which part of the surface drawing is at fault when it looks wrong, and times a draw each way.
//   node tests/surface.js [scene "Dam break"] [spacing 0.05] [ms to run 20000]
// Pictures in test-output: surface_<scene>_points, _surface (as drawn by default: older smoothing with Surface shapes), _round (Surface shapes
// off), _nrf (the narrow-range filter, shapes on), _depth (the default's smoothed depth as stripes: should be smooth curves), _normals (the
// default's normals: should change smoothly, not speckle).
const { open, wait, done } = require('./lib');
(async () => {
  const sc = process.argv[2] || 'Dam break', t = await open(sc, { spacing: +(process.argv[3] || 0.05) });
  await t.ev(() => document.querySelector('#btn-play').click()); await wait(+(process.argv[4] || 20000));
  await t.ev(() => document.querySelector('#btn-play').click()); await wait(1500);
  const time = () => t.ev(() => { const s = window.__splash, gl = s.renderer.getContext(); const t0 = performance.now(); for (let i = 0; i < 4; i++) { s.renderView(s.getCam()); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } return +((performance.now() - t0) / 4).toFixed(1); });
  const name = 'surface_' + sc.replace(/ /g, '');
  console.log(JSON.stringify(await t.ev(() => { const gl = window.__splash.renderer.getContext(); return { dpr: devicePixelRatio, buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], floatTargets: !!gl.getExtension('EXT_color_buffer_float') }; })));
  await t.shot(name + '_points'); const msP = await time();
  await t.ev(() => document.querySelector('#seg-surf [data-v="1"]').click()); await wait(1500);
  await t.shot(name + '_surface'); const msS = await time();
  const variant = async (suffix, fn) => { await t.ev(fn); await wait(1200); await t.shot(name + '_' + suffix); };
  await variant('round', () => { window.__splash.S.surfAniso = false; });
  await variant('nrf', () => { const s = window.__splash; s.S.surfAniso = true; s.S.surfNrf = true; });
  await variant('depth', () => { const s = window.__splash; s.S.surfNrf = false; s.compMat.uniforms.uDbg.value = 1; });
  await variant('normals', () => { window.__splash.compMat.uniforms.uDbg.value = 2; });
  await t.ev(() => { window.__splash.compMat.uniforms.uDbg.value = 0; });
  console.log('draw ms: points', msP, 'surface', msS);
  await done(t);
})();
