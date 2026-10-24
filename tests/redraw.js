// While the sim plays, the live view should only redraw for new sim frames (plus camera moves and input): counts redraws against display frames.
const { open, wait, done } = require('./lib');
(async () => {
  const t = await open('Dam break', { spacing: 0.08 });
  const count = () => t.ev(() => new Promise((res) => {
    const s = window.__splash, d0 = s.perf.draws || 0, g0 = s.getSim().gen || 0; let raf = 0; const t0 = performance.now();
    const tick = () => { raf++; if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else res({ raf, draws: (s.perf.draws || 0) - d0, newFrames: (s.getSim().gen || 0) - g0 }); };
    requestAnimationFrame(tick);
  }));
  await t.ev(() => { window.__splash.resetSim(0); document.querySelector('#btn-play') ? 0 : 0; });
  await t.pg.keyboard.press('Space'); await wait(1500);
  const playing = await count();
  await t.pg.keyboard.press('Space'); await wait(500);
  const stopped = await count();
  console.log('playing', JSON.stringify(playing), 'stopped', JSON.stringify(stopped));
  const ok = playing.draws <= playing.newFrames + 12 && stopped.draws >= stopped.raf - 3;
  console.log(ok ? 'ok   redraws follow new sim frames while playing, every frame when stopped' : 'FAIL redraw counts');
  await done(t); process.exit(ok ? 0 : 1);
})();
