// Buried water and playback quality: bakes Dam break briefly (compact frames), counts the points marked buried (markInterior), and
// compares the picture with them skipped and drawn (should be the same) and how long a draw takes each way. About 3 min.
const { open, wait, until, done } = require('./lib');
(async () => {
  const t = await open('Dam break', { spacing: 0.05 });
  await t.ev(() => { const s = window.__splash; s.S.bk.dur = 0.5; s.S.bkDetail = 1; s.setPtab('bake'); document.querySelector('#btn-bakew').click(); });
  await until(t, () => !window.__splash.S.baking, 600000, 2000); await wait(1500);
  console.log(JSON.stringify(await t.ev(() => { const c = window.__splash.S.cache; return { frames: c.frames.length, compact: !!c.frames[0].p32, n: c.frames.map((f) => f.n).filter((_, i) => i % 4 === 0), hidden: c.frames.map((f) => f.hid || 0).filter((_, i) => i % 4 === 0) }; })));
  await t.ev(() => { const s = window.__splash; document.querySelector('#seg-cspeed [data-v="1"]').click(); s.S.ct = 6; });
  await t.ev(() => { const s = window.__splash; s.S.cplay = false; s.S.ct = 6; }); await wait(1500);
  // draw the same frame both ways in the page and compare the pixels (readPixels also waits for the draw to finish)
  console.log(JSON.stringify(await t.ev(() => {
    const s = window.__splash, r = s.renderer, gl = r.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = (hide) => { s.pmat.uniforms.uHide.value = hide; const px = new Uint8Array(w * h * 4); const t0 = performance.now(); for (let i = 0; i < 5; i++) { r.render(s.scene, s.getCam()); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } const ms = (performance.now() - t0) / 5; r.render(s.scene, s.getCam()); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return { px, ms }; };
    grab(0); grab(1); const A = grab(1), B = grab(0); let diff = 0; const C = grab(1); A.ms = Math.min(A.ms, C.ms);
    for (let i = 0; i < A.px.length; i += 4) if (Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2]) > 30) diff++;
    return { drawMsSkipped: +A.ms.toFixed(1), drawMsAll: +B.ms.toFixed(1), pixelsDiffer: diff, of: w * h };
  })));
  await t.ev(() => { window.__splash.S.hideIn = true; }); await wait(800); await t.shot('hidden_on');
  await done(t);
})();
