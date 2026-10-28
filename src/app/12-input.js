  // ---------- add menu ----------
  const addMenu = $('#addmenu');
  function openAddMenu(x, y) {
    if (viewMode() === 'cache' || uiMode !== 'object') return;
    addMenu.hidden = false;
    const w = addMenu.offsetWidth, hh = addMenu.offsetHeight;
    addMenu.style.left = clamp(x, 4, innerWidth - w - 4) + 'px'; addMenu.style.top = clamp(y, 4, innerHeight - hh - 4) + 'px';
    const f = addMenu.querySelector('button'); if (f) f.focus({ preventScroll: true });
  }
  function closeAddMenu() { if (addMenu.contains(document.activeElement)) document.activeElement.blur(); addMenu.hidden = true; }
  addMenu.addEventListener('click', (e) => { const bt = e.target.closest('button'); if (!bt) return; closeAddMenu(); if (bt.dataset.v === 'blob') $('#btn-drop').click(); else addAt(bt.dataset.v, !!bt.dataset.water); });
  addMenu.addEventListener('keydown', (e) => {
    const its = [...addMenu.querySelectorAll('button')], i = its.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAddMenu(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!addMenu.hidden && !addMenu.contains(e.target) && !e.target.closest('#btn-add')) closeAddMenu(); }, true);

  // ---------- keyboard ----------
  function typing() { const a = document.activeElement; return a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !/^(range|checkbox)$/.test(a.type))); }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control') lastM.ctrl = true;
    if (typing() || S.baking) return;
    const k = e.key, K = k.toLowerCase();
    if (tf) { modalKey(e); return; }
    if (!addMenu.hidden && k === 'Escape') { closeAddMenu(); return; }
    // view keys work everywhere, including the cache view
    if (e.code === 'Numpad1') { e.preventDefault(); snapView(e.ctrlKey ? 'back' : 'front'); return; }
    if (e.code === 'Numpad3') { e.preventDefault(); snapView(e.ctrlKey ? 'left' : 'right'); return; }
    if (e.code === 'Numpad7') { e.preventDefault(); snapView(e.ctrlKey ? 'bottom' : 'top'); return; }
    if (e.code === 'Numpad5') { e.preventDefault(); setOrtho(!S.ortho); return; }
    if (e.code === 'NumpadDecimal' || (K === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey)) { e.preventDefault(); focusSelected(); return; }
    if (k === 'Home') { e.preventDefault(); frameAll(); return; }
    if (viewMode() === 'cache') return;
    if ((e.ctrlKey || e.metaKey) && K === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && K === 'y') { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey) return;
    if (k === 'Tab' && e.shiftKey) { e.preventDefault(); setSnap(!S.snapOn); return; }
    if (k === 'Tab') { e.preventDefault(); if (uiMode === 'edit') exitEdit(); else enterEdit(selected); return; }
    if (K === 'g' || K === 'r' || K === 's') { e.preventDefault(); startTf(K); return; }
    if (K === 'a' && e.shiftKey && uiMode === 'object') { e.preventDefault(); openAddMenu(lastM.x, lastM.y); return; }
    if (K === 'a') {
      e.preventDefault();
      if (uiMode === 'edit') selectAllEdit(!e.altKey);
      else { if (e.altKey) { select(null); } else { objs.forEach((o) => selSet.add(o)); selected = selected || objs[0] || null; objs.forEach(syncMesh); renderUI(); hud(); } }
      return;
    }
    if (K === 'd' && e.shiftKey) { e.preventDefault(); dupSelected(); return; }
    if (uiMode === 'edit') {
      if (K === 'e') { e.preventDefault(); extrudeFaces(); return; }
      if (K === 'i') { e.preventDefault(); insetFaces(false); return; }
      if (k === '1' || k === '2' || k === '3') { e.preventDefault(); setSelMode(['', 'v', 'e', 'f'][+k]); return; }
      if (K === 'x' || k === 'Delete') { flash('Points and faces cannot be deleted because the collider has to stay closed. Move or scale them instead.'); return; }
      return;
    }
    if (K === 'x' || k === 'Delete') { if (k === 'Delete' && S.selKey) return; e.preventDefault(); deleteSelected(); return; }
    // I keys Location, Rotation and Scale (a source's Aim, Radius, Speed and Emitting too); over a field in the panel, only that field's
    // group, as in Blender. Alt+I takes the key off the frame shown the same way.
    if (K === 'i') {
      e.preventDefault();
      const hov = [...document.querySelectorAll(':hover')].pop(), row = hov && hov.closest && hov.closest('#params [data-kg]'), groups = row ? [row.dataset.kg] : null;
      const list = row && selected ? [selected] : [...selSet];
      if (!list.length) { flash('Click an object first.'); return; }
      if (e.altKey) { let n = 0; list.forEach((o) => { if (clearKeyAt(o, S.tl.t, groups)) n++; }); flash(n ? 'Key taken off at ' + S.tl.t.toFixed(2) + ' s' + (groups ? ' (' + GROUP_NAME[groups[0]] + ')' : '') : 'No key on this frame.'); return; }
      list.forEach((o) => addKey(o, S.tl.t, groups, true)); renderKF(); updateEst(); lcClear(); markKeyed();
      flash('Keyed ' + (groups ? GROUP_NAME[groups[0]] : list.every((o) => o.kind === 'emitter') ? 'Location, Aim, Radius, Speed, Emitting' : 'Location, Rotation, Scale') + ' at ' + S.tl.t.toFixed(2) + ' s');
      return;
    }
    if (K === 'h') { e.preventDefault(); if (e.altKey) objs.forEach((o) => { o.hidden = false; o.group.visible = true; }); else selSet.forEach((o) => { o.hidden = true; o.group.visible = false; }); renderOutliner(); return; }
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Control') lastM.ctrl = false; if (e.key === 'v' || e.key === 'V') { S.snapV = false; if (tf) evalTf(); } });
  window.addEventListener('keydown', (e) => { if ((e.key === 'v' || e.key === 'V') && !typing() && !e.ctrlKey && !e.metaKey) { if (!S.snapV) { S.snapV = true; if (tf) evalTf(); } } });
  window.addEventListener('blur', () => { S.snapV = false; });
  // camera moves glide to their goal
  let camGoal = null;
  function goCam(g) { camGoal = Object.assign({}, g); }
  let camT = performance.now();
  function stepCam() {
    const now = performance.now(), dtc = Math.min((now - camT) / 1000, 0.25); camT = now;
    if (!camGoal) return;
    const g = camGoal, k = 1 - Math.exp(-dtc * 12);
    if (g.tx !== undefined) { cam.target.x += (g.tx - cam.target.x) * k; cam.target.y += (g.ty - cam.target.y) * k; cam.target.z += (g.tz - cam.target.z) * k; }
    if (g.r !== undefined) cam.r += (g.r - cam.r) * k;
    if (g.theta !== undefined) { let d = g.theta - cam.theta; d = Math.atan2(Math.sin(d), Math.cos(d)); cam.theta += d * k; }
    if (g.phi !== undefined) cam.phi += (g.phi - cam.phi) * k;
    updateCam();
    const done = (g.tx === undefined || Math.hypot(g.tx - cam.target.x, g.ty - cam.target.y, g.tz - cam.target.z) < 0.003) && (g.r === undefined || Math.abs(g.r - cam.r) < 0.005) &&
      (g.theta === undefined || Math.abs(Math.atan2(Math.sin(g.theta - cam.theta), Math.cos(g.theta - cam.theta))) < 0.003) && (g.phi === undefined || Math.abs(g.phi - cam.phi) < 0.003);
    if (done) camGoal = null;
  }
  function focusSelected() {
    const pts = [];
    if (uiMode === 'edit' && editO) {
      editO.group.updateMatrixWorld(true);
      const vs = selVerts(); const src = vs.size ? [...vs] : editO.mesh.v.map((_, i) => i);
      src.forEach((i) => pts.push(worldOfLocal(editO, editO.mesh.v[i])));
    } else {
      [...selSet].forEach((o) => {
        if (o.kind === 'mesh') { o.group.updateMatrixWorld(true); o.mesh.v.forEach((q) => pts.push(worldOfLocal(o, q))); }
        else { pts.push(o.pos.clone().add(new THREE.Vector3(0.2, 0.2, 0.2))); pts.push(o.pos.clone().sub(new THREE.Vector3(0.2, 0.2, 0.2))); }
      });
    }
    if (!pts.length) { frameAll(); return; }
    const c = new THREE.Vector3(); pts.forEach((p) => c.add(p)); c.multiplyScalar(1 / pts.length);
    let rad = 0.25; pts.forEach((p) => { rad = Math.max(rad, p.distanceTo(c)); });
    goCam({ tx: c.x, ty: c.y, tz: c.z, r: clamp(rad * 3.4, 1.2, 40) });
  }
  function frameAll() {
    goCam({ tx: S.org.x, ty: S.org.y + (Hh > 3.5 ? Hh * 0.46 : Hh * 0.27), tz: S.org.z, r: clamp(2.1 * Math.max(W, Dd, Hh * 1.1), 3, 40) });
  }
  // axis views: looking from +Z (front), -Z (back), +X (right), -X (left), +Y (top), -Y (bottom), orthographic like Blender's numpad views
  const SNAP = { front: [0, Math.PI / 2], back: [Math.PI, Math.PI / 2], right: [Math.PI / 2, Math.PI / 2], left: [-Math.PI / 2, Math.PI / 2], top: [null, 0.0008], bottom: [null, Math.PI - 0.0008] };
  function snapView(v) {
    const s2 = SNAP[v]; if (!s2) return;
    let th = s2[0];
    if (th === null) th = Math.round(cam.theta / (Math.PI / 2)) * (Math.PI / 2);   // top and bottom keep the nearest side square to the screen
    setOrtho(true); goCam({ theta: th, phi: s2[1] });
  }
  function viewTo(v) { snapView(v === 'side' ? 'right' : v); }
  // the axis widget in the corner: drawn every frame from the camera, click a ball to look along that axis
  const axCan = $('#axisgiz'), axCtx = axCan ? axCan.getContext('2d') : null; let axHot = null, axBalls = [];
  function drawAxisWidget() {
    if (!axCtx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W2 = axCan.clientWidth, H2 = axCan.clientHeight;
    if (axCan.width !== Math.round(W2 * dpr)) { axCan.width = Math.round(W2 * dpr); axCan.height = Math.round(H2 * dpr); }
    const c = axCtx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W2, H2);
    camera.updateMatrixWorld(); const m = camera.matrixWorldInverse.elements, R = Math.min(W2, H2) * 0.36, cx = W2 / 2, cy = H2 / 2;
    if (axHot) { c.fillStyle = 'rgba(255,255,255,0.12)'; c.beginPath(); c.arc(cx, cy, R + 12, 0, Math.PI * 2); c.fill(); }
    const list = [];
    for (const [a, v, col] of [['x', [1, 0, 0], '#ff3352'], ['y', [0, 1, 0], '#8bdc00'], ['z', [0, 0, 1], '#2890ff']]) {
      const sx = m[0] * v[0] + m[4] * v[1] + m[8] * v[2], sy = m[1] * v[0] + m[5] * v[1] + m[9] * v[2], sz = m[2] * v[0] + m[6] * v[1] + m[10] * v[2];
      list.push({ a, s: 1, x: cx + sx * R, y: cy - sy * R, z: sz, col }); list.push({ a, s: -1, x: cx - sx * R, y: cy + sy * R, z: -sz, col });
    }
    list.sort((p, q) => p.z - q.z);
    axBalls = list;
    for (const p of list) {
      if (p.s > 0) { c.strokeStyle = p.col; c.lineWidth = 2; c.beginPath(); c.moveTo(cx, cy); c.lineTo(p.x, p.y); c.stroke(); }
      const hot = axHot && axHot.a === p.a && axHot.s === p.s, rr = p.s > 0 ? 9 : 7;
      c.beginPath(); c.arc(p.x, p.y, rr, 0, Math.PI * 2);
      if (p.s > 0) { c.fillStyle = hot ? '#ffffff' : p.col; c.fill(); c.fillStyle = '#16191c'; c.font = '600 10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(p.a.toUpperCase(), p.x, p.y + 0.5); }
      else { c.fillStyle = hot ? 'rgba(255,255,255,0.9)' : p.col + '55'; c.fill(); c.strokeStyle = p.col; c.lineWidth = 1.5; c.stroke(); }
    }
  }
  function axisBallAt(e) {
    const r2 = axCan.getBoundingClientRect(), x = e.clientX - r2.left, y = e.clientY - r2.top;
    let best = null, bd = 12 * 12;
    for (let i = axBalls.length - 1; i >= 0; i--) { const p = axBalls[i], dd = (p.x - x) ** 2 + (p.y - y) ** 2; if (dd < bd) { bd = dd; best = p; } }
    return best;
  }
  if (axCan) {
    axCan.addEventListener('pointermove', (e) => { axHot = axisBallAt(e); axCan.style.cursor = axHot ? 'pointer' : 'default'; });
    axCan.addEventListener('pointerleave', () => { axHot = null; });
    axCan.addEventListener('click', (e) => {
      const p = axisBallAt(e); if (!p) { setOrtho(!S.ortho); return; }
      snapView(p.a === 'x' ? (p.s > 0 ? 'right' : 'left') : p.a === 'y' ? (p.s > 0 ? 'top' : 'bottom') : (p.s > 0 ? 'front' : 'back'));
    });
  }
  // on-screen camera tools: drag pads for orbit, pan and zoom, and focus buttons
  document.querySelectorAll('#camtools [data-pad]').forEach((el) => {
    let last = null;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); last = { x: e.clientX, y: e.clientY }; camGoal = null; el.classList.add('on'); });
    el.addEventListener('pointermove', (e) => {
      if (!last) return; const dx = e.clientX - last.x, dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
      const k = el.dataset.pad; if (k === 'orbit') orbit(dx, dy); else if (k === 'pan') pan(dx, dy); else { cam.r = clamp(cam.r * Math.exp(dy * 0.01), 1.2, 40); updateCam(); }
    });
    const up = () => { last = null; el.classList.remove('on'); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  document.querySelectorAll('#camtools [data-act]').forEach((el) => el.addEventListener('click', () => {
    el.blur(); const a = el.dataset.act;
    if (a === 'focus') focusSelected(); else if (a === 'all') frameAll(); else if (a === 'ortho') setOrtho(!S.ortho); else viewTo(a);
  }));
  canvas.addEventListener('dblclick', (e) => {
    if (tf || viewMode() === 'cache') { if (!tf) frameAll(); return; }
    if (uiMode === 'edit') { focusSelected(); return; }
    const o = pickObject(e.clientX, e.clientY);
    if (o) { select(o, false); focusSelected(); } else frameAll();
  });

  // ---------- pointer: select, box select, orbit, pan, zoom ----------
  const ptrs = new Map(); let press = null, pinch0 = 0, r0 = 1, mid0 = null;
  const boxEl = $('#boxsel');
  function pickObject(cx, cy) {
    setNdc(cx, cy); const hits = ray.intersectObjects(objs.filter((o) => !o.hidden).map((o) => o.pick), false);
    return hits.length ? hits[0].object.userData.o : null;
  }

