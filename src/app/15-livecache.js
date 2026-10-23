  // ---------- live cache ----------
  // While the sim runs from the start with nothing changed, the frames the live view shows are kept in memory (8 bytes a point).
  // Reset, Rewind and scrubbing play them back; at the end of the cache the sim carries on from where it really is.
  // Any change to the scene clears it, and it starts again the next time the sim runs from the beginning.
  const LC = { frames: [], fnum: [], ids: [], bytes: 0, armed: false, full: false, parked: 0, b: null, org: null, d: 0, staleEnd: 0 };
  function lcDrop() { LC.frames = []; LC.fnum = []; LC.bytes = 0; LC.full = false; if (typeof lcUi === 'function') lcUi(); }
  function lcClear() {
    if (!LC.frames.length && !LC.armed && !S.lcPlay) return;
    if (LC.frames.length > 1) LC.staleEnd = Math.max(LC.staleEnd || 0, lcEnd());   // shown orange on the timeline until it is simulated again
    const wasPlay = S.lcPlay;
    lcDrop(); LC.armed = false; lcUi();
    if (wasPlay) { S.lcPlay = false; applyKeysAt(S.tl.t); resetSim(S.tl.t); }
  }
  function lcEnd() { return LC.fnum.length ? LC.fnum[LC.fnum.length - 1] : -1; }
  function lcCanPlay(t) { return S.lcOn && LC.frames.length > 1 && t * 60 <= lcEnd() && viewMode() === 'live'; }
  function lcEnter(t) {
    if (!S.lcPlay) { LC.parked = S.frame; S.lcPlay = true; LC.armed = false; }
    S.lcT = t * 60; S.tl.t = t;
  }
  function lcRestart(t) { if (lcCanPlay(t)) lcEnter(t); else resetSim(t); }
  function lcExit() {
    S.lcPlay = false; lastGen = -1;
    if (LC.parked - lcEnd() > 6) { setPlaying(false); flash('End of the cached part (cache memory full). Start carries on from ' + (LC.parked / 60).toFixed(1) + ' s.'); }
    S.tl.t = LC.parked / 60; applyKeysAt(S.tl.t);
    LC.armed = !LC.full;
  }
  function lcRecord(fr) {
    if (!fr || !LC.armed || S.lcPlay || !S.playing || !isGpu()) return;
    const f = S.frame, last = lcEnd();
    if (!LC.frames.length && f > 8) { LC.armed = false; return; }   // it did not start at the beginning
    if (f - last < 2 || f < last) return;                              // about 30 frames a second is enough
    if (LC.bytes > S.lcBudget * 1048576) { LC.full = true; LC.armed = false; lcUi(); return; }
    if (!LC.frames.length) { LC.ids = objs.map((o) => o.id); LC.b = Object.assign({}, sim.b); LC.org = Object.assign({}, S.simOrg); LC.d = S.liveD; LC.scale = S.scale || 1; }
    const rec = Object.assign({}, fr, { objs: packObjs(S.lastStates || []) });   // the frame as it was drawn: nothing to pack
    LC.frames.push(rec); LC.fnum.push(f); LC.bytes += frameBytes(rec);
    if (LC.staleEnd && lcEnd() >= LC.staleEnd) LC.staleEnd = 0;
    lcUi();
  }
  function lcShow() {
    const fn = LC.fnum; let lo = 0, hi = fn.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (fn[m] <= S.lcT) lo = m; else hi = m - 1; }
    const A = LC.frames[lo], cb = LC.b, og = LC.org;
    const sl = SLOTS[0], key = 'lc:' + lo + ':' + LC.fnum[lo] + ':' + (S.showSpray !== false);
    if (sl.key !== key) { slotLoad(sl, A, cb); sl.key = key; }
    pmat.uniforms.uD.value = LC.d; pmat.uniforms.uCR.value = S.cellRatio;
    showSlots(0, 0, 0); lastGen = -1;
    const n = sl.alive;
    LC.ids.forEach((id, k) => {
      const o = objs.find((q) => q.id === id); if (!o) return;
      const ob = A.objs, k6 = k * 6;
      o.group.position.set(ob[k6] + og.x, ob[k6 + 1] + og.y, ob[k6 + 2] + og.z);
      if (o.kind === 'mesh') o.group.rotation.set(ob[k6 + 3], ob[k6 + 4], ob[k6 + 5], 'ZYX');
    });
    return n;
  }
  function lcUi() {
    const el = $('#lc-info');
    if (el) {
      if (!S.lcOn) el.textContent = 'Off.';
      else if (LC.frames.length > 1) el.textContent = 'Cached 0 to ' + (lcEnd() / 60).toFixed(1) + ' s (' + Math.round(LC.bytes / 1048576) + ' MB)' + (LC.full ? ', memory full' : '') + '. Reset, Rewind or the timeline play it back without simulating; changing anything clears it.';
      else if (LC.staleEnd > 0) el.textContent = 'Out of date: something changed. Press Reset to simulate and cache it again.';
      else el.textContent = LC.armed ? 'Recording from the start as the sim runs.' : 'Empty. It records the next time the sim runs from the beginning (press Reset).';
    }
    const dur = tlSpan() || 1, pc = (s) => clamp(s / dur, 0, 1) * 100;
    const bar = $('#lc-bar'), stl = $('#lc-stale'), bk = $('#bk-bar'), bp = $('#bk-prog');
    const on = S.lcOn && LC.frames.length > 1, endS = on ? lcEnd() / 60 : 0, se = S.lcOn ? LC.staleEnd / 60 : 0;
    if (bar) { bar.hidden = !on; if (on) bar.style.width = pc(endS) + '%'; }
    if (stl) { const show = se > endS + 1e-3; stl.hidden = !show; if (show) { stl.style.left = pc(endS) + '%'; stl.style.width = (pc(se) - pc(endS)) + '%'; } }
    if (bk) { const c = S.cache, show = !!c && !S.baking; bk.hidden = !show; if (show) bk.style.width = pc((c.frames.length - 1) / c.fps) + '%'; }
    if (bp) { bp.hidden = !S.baking; if (S.baking) bp.style.width = pc(S.bakeT || 0) + '%'; }
    const sr = $('#st-right');
    if (sr) {
      let t = '';
      if (S.baking) t = 'Baking ' + Math.round(pc(S.bakeT || 0)) + '%';
      else if (S.lcPlay) t = 'Playing the live cache';
      else if (on) t = 'Cached 0–' + endS.toFixed(1) + ' s · ' + Math.round(LC.bytes / 1048576) + ' MB' + (LC.full ? ' (memory full)' : '');
      else if (se > 0) t = '<span class="stale">Cache out of date · Reset to simulate again</span>';
      else if (S.lcOn && LC.armed && isGpu()) t = 'Caching from the start';
      const eng = S.engine === 'flip' ? 'FLIP' : S.engine === 'gpu' ? 'PBF GPU' : 'PBF CPU', g = S.gpu ? ' · ' + String(S.gpu.name).replace(/[<>&]/g, '') : '';
      const s = (t ? t + ' · ' : '') + eng + g; if (sr._s !== s) { sr._s = s; sr.innerHTML = s; }
    }
  }
  // anything changed in the objects, box or solver panels clears the cache (the cache's own controls are marked data-keep)
  ['#g-objects', '#g-box', '#g-sim'].forEach((sel) => {
    const g = $(sel); if (!g) return;
    const hit = (e) => { if (!e.target.closest('[data-keep]')) lcClear(); };
    g.addEventListener('input', hit); g.addEventListener('change', hit);
    g.addEventListener('click', (e) => { if (e.target.closest('.seg button')) hit(e); });
  });
  $('#kf-interp').addEventListener('click', () => lcClear());

