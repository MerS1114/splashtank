  // ---------- object list and parameters ----------
  let tf = null;   // active modal transform
  // kg: the key group the row shows (Location, Rotation, Scale), for hovering it and pressing I and for the keyed colours
  function addVec(parent, label, ids, vals, step, onSet, kg) {
    const row = document.createElement('div'); row.className = 'row vec'; if (kg) row.dataset.kg = kg;
    row.innerHTML = '<label>' + label + '</label>' + ['x', 'y', 'z'].map((a, i) => '<input type="number" id="' + ids + a + '" step="' + step + '" value="' + (+vals[i].toFixed(3)) + '" aria-label="' + label + ' ' + a.toUpperCase() + '">').join('');
    row.querySelectorAll('input').forEach((inp, i) => inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!isNaN(v)) onSet(i, v); }));
    parent.appendChild(row); return row;
  }
  const LOCK_ON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  const LOCK_OFF = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>';
  // a shape's size along its own axes before Scale, from its points
  const baseDims = (o) => { const bb = meshBounds(o.mesh); return bb.hi.map((h, k) => h - bb.lo[k]); };
  // set one axis of Scale; with the proportions locked the other two follow by the same factor, so the shape keeps its proportions
  function setScaleAxis(o, i, v) {
    const s = [o.sx || 1, o.sy || 1, o.sz || 1]; v = Math.max(0.02, v);
    if (o.lockScale) { const f = v / s[i]; for (let k = 0; k < 3; k++) s[k] = clamp(s[k] * f, 0.02, 1000); } else s[i] = v;
    o.sx = s[0]; o.sy = s[1]; o.sz = s[2];
  }
  function btn(parent, text, id, cb, cls) {
    const bt = document.createElement('button'); bt.type = 'button'; bt.className = 'btn flat' + (cls ? ' ' + cls : ''); bt.textContent = text; if (id) bt.id = id;
    bt.addEventListener('click', () => { bt.blur(); cb(); }); parent.appendChild(bt); return bt;
  }
  const R2D = 180 / Math.PI;
  function renderUI() {
    renderOutliner();
    const p = $('#params'); p.innerHTML = '';
    const o = selected; if (!o) return;
    const pre = 'p-' + o.id + '-', sync = () => syncMesh(o);
    if (uiMode === 'edit' && editO === o) { renderEditPanel(p); return; }
    const tr = document.createElement('div'); tr.className = 'btnrow';
    btn(tr, o.kind === 'emitter' ? 'Move (G)' : 'Move (G)', 'btn-g', () => startTf('g'));
    btn(tr, o.kind === 'emitter' ? 'Aim (R)' : 'Rotate (R)', 'btn-r', () => startTf('r'));
    btn(tr, o.kind === 'emitter' ? 'Radius (S)' : 'Scale (S)', 'btn-s', () => startTf('s'));
    if (o.kind === 'mesh') btn(tr, 'Edit shape (Tab)', 'btn-edit', () => enterEdit(o));
    p.appendChild(tr);
    addVec(p, 'Location', 'loc-', [o.target.x, o.target.y, o.target.z], 0.05, (i, v) => {
      pushUndo(); const t = o.target; if (i === 0) t.x = v; else if (i === 1) t.y = v; else t.z = v; if (!S.playing) o.pos.copy(t); syncMesh(o); autoKey(o, ['loc']);
    }, 'loc');
    if (o.kind === 'mesh') {
      const wl = document.createElement('label'); wl.className = 'check';
      wl.innerHTML = '<input type="checkbox" id="' + pre + 'water"' + (o.water ? ' checked' : '') + '><span data-tip="The shape is filled with water instead of colliding. Moving or resizing it takes effect when you press Reset.">Water volume</span>';
      wl.querySelector('input').addEventListener('change', (e) => { pushUndo(); o.water = e.target.checked; waterStyle(o); if (o.water) fillNow(o); renderUI(); updateEst(); });
      p.appendChild(wl);
      if (o.water) {
        btn(p, 'Fill now', 'btn-fillnow', () => fillNow(o));
      }
      addVec(p, 'Rotation', 'rot-', [o.rx * R2D, o.yaw * R2D, o.rz * R2D], 5, (i, v) => {
        pushUndo(); const r = v / R2D; if (i === 0) o.rx = r; else if (i === 1) o.yaw = r; else o.rz = r; syncMesh(o); autoKey(o, ['rot']);
      }, 'rot');
      // Scale (a factor on the shape) and Dimensions (the size in metres it gives), with a lock that keeps the proportions
      const sc = addVec(p, 'Scale', 'scl-', [o.sx || 1, o.sy || 1, o.sz || 1], 0.1, (i, v) => {
        pushUndo(); setScaleAxis(o, i, v); syncMesh(o); refreshFields(); autoKey(o, ['scale']);
      }, 'scale');
      const lk = document.createElement('button'); lk.type = 'button'; lk.className = 'lockbtn'; lk.id = 'btn-lockscale'; lk.setAttribute('aria-pressed', o.lockScale ? 'true' : 'false');
      lk.setAttribute('aria-label', 'Lock proportions'); lk.dataset.tip = 'Lock proportions: typing one Scale or Dimensions value changes the other two by the same factor, and S scales evenly even with an axis picked.';
      lk.innerHTML = o.lockScale ? LOCK_ON : LOCK_OFF;
      lk.addEventListener('click', () => { lk.blur(); o.lockScale = !o.lockScale; renderUI(); });
      sc.appendChild(lk);
      const bd = baseDims(o);
      addVec(p, 'Dimensions', 'dim-', bd.map((d, k) => d * [o.sx || 1, o.sy || 1, o.sz || 1][k]), 0.05, (i, v) => {
        pushUndo(); const b0 = baseDims(o)[i]; if (b0 > 1e-6) setScaleAxis(o, i, v / b0); syncMesh(o); refreshFields(); autoKey(o, ['scale']);
      }, 'scale').classList.add('lockpad');
      const dim = document.createElement('div'); dim.className = 'pos'; dim.id = 'dim-readout';
      dim.textContent = o.mesh.v.length + ' points' + (o.sdfDirty ? ' · the water sees the new shape when you next play, step or reset' : '');
      p.appendChild(dim);
    }
    if (o.kind === 'emitter') {
      const lab = document.createElement('label'); lab.className = 'check'; lab.dataset.kg = 'on';
      lab.innerHTML = '<input type="checkbox" id="' + pre + 'on"' + (o.on ? ' checked' : '') + '><span>Emitting</span>';
      lab.querySelector('input').addEventListener('change', (e) => { o.on = e.target.checked; sync(); updateEst(); autoKey(o, ['on']); });
      p.appendChild(lab);
      const modeRow = document.createElement('div'); modeRow.className = 'row plain';
      modeRow.innerHTML = '<label>Emission</label><div class="seg" id="' + pre + 'mode" role="group" aria-label="Emission mode"><button type="button" data-v="smooth" aria-pressed="' + (o.mode === 'smooth') + '">Smooth</button><button type="button" data-v="random" aria-pressed="' + (o.mode === 'random') + '">Random</button></div>';
      p.appendChild(modeRow);
      modeRow.querySelector('.seg').addEventListener('click', (e) => {
        const bt = e.target.closest('button'); if (!bt) return; o.mode = bt.dataset.v; renderUI(); updateEst();
      });
      const kgRow = (inp, g) => { inp.closest('.row').dataset.kg = g; };
      kgRow(addSlider(p, { id: pre + 'speed', label: 'Speed', min: 0, max: 10, step: 0.1, value: o.speed, fmt: f1, onInput: (v) => { o.speed = v; sync(); updateEst(); autoKey(o, ['speed']); } }), 'speed');
      kgRow(addSlider(p, { id: pre + 'rad', label: 'Radius', min: 0.03, max: 0.5, step: 0.01, value: o.radius, fmt: f2, onInput: (v) => { o.radius = v; sync(); updateEst(); autoKey(o, ['radius']); } }), 'radius');
      kgRow(addSlider(p, { id: pre + 'az', label: 'Heading', min: -180, max: 180, step: 1, value: Math.round(o.az), fmt: (v) => v + '°', onInput: (v) => { o.az = v; sync(); autoKey(o, ['aim']); } }), 'aim');
      kgRow(addSlider(p, { id: pre + 'el', label: 'Pitch', min: -90, max: 90, step: 1, value: Math.round(o.el), fmt: (v) => v + '°', onInput: (v) => { o.el = v; sync(); autoKey(o, ['aim']); } }), 'aim');
      addSlider(p, { id: pre + 'turb', label: 'Turbulence', min: 0, max: 1.5, step: 0.05, value: o.turb || 0, fmt: (v) => v === 0 ? 'off' : v.toFixed(2), onInput: (v) => { o.turb = v; } });
      addSlider(p, { id: pre + 'spr', label: 'Spread', min: 0, max: 1, step: 0.02, value: o.spread, fmt: (v) => v.toFixed(2) + ' m/s', onInput: (v) => { o.spread = v; } });
      if (o.mode === 'random') addSlider(p, { id: pre + 'den', label: 'Density', min: 0.2, max: 1.5, step: 0.05, value: o.density, fmt: f2, onInput: (v) => { o.density = v; updateEst(); } });
    } else {
      addSlider(p, { id: pre + 'spin', label: 'Spin', min: -6, max: 6, step: 0.1, value: o.spin, fmt: (v) => v.toFixed(1) + '/s', onInput: (v) => { o.spin = v; } });
    }
    const br = document.createElement('div'); br.className = 'btnrow';
    btn(br, 'Duplicate (Shift+D)', 'btn-dup', () => dupSelected());
    btn(br, 'Delete (X)', 'btn-delete', () => deleteSelected(), 'danger');
    p.appendChild(br);
    markKeyed();
  }
  // ---------- outliner: the tank, every object (type icon, name, what it is, eye), the simulation ----------
  const OL_ICON = {
    water: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#5fc3f0" stroke-width="1.4" aria-hidden="true"><path d="M8 2c2.2 2.8 4 4.8 4 6.8a4 4 0 0 1-8 0C4 6.8 5.8 4.8 8 2z"/></svg>',
    emitter: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#35d07f" stroke-width="1.4" aria-hidden="true"><circle cx="4" cy="8" r="2.2"/><path d="M7.5 8h7M11.5 5l3 3-3 3"/></svg>',
    mesh: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#bdbdbd" stroke-width="1.4" aria-hidden="true"><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM8 8l5.5-3.2M8 8v6.2M8 8L2.5 4.8"/></svg>'
  };
  const EYE_ON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 2l12 12M4 5C2.6 6.3 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.2 0 2.2-.3 3.1-.8M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.3"/></svg>';
  function objKindText(o) {
    if (o.kind === 'emitter') return 'source' + (o.on ? '' : ', off') + (o.keys.length ? ' · ' + o.keys.length + ' keys' : '');
    return (o.water ? 'water' : 'collider') + (o.keys.length ? ' · ' + o.keys.length + ' keys' : '');
  }
  function setHidden(o, h) { o.hidden = !!h; o.group.visible = !o.hidden; renderOutliner(); }
  function renderOutliner() {
    const list = $('#objlist'); if (!list) return; list.innerHTML = '';
    objs.forEach((o) => {
      const c = document.createElement('div'); c.className = 'orow ind' + (o === selected ? ' active' : '') + (o.hidden ? ' hid' : ''); c.id = 'chip-' + o.id; c.tabIndex = 0;
      c.setAttribute('role', 'button'); c.setAttribute('aria-pressed', selSet.has(o) ? 'true' : 'false');
      c.innerHTML = (o.kind === 'emitter' ? OL_ICON.emitter : o.water ? OL_ICON.water : OL_ICON.mesh) + '<span class="nm"></span><span class="sub"></span><span class="eye" role="button" aria-label="Show or hide in the viewport" title="Show or hide in the viewport (H, Alt+H)">' + (o.hidden ? EYE_OFF : EYE_ON) + '</span>';
      c.querySelector('.nm').textContent = o.name; c.querySelector('.sub').textContent = objKindText(o);
      c.addEventListener('click', (e) => {
        if (e.target.closest('.eye')) { setHidden(o, !o.hidden); return; }
        if (e.target.closest('input')) return;
        select(o, e.shiftKey); setPtab('object');
      });
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(o, e.shiftKey); } });
      c.querySelector('.nm').addEventListener('dblclick', (e) => {   // rename
        e.stopPropagation();
        const nm = e.currentTarget, inp = document.createElement('input'); inp.className = 'rename'; inp.value = o.name; nm.replaceWith(inp); inp.focus(); inp.select();
        let fin = false;
        const done = (ok) => { if (fin) return; fin = true; const v = inp.value.trim(); if (ok && v) { o.name = v.slice(0, 32); } renderUI(); renderKF(); };
        inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') done(false); });
        inp.addEventListener('blur', () => done(true));
      });
      list.appendChild(c);
    });
    const ts = $('#ol-tank-sub'); if (ts) ts.textContent = 'domain · ' + S.dom.w.toFixed(1) + ' × ' + S.dom.h.toFixed(1) + ' × ' + S.dom.d.toFixed(1);
  }
  // numeric fields follow the object while it is being moved
  function refreshFields() {
    const o = selected; if (!o || uiMode === 'edit') return;
    const set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = +v.toFixed(3); };
    set('loc-x', o.target.x); set('loc-y', o.target.y); set('loc-z', o.target.z);
    if (o.kind === 'mesh') {
      set('rot-x', o.rx * R2D); set('rot-y', o.yaw * R2D); set('rot-z', o.rz * R2D);
      const s = [o.sx || 1, o.sy || 1, o.sz || 1]; set('scl-x', s[0]); set('scl-y', s[1]); set('scl-z', s[2]);
      if (document.getElementById('dim-x')) { const bd = baseDims(o); set('dim-x', bd[0] * s[0]); set('dim-y', bd[1] * s[1]); set('dim-z', bd[2] * s[2]); }
    }
  }
  function updatePosReadout() { refreshFields(); }
  function addAt(shape, water) {
    if (objs.length >= 24) { flash('That is the most objects this scene can hold.'); return; }
    pushUndo();
    const jx = (Math.random() - 0.5) * 0.4, jz = (Math.random() - 0.5) * 0.4;
    const o = shape === 'emitter' ? makeObj('emitter', { x: S.org.x + jx, y: S.org.y + Math.min(2.0, S.dom.h - 0.4), z: S.org.z + jz, el: -90, speed: 3 }) : water ? makeObj(shape, Object.assign({ water: true, name: 'Water' + (objs.filter((q) => q.water).length + 1), x: S.org.x + jx, y: S.org.y + Math.min(1.2, S.dom.h * 0.5), z: S.org.z + jz }, shape === 'sphere' ? { r: 0.5 } : { hx: 0.6, hy: 0.45, hz: 0.6 })) : makeObj(shape, { x: S.org.x + jx, y: S.org.y + 0.9, z: S.org.z + jz });
    select(o); if (water) fillNow(o); updateEst();
  }
  function deleteSelected() {
    if (!selSet.size) return; pushUndo();
    [...selSet].forEach((o) => removeObj(o, true));
    selected = [...selSet].pop() || null;
    objs.forEach(syncMesh); renderUI(); updateRecInfo(); updateEst(); renderKF(); hud();
  }
  function dupSelected() {
    if (!selSet.size || uiMode === 'edit') return;
    pushUndo();
    const fresh = [];
    for (const o of selSet) {
      const q = {
        x: o.pos.x, y: o.pos.y, z: o.pos.z, rx: o.rx, yaw: o.yaw, rz: o.rz, sx: o.sx, sy: o.sy, sz: o.sz, lockScale: o.lockScale, spin: o.spin, name: o.name.replace(/\.\d+$/, '') + '.001',
        az: o.az, el: o.el, speed: o.speed, radius: o.radius, on: o.on, mode: o.mode, spread: o.spread, density: o.density, turb: o.turb, water: o.water,
        mesh: o.mesh || undefined, sdf: o.sdf || undefined
      };
      const n = makeObj(o.shape, q); n.keys = o.keys.map((k) => Object.assign({}, k)); fresh.push(n);
    }
    selSet.clear(); fresh.forEach((n) => selSet.add(n)); selected = fresh[fresh.length - 1];
    objs.forEach(syncMesh); renderUI(); renderKF(); updateEst();
    startTf('g', { noUndo: true });
  }
  $('#btn-add').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.blur(); openAddMenu(r.left, r.bottom + 4); });

