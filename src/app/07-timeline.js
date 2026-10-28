  // ---------- keyframes and timeline ----------
  const kfNames = $('#kf-names'), kfTracks = $('#kf-tracks');
  const FPS_TL = 24;
  function sortKeys(o) { o.keys.sort((a, c) => a.t - c.t); }
  // the channel groups an object can key (KEY_GROUPS in shared.js), as Blender's Location, Rotation and Scale; a source has Aim, Radius,
  // Speed and Emitting instead of Rotation and Scale
  const GROUP_NAME = { loc: 'Location', rot: 'Rotation', scale: 'Scale', aim: 'Aim', radius: 'Radius', speed: 'Speed', on: 'Emitting' };
  const objGroups = (o) => o.kind === 'emitter' ? ['loc', 'aim', 'radius', 'speed', 'on'] : ['loc', 'rot', 'scale'];
  // the groups a transform keys when auto keying is on, as in Blender: Move keys Location, Rotate keys Rotation (a source's Aim), Scale
  // keys Scale (a source's Radius)
  const tfGroups = (o, type) => type === 'g' ? ['loc'] : type === 'r' ? [o.kind === 'emitter' ? 'aim' : 'rot'] : [o.kind === 'emitter' ? 'radius' : 'scale'];
  function poseOf(o, groups) {
    const src = S.playing ? o.pos : o.target, k = { t: 0 };
    const val = { x: src.x, y: src.y, z: src.z, rx: o.rx || 0, yaw: o.yaw || 0, rz: o.rz || 0, sx: o.sx || 1, sy: o.sy || 1, sz: o.sz || 1, az: o.az, el: o.el, radius: o.radius, speed: o.speed, on: o.on };
    for (const g of groups) for (const c of KEY_GROUPS[g]) k[c] = val[c];
    return k;
  }
  const keyGroupsOf = (k) => Object.keys(KEY_GROUPS).filter((g) => keyHas(k, g));
  // key the given channel groups (all the object's groups if none given) at time t; a key already on that frame gets them added or updated
  function addKey(o, t, groups, quiet) {
    groups = (groups || objGroups(o)).filter((g) => objGroups(o).includes(g)); if (!groups.length) return;
    t = clamp(Math.round(t * FPS_TL) / FPS_TL, 0, S.tl.dur);
    const k = poseOf(o, groups); k.t = t;
    const ex = o.keys.find((q) => Math.abs(q.t - t) < 0.5 / FPS_TL);
    if (ex) Object.assign(ex, k, { t: ex.t }); else o.keys.push(k);
    sortKeys(o); S.selKey = { o, k: ex || k };
    if (!quiet) { renderKF(); updateEst(); lcClear(); markKeyed(); }
  }
  // Blender's auto keying (the record button): with it on, changing an object keys what changed, on the frame shown
  function autoKey(o, groups) { if (S.tl.auto && !S.playing) addKey(o, S.tl.t, groups); }
  // Alt+I: take the given groups (all if none given) off the key on the frame shown; a key left with nothing is removed
  function clearKeyAt(o, t, groups) {
    const ex = o.keys.find((q) => Math.abs(q.t - t) < 0.5 / FPS_TL); if (!ex) return false;
    for (const g of groups || Object.keys(KEY_GROUPS)) for (const c of KEY_GROUPS[g]) delete ex[c];
    if (!keyGroupsOf(ex).length) { o.keys.splice(o.keys.indexOf(ex), 1); if (S.selKey && S.selKey.k === ex) S.selKey = null; }
    renderKF(); updateEst(); lcClear(); markKeyed(); return true;
  }
  function deleteKey() {
    const sk = S.selKey; if (!sk) return;
    const i = sk.o.keys.indexOf(sk.k); if (i >= 0) sk.o.keys.splice(i, 1);
    S.selKey = null; renderKF(); updateEst(); lcClear(); markKeyed();
  }
  // fields coloured as in Blender: yellow where the group has a key on the frame shown, green where it is animated
  function markKeyed() {
    const o = selected; if (!o) return;
    const at = o.keys.find((q) => Math.abs(q.t - S.tl.t) < 0.5 / FPS_TL);
    document.querySelectorAll('#params [data-kg]').forEach((row) => {
      const g = row.dataset.kg, any = o.keys.some((k) => keyHas(k, g)), now = !!at && keyHas(at, g);
      row.classList.toggle('kf-now', now); row.classList.toggle('kf-anim', any && !now);
    });
  }
  // a shape's size at time t from its Scale keys (bake and live cache playback, which record only position and rotation)
  function sizeAt(o, t) {
    const k = o.keys.length && o.keys.some((q) => keyHas(q, 'scale')) ? keyPose(o.keys, t, S.tl.smooth) : null;
    if (k) o.group.scale.set(k.sx, k.sy, k.sz); else o.group.scale.set(o.sx || 1, o.sy || 1, o.sz || 1);
  }
  // put every keyed object where its keys say it is at time t
  function applyKeysAt(t) {
    for (const o of objs) {
      if (!o.keys.length) continue;
      poseObj(o, keyPose(o.keys, t, S.tl.smooth));
      syncMesh(o);
    }
    refreshFields(); markKeyed();
  }
  function setDur(v) {
    v = clamp(Math.round(v * 2) / 2, 1, 60); S.tl.dur = v; S.bk.dur = v;
    for (const o of objs) for (const k of o.keys) if (k.t > v) k.t = v;
    $('#kf-dur').value = v;
    const bd = $('#b-dur'); if (bd) { bd.value = v; bd.parentNode.querySelector('output').textContent = v.toFixed(1) + ' s'; }
    S.tl.t = Math.min(S.tl.t, v); renderKF(); updateEst();
  }
  // the timeline is the same in the live view and when a bake is shown; with a bake it spans the bake (or the scene, if longer) and the
  // playhead is the bake's frame
  const cacheDur = (c) => Math.max(c.partial ? c.total : c.frames.length - 1, 1) / c.fps;
  function tlSpan() { return viewMode() === 'cache' ? Math.max(S.tl.dur, cacheDur(S.cache)) : S.tl.dur; }
  function tlNow() { return viewMode() === 'cache' ? S.ct / S.cache.fps : S.tl.t; }
  const tAt = (clientX) => { const r = kfTracks.getBoundingClientRect(); return clamp((clientX - r.left) / r.width, 0, 1) * tlSpan(); };
  function renderKF() {
    kfNames.innerHTML = ''; kfTracks.innerHTML = '';
    const sp = document.createElement('div'); sp.className = 'spacer'; kfNames.appendChild(sp);
    const sp2 = document.createElement('div'); sp2.className = 'lanes'; sp2.innerHTML = '<span>Water bake</span><span>Whitewater</span><span>Live cache</span>'; kfNames.appendChild(sp2);
    const ruler = document.createElement('div'); ruler.className = 'kf-ruler'; ruler.dataset.role = 'ruler';
    const span = tlSpan(), step = span > 24 ? 5 : span > 12 ? 2 : 1;
    for (let sec = 0; sec <= span + 1e-6; sec += step) {
      const x = (sec / span) * 100;
      ruler.insertAdjacentHTML('beforeend', '<i style="left:' + x + '%"></i><span style="left:' + x + '%">' + sec + 's</span>');
    }
    kfTracks.appendChild(ruler);
    // cache lanes, coloured like Houdini's: blue cached in memory, orange out of date, purple baked, stripes baking now
    const lanes = document.createElement('div'); lanes.className = 'kf-cache'; lanes.dataset.role = 'ruler';
    lanes.dataset.tipTitle = 'Cache'; lanes.dataset.tip = 'Water bake: purple baked frames (click to play the bake), stripes baking now. Whitewater: green made by the live sim, lilac made while the water was baked, white made by Bake whitewater. Live cache: blue cached in memory, plays back without simulating; orange out of date because something changed (Reset simulates it again).';
    lanes.innerHTML = '<i id="bk-bar" data-role="bake" hidden></i><i id="bk-prog" hidden></i><i id="lc-stale" hidden></i><i id="lc-bar" hidden></i><i id="ww-lane" hidden></i>';
    kfTracks.appendChild(lanes);
    for (const o of objs) {
      const nm = document.createElement('div'); nm.textContent = o.name; nm.className = o === selected ? 'cur' : '';
      nm.addEventListener('click', () => select(o)); kfNames.appendChild(nm);
      const row = document.createElement('div'); row.className = 'kf-row' + (o === selected ? ' cur' : ''); row.dataset.role = 'row'; row.dataset.oid = o.id;
      for (const k of o.keys) {
        const d = document.createElement('div'); d.className = 'kf-key' + (o.kind === 'emitter' ? ' emitter' : '') + (S.selKey && S.selKey.k === k ? ' cur' : '');
        d.style.left = (k.t / span) * 100 + '%'; d.dataset.role = 'key'; d.title = o.name + ' at ' + k.t.toFixed(2) + ' s: ' + keyGroupsOf(k).map((g) => GROUP_NAME[g]).join(', ');
        d._o = o; d._k = k; row.appendChild(d);
      }
      kfTracks.appendChild(row);
    }
    const ph = document.createElement('div'); ph.className = 'kf-ph'; ph.id = 'kf-ph'; kfTracks.appendChild(ph);
    updatePlayhead(); if (typeof lcUi === 'function') lcUi();
  }
  let phLast = '', ptLast = '';
  function updatePlayhead() {
    const ph = $('#kf-ph'); if (!ph) return;
    const span = tlSpan(), t = tlNow(), c = viewMode() === 'cache' ? S.cache : null;
    const left = (clamp(t, 0, span) / span) * 100 + '%'; if (left !== phLast) { phLast = left; ph.style.left = left; }
    const txt = c ? (Math.round(S.ct) / c.fps).toFixed(2) + ' s · frame ' + (Math.round(S.ct) + 1) + ' / ' + (Math.round(cacheDur(c) * c.fps) + 1) + ' (bake)'
      : S.tl.t.toFixed(2) + ' s · frame ' + (Math.round(S.tl.t * FPS_TL) + 1) + ' / ' + Math.round(S.tl.dur * FPS_TL);
    if (txt !== ptLast) { ptLast = txt; $('#kf-time').textContent = txt; }
  }
  let kdrag = null, lastKeyClick = null;
  kfTracks.addEventListener('pointerdown', (e) => {
    const role = e.target.dataset.role; if (!role) return;
    if (role === 'bake') { if (S.cache) { S.tab = 'bake'; S.ct = clamp(tAt(e.clientX) * S.cache.fps, 0, S.cache.frames.length - 1); setCPlay(false); applyMode(); } return; }
    kfTracks.setPointerCapture(e.pointerId);
    if (role === 'key') {
      const k = e.target._k, o = e.target._o, now = performance.now(), dbl = lastKeyClick && lastKeyClick.k === k && now - lastKeyClick.t < 450;
      lastKeyClick = { k, t: now };
      select(o); S.selKey = { o, k };
      if (dbl) {   // double click: go to the key's frame, so moving the object there changes this key
        lastKeyClick = null; kdrag = null; scrubTo(k.t, true); renderKF(); renderUI(); flash('At ' + o.name + '\'s key, ' + k.t.toFixed(2) + ' s. Move it (G) to change the key.'); return;
      }
      kdrag = { type: 'key', k, o, moved: false }; renderKF(); return;
    }
    if (role === 'row') { const o = objs.find((q) => q.id === +e.target.dataset.oid); if (o && o !== selected) select(o); }
    kdrag = { type: 'head' }; scrubTo(tAt(e.clientX), false);
  });
  kfTracks.addEventListener('pointermove', (e) => {
    if (!kdrag) return;
    if (kdrag.type === 'head') scrubTo(tAt(e.clientX), false);
    else { kdrag.k.t = clamp(Math.round(tAt(e.clientX) * FPS_TL) / FPS_TL, 0, S.tl.dur); kdrag.moved = true; sortKeys(kdrag.o); renderKF(); }
  });
  function endKdrag() {
    if (!kdrag) return;
    if (kdrag.type === 'head') { if (viewMode() !== 'cache') scrubTo(S.tl.t, true); } else if (kdrag.moved) { const t = S.tl.t; applyKeysAt(t); updateEst(); lcClear(); }
    kdrag = null; renderUI();
  }
  kfTracks.addEventListener('pointerup', endKdrag); kfTracks.addEventListener('pointercancel', endKdrag);
  // move the playhead. final = true restarts the particles from this time.
  function scrubTo(t, final) {
    if (viewMode() === 'cache') {   // a bake is shown: move its playhead (while baking, at the newest frame it follows the bake again)
      const c = S.cache, last = Math.max(0, c.frames.length - 1);
      setCPlay(false); S.ct = clamp(Math.round(t * c.fps), 0, last); if (c.partial) S.cfollow = S.ct >= last; updatePlayhead(); return;
    }
    t = clamp(t, 0, S.tl.dur); setPlaying(false); S.tl.t = t;
    if (lcCanPlay(t)) { lcEnter(t); updatePlayhead(); return; }
    applyKeysAt(t);
    if (final) resetSim(t); else updatePlayhead();
    updatePlayhead();
  }
  $('#kf-rewind').addEventListener('click', (e) => { e.currentTarget.blur(); scrubTo(0, true); renderUI(); });
  // one frame back or forward: a bake's next frame; in the live view the next frame of the timeline (24 a second), from the live cache when it
  // has it, otherwise simulated (forward only: the simulation cannot run backwards)
  function stepFrame(dir) {
    if (tf) return;
    if (viewMode() === 'cache') {
      const c = S.cache, last = Math.max(0, c.frames.length - 1);
      setCPlay(false); S.cfollow = false; S.ct = clamp(Math.round(S.ct) + dir, 0, last); if (c.partial && S.ct >= last) S.cfollow = true; updatePlayhead(); return;
    }
    const t = (Math.round(S.tl.t * FPS_TL) + dir) / FPS_TL;
    if (t < -1e-6 || t > S.tl.dur + 1e-6) return;
    setPlaying(false);
    if (lcCanPlay(t)) { lcEnter(Math.max(0, t)); updatePlayhead(); return; }
    if (dir < 0 || S.lcPlay) { flash(dir < 0 ? 'Stepping back needs the live cache. Press Reset and play from the start to fill it.' : 'End of the cached part. Press Start to simulate on from where the sim is.'); return; }
    const target = Math.round(t * 60); let n = 0;
    while (S.frame < target && n++ < 30) stepOnce();
    S.tl.t = S.frame / 60; updatePlayhead();
  }
  $('#kf-fprev').addEventListener('click', (e) => { e.currentTarget.blur(); stepFrame(-1); });
  $('#kf-fnext').addEventListener('click', (e) => { e.currentTarget.blur(); stepFrame(1); });
  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || typing() || tf || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.activeElement !== document.body && !document.activeElement.closest('.kf, #stage')) return;
    e.preventDefault();
    if (e.shiftKey) { if (e.key === 'ArrowLeft') { scrubTo(0, true); renderUI(); } else scrubTo(viewMode() === 'cache' ? cacheDur(S.cache) : S.tl.dur, true); return; }
    stepFrame(e.key === 'ArrowLeft' ? -1 : 1);
  });
  $('#kf-add').addEventListener('click', () => { if (selected) addKey(selected, S.tl.t); });
  $('#kf-del').addEventListener('click', deleteKey);
  $('#kf-auto').addEventListener('change', (e) => { S.tl.auto = e.target.checked; });
  seg('#kf-interp', (v) => { S.tl.smooth = v === 'smooth'; applyKeysAt(S.tl.t); });
  seg('#kf-end', (v) => { S.tl.end = v; });
  $('#kf-dur').addEventListener('change', (e) => setDur(+e.target.value || 5));
  $('#kf-toggle').addEventListener('click', () => {
    const c = $('#kf').classList.toggle('collapsed'); $('#kf-toggle').style.transform = c ? 'rotate(180deg)' : ''; $('#kf-toggle').setAttribute('aria-expanded', c ? 'false' : 'true'); $('#kf-toggle').setAttribute('aria-label', c ? 'Show the key tracks' : 'Hide the key tracks');
  });
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); deleteKey(); }
  });

  // ---------- recording ----------
  function updateRecInfo() {
    let n = 0, c = 0;
    for (const o of objs) if (o.rec && o.rec.arr.length) { c++; n = Math.max(n, o.rec.start + o.rec.arr.length / 4); }
    $('#rec-info').textContent = c ? 'Recorded ' + (n / 60).toFixed(1) + ' s of motion on ' + c + ' object' + (c > 1 ? 's' : '') + '. Baking replays it.' : 'Nothing recorded. Turn this on, then drag objects while the sim runs.';
  }
  $('#rec').addEventListener('change', (e) => { S.rec = e.target.checked; });
  $('#rec-clear').addEventListener('click', () => { objs.forEach((o) => { o.rec = null; }); S.events = []; updateRecInfo(); updateEst(); });
  function recordStep() {
    for (const o of objs) {
      if (!o.rec) o.rec = { start: S.frame, arr: [] };
      const have = o.rec.start + o.rec.arr.length / 4;
      if (have < S.frame && o.rec.arr.length >= 4) {
        const a = o.rec.arr, k = a.length - 4;
        for (let s = have; s < S.frame; s++) a.push(a[k], a[k + 1], a[k + 2], a[k + 3]);
      }
      o.rec.arr.push(o.pos.x, o.pos.y, o.pos.z, o.yaw);
    }
  }

