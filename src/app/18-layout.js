  // ---------- Blender-style layout: properties tabs, menus, tool shelf, viewport header, splitters ----------
  const PTAB_NAME = { scene: 'Scene', object: 'Object', sim: 'Simulation', bake: 'Bake and cache', display: 'Display', perf: 'Performance', help: 'Hotkeys' };
  function setPtab(t, fromWs) {
    if (!PTAB_NAME[t]) t = 'sim';
    if (!fromWs && !S.baking) {
      if (t === 'bake' && S.tab !== 'bake') { S.tab = 'bake'; updateEst(); applyMode(); }
      else if ((t === 'object' || t === 'scene') && S.tab === 'bake') { S.tab = 'live'; applyMode(); }
    }
    if (t !== 'bake') layState.livePtab = t;
    layState.ptab = t; panelEl.dataset.ptab = t; lsSet('ptab', t);
    document.querySelectorAll('#ptabs [data-ptab]').forEach((bt) => bt.setAttribute('aria-pressed', bt.dataset.ptab === t ? 'true' : 'false'));
    $('#crumb-tab').textContent = PTAB_NAME[t];
  }
  function syncPtab() {   // the Bake workspace shows the bake tab; back in Live the last live tab comes back
    const changed = layState.lastTab !== S.tab; layState.lastTab = S.tab;
    if (S.tab === 'bake' && layState.ptab !== 'bake' && (changed || (layState.ptab !== 'sim' && layState.ptab !== 'display'))) setPtab('bake', true);
    else if (S.tab === 'live' && layState.ptab === 'bake') setPtab(layState.livePtab || 'sim', true);
  }
  document.querySelectorAll('#ptabs [data-ptab]').forEach((bt) => bt.addEventListener('click', () => { bt.blur(); setPtab(bt.dataset.ptab); }));
  $('#ol-tank').addEventListener('click', (e) => { e.currentTarget.blur(); setPtab('scene'); });
  setPtab(lsGet('ptab') || 'sim', true); syncPtab();

  // menus in the top bar and the viewport header
  const menuEl = $('#menu'); let menuBtn = null;
  function selectAllObj(on) { if (uiMode === 'edit') { selectAllEdit(on); return; } if (!on) { select(null); return; } objs.forEach((o) => selSet.add(o)); selected = selected || objs[0] || null; objs.forEach(syncMesh); renderUI(); hud(); }
  function invertSel() { if (uiMode === 'edit') return; const was = new Set(selSet); selSet.clear(); objs.forEach((o) => { if (!was.has(o)) selSet.add(o); }); selected = [...selSet].pop() || null; objs.forEach(syncMesh); renderUI(); hud(); }
  const MENUS = {
    file: () => [['Save scene', 'Ctrl S', () => $('#btn-save-scene').click()], ['Load scene…', '', () => $('#scene-file').click()], null,
      ['Save cache (.splc)', '', () => $('#c-save').click(), !S.cache], ['Load cache file…', '', () => $('#cache-file').click()], ['Bake report', '', () => $('#c-report').click(), !S.cache]],
    edit: () => [['Undo', 'Ctrl Z', () => undo()], ['Redo', 'Ctrl Shift Z', () => redo()], null, ['Search settings', 'F3', () => { const q = $('#psearch'); q.focus(); q.select(); }],
      ['Snapping', S.snapOn ? 'on · Shift Tab' : 'off · Shift Tab', () => setSnap(!S.snapOn)], ['Orientation: ' + (S.orient === 'local' ? 'Local' : 'Global'), '', () => setOrient(S.orient === 'local' ? 'global' : 'local')]],
    view: () => [['Frame all', 'Home', frameAll], ['Frame selected', 'F', focusSelected], null, ['Front', 'Numpad 1', () => snapView('front')], ['Right', 'Numpad 3', () => snapView('right')], ['Top', 'Numpad 7', () => snapView('top')],
      [S.ortho ? 'Perspective' : 'Orthographic', 'Numpad 5', () => setOrtho(!S.ortho)], null, [$('#kf').classList.contains('collapsed') ? 'Show key tracks' : 'Hide key tracks', '', () => $('#kf-toggle').click()], ['Reset panel sizes', '', resetLayout]],
    select: () => [['All', 'A', () => selectAllObj(true)], ['None', 'Alt A', () => selectAllObj(false)], ['Invert', '', invertSel, uiMode === 'edit']],
    object: () => [['Move', 'G', () => startTf('g'), !selSet.size && uiMode !== 'edit'], ['Rotate', 'R', () => startTf('r'), !selSet.size && uiMode !== 'edit'], ['Scale', 'S', () => startTf('s'), !selSet.size && uiMode !== 'edit'], null,
      ['Duplicate', 'Shift D', dupSelected, !selSet.size || uiMode === 'edit'], ['Delete', 'X', deleteSelected, !selSet.size || uiMode === 'edit'], null,
      [uiMode === 'edit' ? 'Back to Object Mode' : 'Edit shape', 'Tab', () => (uiMode === 'edit' ? exitEdit() : enterEdit(selected)), uiMode !== 'edit' && !(selected && selected.kind === 'mesh')],
      ['Insert keyframe', 'I', () => selSet.forEach((o) => addKey(o, S.tl.t)), !selSet.size], null,
      ['Hide selected', 'H', () => { selSet.forEach((o) => { o.hidden = true; o.group.visible = false; }); renderOutliner(); }, !selSet.size], ['Show all', 'Alt H', () => { objs.forEach((o) => { o.hidden = false; o.group.visible = true; }); renderOutliner(); }]],
    help: () => [['Hotkeys', '', () => setPtab('help')], ['Run the benchmark', '', () => setPtab('perf')]]
  };
  function closeMenu() { menuEl.hidden = true; if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false'); menuBtn = null; }
  function openMenu(bt) {
    const key = bt.dataset.menu;
    if (key === 'add') { closeMenu(); const r = bt.getBoundingClientRect(); openAddMenu(r.left, r.bottom + 2); return; }
    const items = MENUS[key](); menuEl.innerHTML = '';
    items.forEach((it) => {
      if (!it) { menuEl.appendChild(document.createElement('hr')); return; }
      const b2 = document.createElement('button'); b2.type = 'button'; b2.setAttribute('role', 'menuitem'); b2.disabled = !!it[3];
      b2.textContent = it[0]; if (it[1]) { const sp = document.createElement('span'); sp.textContent = it[1]; b2.appendChild(sp); }
      b2.addEventListener('click', () => { closeMenu(); it[2](); }); menuEl.appendChild(b2);
    });
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn = bt; bt.setAttribute('aria-expanded', 'true'); menuEl.hidden = false;
    const r = bt.getBoundingClientRect(), w = menuEl.offsetWidth;
    menuEl.style.left = clamp(r.left, 4, innerWidth - w - 4) + 'px'; menuEl.style.top = (r.bottom + 2) + 'px';
    const f = menuEl.querySelector('button:not(:disabled)'); if (f) f.focus({ preventScroll: true });
  }
  document.querySelectorAll('[data-menu]').forEach((bt) => {
    bt.addEventListener('click', () => { if (menuBtn === bt) { closeMenu(); bt.blur(); return; } openMenu(bt); });
    bt.addEventListener('mouseenter', () => { if (menuBtn && menuBtn !== bt && bt.dataset.menu !== 'add' && menuBtn.parentNode === bt.parentNode) openMenu(bt); });
  });
  menuEl.addEventListener('keydown', (e) => {
    const its = [...menuEl.querySelectorAll('button:not(:disabled)')], i = its.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (its.length) its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b2 = menuBtn; closeMenu(); if (b2) b2.focus(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu(); }, true);

  // tool shelf: the active tool decides which handles the gizmo shows (none for Select box)
  function setTool(t) {
    S.tool = t; S.gizmo = t !== 'select';
    document.querySelectorAll('#shelf [data-tool]').forEach((bt) => bt.setAttribute('aria-pressed', bt.dataset.tool === t ? 'true' : 'false'));
    const show = { g: t === 'move' || t === 'transform', r: t === 'rotate' || t === 'transform', s: t === 'scale' || t === 'transform' };
    gizmo.children.forEach((m) => { const pt = m.userData.part; if (pt) m.visible = !!show[pt.type] || (pt.type === 'g' && !pt.axis && t !== 'rotate' && t !== 'scale'); });
    const cg = $('#c-gizmo'); if (cg) cg.checked = S.gizmo;
    lsSet('tool', t);
  }
  document.querySelectorAll('#shelf [data-tool]').forEach((bt) => bt.addEventListener('click', () => { bt.blur(); setTool(bt.dataset.tool); }));
  $('#sh-water').addEventListener('click', (e) => { e.currentTarget.blur(); addAt('cube', true); });
  $('#sh-emitter').addEventListener('click', (e) => { e.currentTarget.blur(); addAt('emitter', false); });
  $('#sh-collider').addEventListener('click', (e) => { e.currentTarget.blur(); addAt('cube', false); });
  setTool(lsGet('tool') || 'select');

  // viewport header
  function setSnap(on) { S.snapOn = !!on; const b2 = $('#vh-snap'); b2.setAttribute('aria-pressed', S.snapOn ? 'true' : 'false'); if (tf) evalTf(); flash('Snapping ' + (S.snapOn ? 'on (' + $('#vh-snapto').selectedOptions[0].textContent + ')' : 'off')); }
  function setOrient(v) { S.orient = v === 'local' ? 'local' : 'global'; $('#vh-orient').value = S.orient; lsSet('orient', S.orient); if (tf) evalTf(); }
  $('#vh-snap').addEventListener('click', (e) => { e.currentTarget.blur(); setSnap(!S.snapOn); });
  $('#vh-snapto').addEventListener('change', (e) => { e.target.blur(); S.snapTo = e.target.value; lsSet('snapTo', S.snapTo); if (tf) { tf._tg = null; evalTf(); } });
  $('#vh-orient').addEventListener('change', (e) => { e.target.blur(); setOrient(e.target.value); });
  $('#vh-colby').addEventListener('change', (e) => { e.target.blur(); setColorBy(e.target.value); });
  $('#vh-mode').addEventListener('change', (e) => {
    e.target.blur();
    if (e.target.value === 'edit') { if (!(selected && selected.kind === 'mesh')) { flash('Select a grey collider or water shape first, then Tab edits its shape.'); e.target.value = 'object'; return; } enterEdit(selected); }
    else exitEdit();
  });
  $('#vh-spray').addEventListener('click', (e) => { const on = S.showSpray === false; S.showSpray = on; e.currentTarget.setAttribute('aria-pressed', String(on)); e.currentTarget.classList.toggle('on', on); e.currentTarget.blur(); lastGen = -1; });
  $('#vh-handles').addEventListener('click', (e) => { S.handles = !S.handles; e.currentTarget.setAttribute('aria-pressed', String(S.handles)); e.currentTarget.classList.toggle('on', S.handles); e.currentTarget.blur(); });
  S.snapTo = lsGet('snapTo') || S.snapTo; $('#vh-snapto').value = S.snapTo; setOrient(lsGet('orient') || 'global'); setColorBy(S.colorBy);

  // timeline header: play, next and previous key
  $('#kf-play').addEventListener('click', (e) => { e.currentTarget.blur(); if (viewMode() === 'cache') $('#btn-cplay').click(); else $('#btn-play').click(); });
  function jumpKey(dir) {
    const ts = []; (selSet.size ? [...selSet] : objs).forEach((o) => o.keys.forEach((k) => ts.push(k.t)));
    ts.sort((a, c) => a - c); const t0 = tlNow(), eps = 0.5 / FPS_TL;
    const t = dir > 0 ? ts.find((q) => q > t0 + eps) : [...ts].reverse().find((q) => q < t0 - eps);
    if (t === undefined) { flash('No ' + (dir > 0 ? 'later' : 'earlier') + ' key'); return; }
    scrubTo(t, true); renderUI();
  }
  $('#kf-prev').addEventListener('click', (e) => { e.currentTarget.blur(); jumpKey(-1); });
  $('#kf-next').addEventListener('click', (e) => { e.currentTarget.blur(); jumpKey(1); });
  window.addEventListener('keydown', (e) => { if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !typing() && !tf && document.activeElement === document.body) { e.preventDefault(); jumpKey(e.key === 'ArrowUp' ? 1 : -1); } });

  // splitters: the side panels' width, the outliner's height and the timeline's height; remembered in this browser
  const root = document.documentElement;
  const LAY_DEF = { rw: 360, oh: 190, kfh: 96 };
  function layApply() { root.style.setProperty('--rw', layState.rw + 'px'); root.style.setProperty('--oh', layState.oh + 'px'); root.style.setProperty('--kfh', layState.kfh + 'px'); }
  function laySave() { lsSet('lay', JSON.stringify({ rw: layState.rw, oh: layState.oh, kfh: layState.kfh })); }
  function resetLayout() { Object.assign(layState, LAY_DEF); layApply(); laySave(); }
  try { const v = JSON.parse(lsGet('lay') || 'null'); if (v) for (const k of ['rw', 'oh', 'kfh']) if (typeof v[k] === 'number') layState[k] = v[k]; } catch (e) { /* ignore */ }
  layApply();
  function splitter(el, key, axis, sign, lo, hi) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('on');
      const p0 = axis === 'x' ? e.clientX : e.clientY, v0 = layState[key];
      const mv = (ev) => { const d = (axis === 'x' ? ev.clientX : ev.clientY) - p0; layState[key] = clamp(Math.round(v0 + sign * d), lo(), hi()); layApply(); };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('on'); laySave(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => { layState[key] = LAY_DEF[key]; layApply(); laySave(); });
    el.addEventListener('keydown', (e) => {
      const d = (axis === 'x' ? { ArrowLeft: -16, ArrowRight: 16 } : { ArrowUp: -16, ArrowDown: 16 })[e.key]; if (!d) return;
      e.preventDefault(); layState[key] = clamp(layState[key] + sign * d, lo(), hi()); layApply(); laySave();
    });
  }
  splitter($('#sp-right'), 'rw', 'x', -1, () => 240, () => Math.max(260, Math.min(760, innerWidth - 420)));
  splitter($('#sp-out'), 'oh', 'y', 1, () => 60, () => Math.max(80, $('#rightcol').clientHeight - 140));
  splitter($('#sp-tl'), 'kfh', 'y', -1, () => 30, () => Math.max(60, $('#viewcol').clientHeight - 200));

  // the viewport's corner text, the live indicator and the simulation row of the outliner
  let vpT = 0;
  function vpInfo() {
    const ax = (camera.position.clone().sub(cam.target)).normalize();
    let view = 'User ' + (S.ortho ? 'Orthographic' : 'Perspective');
    if (S.ortho) { const n = [['Top', 0, 1, 0], ['Bottom', 0, -1, 0], ['Front', 0, 0, 1], ['Back', 0, 0, -1], ['Right', 1, 0, 0], ['Left', -1, 0, 0]].find((q) => ax.x * q[1] + ax.y * q[2] + ax.z * q[3] > 0.999); if (n) view = n[0] + ' Orthographic'; }
    $('#vp-view').textContent = view;
    const sc = $('#scene').value, fr = viewMode() === 'cache' ? Math.round(S.ct) + 1 : Math.round(S.tl.t * FPS_TL) + 1;
    $('#vp-sub').textContent = '(' + fr + ') ' + sc + (selected ? ' | ' + selected.name : '');
    const cl = $('#chip-live-t'), cache = viewMode() === 'cache';
    if (cl) cl.textContent = cache ? (S.baking ? 'Baking · ' + S.cache.frames.length + ' frames so far' : 'Bake playback') : S.lcPlay ? 'Live cache' : S.playing ? 'Live · ' + Math.round(fpsE) + ' fps' : 'Live · stopped';
    const cw = $('#chip-ww-t');
    if (cw) {   // where the whitewater shown comes from
      let t = 'Whitewater off', col = '#666';
      if (S.wwPass) { t = 'Baking whitewater ' + Math.round(100 * (S.wwProg || 0)) + '%'; col = '#f2f2f2'; }
      else if (cache) { const f = S.cache && S.cache.frames[Math.round(S.ct)], k = f ? f.wws || 0 : 0; t = k === 2 ? 'Whitewater: baked' : k === 1 ? 'Whitewater: cached' : 'No whitewater'; col = k === 2 ? '#f2f2f2' : k === 1 ? '#b48df0' : '#666'; }
      else if (S.sprOn) { t = S.lcPlay ? 'Whitewater: live (cached)' : 'Whitewater: live'; col = '#6fd36f'; }
      cw.textContent = t; $('#chip-ww').style.setProperty('--wwc', col);
    }
    const ss = $('#ol-sim-sub'); if (ss) ss.textContent = (isGpu() ? fmtN(sim ? sim.N : 0) : fmtN(sim ? sim.N : 0)) + ' particles' + (S.engine === 'flip' && nbActive() ? ' · narrow band' : '');
    const vm = $('#vh-mode'); if (vm && document.activeElement !== vm) vm.value = uiMode;
  }
  window.__splash = { renderView, compMat, setCPlay, gpuKept, BAKE, setTool, setSnap, setOrient, setColorBy, setPtab, renderOutliner, setHidden, layState, bakeRes, buildDesc, LC, filterPanel, drawCount: () => shownN, slots: SLOTS, perf, rawBuf, geoW, geoD, geoS, pmat, matS, slotLoad, showSlots, packCpuFrame, renderer, scene, gizmo, pickGizmo, snapView, setOrtho, tfLines, snapMark, getCam: () => camera, select, get tfState() { return tf; }, lc: () => ({ frames: LC.frames.length, end: lcEnd(), armed: LC.armed, play: S.lcPlay, t: S.lcT, bytes: LC.bytes, full: LC.full }), lcRestart, stepOnce, runBenchmark, runSmooth, getSim: () => sim, cam, b, setFaceCoord, commitBox, FACES, sceneData, applySceneData, S, objs, addKey, resetSim, setDomain, selSet, select, startTf, confirmTf, cancelTf, enterEdit, exitEdit, extrudeFaces, ES, undo, redo, addAt, setSelMode, lastM, get tf() { return tf; }, get uiMode() { return uiMode; }, editPick, toScreen, makeObj, selVerts, selectAllEdit, modalKey, evalTf };
  initGpu().then((g) => {
    S.gpu = g; applyPreset(g ? 'flip' : 'cpu');
    buildLiveUI(); buildBakeUI(); makeSim(); $('#capshow').textContent = fmtN(S.cap);
    loadScene('Wave tank'); applyMode(); setPlaying(false); lcUi(); updStatus();
    requestAnimationFrame(frame);
  });
