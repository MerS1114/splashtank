  // ---------- buttons ----------
  const ICO_PLAY = 'M3 1.5l9 5.5-9 5.5z', ICO_PAUSE = 'M2.5 1.5h3.4v11H2.5zM8.1 1.5h3.4v11H8.1z';
  function kfPlayIcon() { const el = document.getElementById('kf-play-ico'); if (el) el.setAttribute('d', (viewMode() === 'cache' ? S.cplay : S.playing) ? ICO_PAUSE : ICO_PLAY); }
  function setPlaying(v) {
    S.playing = v; kfPlayIcon();
    $('#btn-play').setAttribute('aria-pressed', v ? 'true' : 'false');
    $('#ico-pause').toggleAttribute('hidden', !v); $('#ico-play').toggleAttribute('hidden', v); $('#play-label').textContent = v ? 'Stop' : 'Start';
    if (typeof updStatus === 'function') try { updStatus(); } catch (e) { /* panel not ready */ }
  }
  function setCPlay(v) {
    S.cplay = v; kfPlayIcon();
    $('#ico-cpause').toggleAttribute('hidden', !v); $('#ico-cplay').toggleAttribute('hidden', v); $('#cplay-label').textContent = v ? 'Pause' : 'Play';
    $('#btn-cplay').setAttribute('aria-pressed', v ? 'true' : 'false');
  }
  $('#btn-play').addEventListener('click', () => setPlaying(!S.playing));
  $('#btn-cplay').addEventListener('click', () => { if (!S.cplay && S.cache && S.ct >= S.cache.frames.length - 1) S.ct = 0; setCPlay(!S.cplay); });
  $('#btn-crewind').addEventListener('click', () => { S.ct = 0; });
  $('#btn-reset').addEventListener('click', () => { if (tf) return; lcRestart(0); renderUI(); renderKF(); updatePlayhead(); });
  $('#scene').addEventListener('change', (e) => loadScene(e.target.value));
  $('#btn-drop').addEventListener('click', () => {
    if (S.lcPlay) lcClear();
    const x = (Math.random() - 0.5) * Math.min(0.8, S.dom.w * 0.5), z = (Math.random() - 0.5) * Math.min(0.8, S.dom.d * 0.5);
    const y = Math.max(0.6, Math.min(2.0, S.dom.h - 0.5));
    sim.fillSphere(x, y, z, 0.38, 0, -1, 0);
    S.events.push({ t: S.frame / 60, x, y, z, r: 0.38, done: true }); updateEst();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') S.shift = true;
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) {
      e.preventDefault(); if (viewMode() === 'cache') $('#btn-cplay').click(); else setPlaying(!S.playing);
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') S.shift = false; });

  // ---------- modes ----------
  function viewMode() { return S.tab === 'bake' && S.cache ? 'cache' : 'live'; }
  function applyMode() {
    const cache = viewMode() === 'cache';
    $('#tab-live').hidden = S.tab !== 'live'; $('#tab-bake').hidden = S.tab !== 'bake';
    $('#bar-live').hidden = cache; $('#bar-cache').hidden = !cache;
    $('#tl-live').hidden = false; $('#tl-cache').hidden = true; $('#kf').hidden = false;   // one timeline for both: it shows the bake when a bake is shown
    $('#ms').closest('.stat').hidden = cache; $('#meter').parentNode.hidden = cache; $('#capshow').textContent = cache ? fmtN(S.cache.maxN || 0) : fmtN(S.cap);
    if (typeof renderKF === 'function') try { renderKF(); kfPlayIcon(); } catch (e) { /* the timeline is made later at start */ }
    setSeg($('#seg-mode'), S.tab); hud();
    try { syncPtab(); } catch (e) { /* the layout code runs later at start */ }
    resize();
  }
  seg('#seg-mode', (v) => { S.tab = v; if (v === 'bake') { updateEst(); } applyMode(); });

