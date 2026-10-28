  // ---------- viewport helpers ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const lastM = { x: 0, y: 0, ctrl: false };
  const cr = () => canvas.getBoundingClientRect();
  function setNdc(cx, cy) { const r = cr(); camera.updateMatrixWorld(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); }
  function rayAtClient(cx, cy) { setNdc(cx, cy); return ray.ray.clone(); }
  function toScreen(v3) { const r = cr(); camera.updateMatrixWorld(); const p = v3.clone().project(camera); return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height, z: p.z }; }
  function viewDir() { const d = new THREE.Vector3(); camera.getWorldDirection(d); return d; }
  function worldOfLocal(o, v) { return new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(o.group.matrixWorld); }
  function lineParam(P, u, ry) {   // parameter t along P + t u of the point closest to the ray
    const w = P.clone().sub(ry.origin), a = u.dot(u), bb = u.dot(ry.direction), c = ry.direction.dot(ry.direction), d = u.dot(w), e = ry.direction.dot(w);
    const den = a * c - bb * bb; if (Math.abs(den) < 1e-4) return null;
    return (bb * e - c * d) / den;
  }
  let hudMsgT = 0, hudMsg = '';
  function flash(msg) { hudMsg = msg; clearTimeout(hudMsgT); hudMsgT = setTimeout(() => { hudMsg = ''; hud(); }, 3500); hud(); }
  const AX = { x: 'X', y: 'Y', z: 'Z', n: 'normal' };
  function tfText() {
    const t = tf; let s = '';
    const axs = t.axis ? (t.plane ? 'not ' : '') + (t.axis === 'n' ? 'normal' : (useLocalAx() ? 'local ' : '') + AX[t.axis]) : '';
    if (t.type === 'g') {
      const d = t.d || new THREE.Vector3();
      s = 'Move' + (axs ? ' ' + axs : '') + '   ';
      s += t.num !== '' ? t.num + ' m' : (t.axis && !t.plane ? d.dot(curAxis()).toFixed(3) + ' m' : 'x ' + d.x.toFixed(3) + '  y ' + d.y.toFixed(3) + '  z ' + d.z.toFixed(3));
    } else if (t.type === 'r') {
      s = (t.list && t.list.length && t.list.every((q) => q.kind === 'emitter') ? 'Aim' : 'Rotate') + (axs ? ' ' + axs : ' (view)') + '   ' + (t.num !== '' ? t.num : ((t.angDeg || 0)).toFixed(1)) + '°';
    } else if (t.type === 'i') {
      s = 'Inset' + (t.individual ? ' each face' : '') + '   ' + (t.num !== '' ? t.num : (t.dist || 0).toFixed(3)) + ' m   (I: ' + (t.individual ? 'as one region' : 'each face on its own') + ')';
    } else {
      s = 'Scale' + (axs ? ' ' + axs : '') + '   ' + (t.num !== '' ? t.num : (t.k || 1).toFixed(3));
    }
    return s;
  }
  function hud() {
    const el = $('#hud'); if (!el) return;
    let m;
    if (uiMode === 'edit' && editO) m = 'Edit Mode · ' + ({ v: 'Vertex', e: 'Edge', f: 'Face' })[ES.sm] + ' · ' + selVerts().size + ' of ' + editO.mesh.v.length + ' points selected';
    else m = 'Object Mode · ' + selSet.size + ' selected';
    $('#hud-mode').textContent = m;
    $('#hud-op').textContent = tf ? tfText() : hudMsg;
    el.hidden = viewMode() === 'cache';
    el.classList.toggle('editing', uiMode === 'edit');
    updStatus();
  }

  // ---------- edit mode: points, edges and faces ----------
  const ES = { sm: 'v', v: new Set(), e: new Set(), f: new Set() };
  let edList = null, ov = null;
  function selVerts() {
    if (ES.sm === 'v') return ES.v;
    const s = new Set();
    if (ES.sm === 'e') ES.e.forEach((i) => { const e = edList[i]; if (e) { s.add(e.a); s.add(e.b); } });
    else ES.f.forEach((i) => { const f = editO.mesh.f[i]; if (f) f.forEach((v) => s.add(v)); });
    return s;
  }
  function clearSel() { ES.v.clear(); ES.e.clear(); ES.f.clear(); }
  function facesFromVerts(vs) { const out = new Set(); editO.mesh.f.forEach((f, i) => { if (f.every((v) => vs.has(v))) out.add(i); }); return out; }
  function setSelMode(m) {
    if (uiMode !== 'edit' || m === ES.sm) return;
    const o = editO, from = ES.sm, vs = selVerts();
    const v = new Set(vs), e = new Set(), f = new Set();
    if (m === 'v') { ES.v = v; }
    else if (m === 'e') {
      if (from === 'f') ES.f.forEach((fi) => { const fc = o.mesh.f[fi]; fc.forEach((a, k) => { const b2 = fc[(k + 1) % fc.length], key = Math.min(a, b2) + ',' + Math.max(a, b2); const ix = edList.findIndex((q) => q.a + ',' + q.b === key); if (ix >= 0) e.add(ix); }); });
      else edList.forEach((q, i) => { if (v.has(q.a) && v.has(q.b)) e.add(i); });
      ES.e = e;
    } else {
      if (from === 'e') { const es = ES.e; o.mesh.f.forEach((fc, fi) => { if (fc.every((a, k) => { const b2 = fc[(k + 1) % fc.length], key = Math.min(a, b2) + ',' + Math.max(a, b2); return es.has(edList.findIndex((q) => q.a + ',' + q.b === key)); })) f.add(fi); }); }
      else facesFromVerts(v).forEach((i) => f.add(i));
      ES.f = f;
    }
    ES.sm = m; updateOverlay(); renderUI(); hud();
  }
  // edit-mode overlay drawn the way Blender does: round points in point mode, thick edges in edge mode, face dots and filled faces in face mode.
  // Everything is depth tested (nudged a little towards the camera), so points and edges on the far side of the shape are hidden as in Blender's solid view.
  const OV_BIAS = 'vec4 ovBias(vec4 mv) { if (projectionMatrix[3][3] > 0.5) mv.z += 0.01; else mv.xyz *= 0.996; return mv; }\n';
  function ovDotMat() {
    return new THREE.ShaderMaterial({
      uniforms: { size: { value: 6 } }, transparent: true, depthTest: true, depthWrite: false,
      vertexShader: 'attribute vec3 col; attribute float sz; varying vec3 vC; uniform float size;\n' + OV_BIAS + 'void main() { vC = col; gl_Position = projectionMatrix * ovBias(modelViewMatrix * vec4(position, 1.0)); gl_PointSize = size * sz; }',
      fragmentShader: 'varying vec3 vC; void main() { vec2 c = gl_PointCoord * 2.0 - 1.0; float r = dot(c, c); if (r > 1.0) discard; gl_FragColor = vec4(vC, 1.0 - smoothstep(0.7, 1.0, r) * 0.6); }'
    });
  }
  function ovLineMat() {
    return new THREE.ShaderMaterial({
      uniforms: { res: { value: new THREE.Vector2(1, 1) } }, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'attribute vec3 other; attribute float side; attribute float lw; attribute vec3 col; varying vec3 vC; uniform vec2 res;\n' + OV_BIAS +
        'void main() { vC = col; vec4 a = projectionMatrix * ovBias(modelViewMatrix * vec4(position, 1.0)), b = projectionMatrix * ovBias(modelViewMatrix * vec4(other, 1.0));\n' +
        ' vec2 sa = a.xy / a.w * res * 0.5, sb = b.xy / b.w * res * 0.5, d = sb - sa; if (dot(d, d) < 1e-8) d = vec2(1.0, 0.0);\n' +
        ' vec2 n = normalize(vec2(-d.y, d.x)); a.xy += n * side * lw * 2.0 / res * a.w; gl_Position = a; }',
      fragmentShader: 'varying vec3 vC; void main() { gl_FragColor = vec4(vC, 1.0); }'
    });
  }
  function enterEdit(o, quiet) {
    if (!o || o.kind !== 'mesh') { if (!quiet) flash('Only grey colliders have a shape to edit.'); return; }
    if (uiMode === 'edit') exitEdit(true);
    if (!quiet) { if (selSet.size > 1 || selected !== o) { selSet.clear(); selSet.add(o); selected = o; } }
    uiMode = 'edit'; editO = o; clearSel(); edList = meshEdges(o.mesh);
    ov = {
      pts: new THREE.Points(new THREE.BufferGeometry(), ovDotMat()),
      fdots: new THREE.Points(new THREE.BufferGeometry(), ovDotMat()),
      lines: new THREE.Mesh(new THREE.BufferGeometry(), ovLineMat()),
      fill: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: ACCENT, opacity: 0.3, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))
    };
    ov.pts.renderOrder = 13; ov.fdots.renderOrder = 13; ov.lines.renderOrder = 12; ov.fill.renderOrder = 11;
    [ov.pts, ov.fdots, ov.lines, ov.fill].forEach((x) => { x.frustumCulled = false; o.group.add(x); });
    o.wire.visible = false;
    objs.forEach(syncMesh); updateOverlay(); renderUI(); hud();
  }
  function exitEdit(quiet) {
    if (uiMode !== 'edit') return;
    const o = editO;
    if (ov) { [ov.pts, ov.fdots, ov.lines, ov.fill].forEach((x) => { o.group.remove(x); x.geometry.dispose(); x.material.dispose(); }); ov = null; }
    o.wire.visible = true;
    if (o.sdfDirty && !o.sdfJob) rebuildSDFLater(o);   // the edits so far, worked out in the background now that editing is done
    uiMode = 'object'; editO = null; edList = null; clearSel(); objs.forEach(syncMesh);
    if (!quiet) { renderUI(); hud(); }
  }
  function ovRes() { if (!ov) return; const v = new THREE.Vector2(); renderer.getDrawingBufferSize(v); ov.lines.material.uniforms.res.value.copy(v); const dpr = renderer.getPixelRatio(); ov.pts.material.uniforms.size.value = 8 * dpr; ov.fdots.material.uniforms.size.value = 6 * dpr; }
  function updateOverlay() {
    if (!ov || !editO) return;
    const m = editO.mesh, V = m.v, n = V.length, vs = selVerts(), sm = ES.sm, dpr = renderer.getPixelRatio();
    const cA = new THREE.Color(ACCENT), cD = new THREE.Color(0x0b0b0b), cE = new THREE.Color(0x111111);
    // points: only in point mode
    {
      const pp = new Float32Array(sm === 'v' ? n * 3 : 0), pc = new Float32Array(pp.length), sz = new Float32Array(pp.length / 3);
      if (sm === 'v') V.forEach((q, i) => { pp.set(q, i * 3); const c = vs.has(i) ? cA : cD; pc.set([c.r, c.g, c.b], i * 3); sz[i] = vs.has(i) ? 1.15 : 1; });
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pp, 3)); g.setAttribute('col', new THREE.BufferAttribute(pc, 3)); g.setAttribute('sz', new THREE.BufferAttribute(sz, 1));
      ov.pts.geometry.dispose(); ov.pts.geometry = g;
    }
    // face dots: only in face mode
    {
      const nf = sm === 'f' ? m.f.length : 0, pp = new Float32Array(nf * 3), pc = new Float32Array(nf * 3), sz = new Float32Array(nf);
      for (let i = 0; i < nf; i++) { const f = m.f[i], c3 = [0, 0, 0]; f.forEach((v) => { for (let k = 0; k < 3; k++) c3[k] += V[v][k] / f.length; }); pp.set(c3, i * 3); const c = ES.f.has(i) ? cA : cD; pc.set([c.r, c.g, c.b], i * 3); sz[i] = 1; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pp, 3)); g.setAttribute('col', new THREE.BufferAttribute(pc, 3)); g.setAttribute('sz', new THREE.BufferAttribute(sz, 1));
      ov.fdots.geometry.dispose(); ov.fdots.geometry = g;
    }
    // edges as screen-space quads: thin in point and face mode, thick in edge mode
    {
      const ne = edList.length, P = new Float32Array(ne * 12), O = new Float32Array(ne * 12), SD = new Float32Array(ne * 4), LW = new Float32Array(ne * 4), C = new Float32Array(ne * 12), I = new Uint32Array(ne * 6);
      edList.forEach((e, i) => {
        const on = sm === 'e' ? ES.e.has(i) : sm === 'v' ? (vs.has(e.a) && vs.has(e.b)) : e.faces.some((fi) => ES.f.has(fi));
        const c = on ? cA : cE, w = (sm === 'e' ? (on ? 3 : 2.4) : (on ? 2 : 1.4)) * dpr * 0.5, A = V[e.a], B = V[e.b];
        const ends = [[A, B, 1], [A, B, -1], [B, A, -1], [B, A, 1]];
        ends.forEach(([p, q, sd], k) => { const j = i * 4 + k; P.set(p, j * 3); O.set(q, j * 3); SD[j] = sd; LW[j] = w; C.set([c.r, c.g, c.b], j * 3); });
        I.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
      });
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('other', new THREE.BufferAttribute(O, 3)); g.setAttribute('side', new THREE.BufferAttribute(SD, 1)); g.setAttribute('lw', new THREE.BufferAttribute(LW, 1)); g.setAttribute('col', new THREE.BufferAttribute(C, 3)); g.setIndex(new THREE.BufferAttribute(I, 1));
      ov.lines.geometry.dispose(); ov.lines.geometry = g;
    }
    const tr = editO.tris, fp = [];
    const showF = sm === 'f' ? ES.f : facesFromVerts(vs);
    for (let i = 0; i < tr.of.length; i++) if (showF.has(tr.of[i])) { for (let k = 0; k < 3; k++) fp.push(...V[tr.t[i * 3 + k]]); }
    const g3 = new THREE.BufferGeometry(); g3.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    ov.fill.geometry.dispose(); ov.fill.geometry = g3; ov.fill.material.opacity = sm === 'f' ? 0.32 : 0.2;
    ovRes();
    const info = $('#edit-info'); if (info) info.textContent = vs.size + ' of ' + n + ' points selected';
  }
  function renderEditPanel(p) {
    const o = editO;
    const head = document.createElement('div'); head.className = 'pos'; head.innerHTML = 'Editing <b>' + o.name + '</b>. Pick what to select:';
    p.appendChild(head);
    const sg = document.createElement('div'); sg.className = 'seg wide'; sg.id = 'seg-sel'; sg.setAttribute('role', 'group'); sg.setAttribute('aria-label', 'Select');
    sg.innerHTML = [['v', 'Points (1)'], ['e', 'Edges (2)'], ['f', 'Faces (3)']].map(([k, l]) => '<button type="button" data-v="' + k + '" aria-pressed="' + (ES.sm === k) + '">' + l + '</button>').join('');
    sg.addEventListener('click', (e) => { const bt = e.target.closest('button'); if (bt) { bt.blur(); setSelMode(bt.dataset.v); } });
    p.appendChild(sg);
    const r1 = document.createElement('div'); r1.className = 'btnrow';
    btn(r1, 'Move (G)', 'btn-g', () => startTf('g')); btn(r1, 'Rotate (R)', 'btn-r', () => startTf('r')); btn(r1, 'Scale (S)', 'btn-s', () => startTf('s'));
    btn(r1, 'Extrude (E)', 'btn-extrude', () => extrudeFaces());
    btn(r1, 'Inset (I)', 'btn-inset', () => insetFaces(false));
    p.appendChild(r1);
    const r2 = document.createElement('div'); r2.className = 'btnrow';
    btn(r2, 'Select all (A)', 'btn-all', () => selectAllEdit(true)); btn(r2, 'None (Alt+A)', 'btn-none', () => selectAllEdit(false));
    btn(r2, 'Done (Tab)', 'btn-done', () => exitEdit());
    p.appendChild(r2);
    const info = document.createElement('div'); info.className = 'pos'; info.id = 'edit-info'; p.appendChild(info);
    const note = document.createElement('div'); note.className = 'pos';
    note.textContent = 'Drag in empty space to box select. Shift+click adds or removes. Nothing is worked out for the water while you edit: it sees the new shape when you leave edit mode (Tab) or press play. Keep the shape closed: extrude, inset and move, but do not leave holes.';
    p.appendChild(note); updateOverlay();
  }
  function selectAllEdit(all) {
    if (uiMode !== 'edit') return;
    const o = editO, s = ES[ES.sm]; s.clear();
    if (all) { const cnt = ES.sm === 'v' ? o.mesh.v.length : ES.sm === 'e' ? edList.length : o.mesh.f.length; for (let i = 0; i < cnt; i++) s.add(i); }
    updateOverlay(); hud();
  }
  function faceNormalL(m, fi) {   // Newell normal in the object's local space
    const f = m.f[fi]; let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < f.length; k++) { const a = m.v[f[k]], b2 = m.v[f[(k + 1) % f.length]]; nx += (a[1] - b2[1]) * (a[2] + b2[2]); ny += (a[2] - b2[2]) * (a[0] + b2[0]); nz += (a[0] - b2[0]) * (a[1] + b2[1]); }
    const l = Math.hypot(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l];
  }
  function extrudeFaces() {
    if (uiMode !== 'edit') return;
    const o = editO, m = o.mesh;
    const fs = ES.sm === 'f' ? new Set(ES.f) : facesFromVerts(selVerts());
    if (!fs.size) { flash('Extrude needs faces. Press 3, click a face, then press E.'); return; }
    pushUndo();
    const cnt = new Map(), dirEdge = new Map();
    fs.forEach((fi) => { const f = m.f[fi]; f.forEach((a, k) => { const b2 = f[(k + 1) % f.length], key = Math.min(a, b2) + ',' + Math.max(a, b2); cnt.set(key, (cnt.get(key) || 0) + 1); dirEdge.set(key, [a, b2]); }); });
    const map = new Map();
    fs.forEach((fi) => m.f[fi].forEach((vi) => { if (!map.has(vi)) { map.set(vi, m.v.length); m.v.push(m.v[vi].slice()); } }));
    const sides = [];
    cnt.forEach((c, key) => { if (c === 1) { const [a, b2] = dirEdge.get(key); sides.push([a, b2, map.get(b2), map.get(a)]); } });
    let nx = 0, ny = 0, nz = 0;
    fs.forEach((fi) => { const nl = faceNormalL(m, fi); nx += nl[0]; ny += nl[1]; nz += nl[2]; });
    fs.forEach((fi) => { m.f[fi] = m.f[fi].map((vi) => map.get(vi)); });
    sides.forEach((s) => m.f.push(s));
    // drop points that no face uses any more and renumber the rest
    const used = new Set(); m.f.forEach((f) => f.forEach((v) => used.add(v)));
    const ren = new Map(), nv = []; m.v.forEach((q, i) => { if (used.has(i)) { ren.set(i, nv.length); nv.push(q); } });
    m.v = nv; m.f = m.f.map((f) => f.map((v) => ren.get(v)));
    edList = meshEdges(m); clearSel(); ES.sm = 'f'; fs.forEach((i) => ES.f.add(i));
    meshGeo(o); updateOverlay(); renderUI(); hud();
    const R = eulerMat(o.rx, o.yaw, o.rz), nl = new THREE.Vector3(nx / (o.sx || 1), ny / (o.sy || 1), nz / (o.sz || 1)).normalize();   // a normal goes through Scale divided
    const nw = new THREE.Vector3(R[0] * nl.x + R[1] * nl.y + R[2] * nl.z, R[3] * nl.x + R[4] * nl.y + R[5] * nl.z, R[6] * nl.x + R[7] * nl.y + R[8] * nl.z).normalize();
    startTf('g', { axis: 'n', nrm: nw, noUndo: true });
  }
  // Inset (I), as in Blender: the selected faces get a smaller copy of themselves inside them, joined to the old outline by a ring of new
  // faces, all in the faces' own plane; moving the mouse towards the faces makes the ring wider. The selection is insetted as one region
  // (only its outline gets a ring); pressing I again while insetting does each face on its own. base: the shape before the inset (to switch).
  function insetFaces(individual, base) {
    if (uiMode !== 'edit') return;
    const o = editO;
    if (base) { o.mesh = { v: base.v.map((q) => q.slice()), f: base.f.map((q) => q.slice()) }; ES.sm = 'f'; ES.f = new Set(base.fs); }
    let m = o.mesh;
    const fs = ES.sm === 'f' ? [...ES.f] : [...facesFromVerts(selVerts())];
    if (!fs.length) { flash('Inset needs faces. Press 3, click a face, then press I.'); return; }
    if (!base) { pushUndo(); m = o.mesh; base = { v: m.v.map((q) => q.slice()), f: m.f.map((q) => q.slice()), fs: fs.slice() }; }
    const s = [o.sx || 1, o.sy || 1, o.sz || 1], P = (i) => [m.v[i][0] * s[0], m.v[i][1] * s[1], m.v[i][2] * s[2]];   // points at their real size
    const nrm = (f) => { let nx = 0, ny = 0, nz = 0; for (let k = 0; k < f.length; k++) { const a = P(f[k]), b2 = P(f[(k + 1) % f.length]); nx += (a[1] - b2[1]) * (a[2] + b2[2]); ny += (a[2] - b2[2]) * (a[0] + b2[0]); nz += (a[0] - b2[0]) * (a[1] + b2[1]); } const l = Math.hypot(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l]; };
    const groups = individual ? fs.map((fi) => [fi]) : [fs];
    const inset = new Map();   // new point -> { d: direction it moves per metre of inset, max: how far it may go }
    const sides = [];
    for (const gr of groups) {
      const cnt = new Map(), dirEdge = new Map();
      gr.forEach((fi) => { const f = m.f[fi]; f.forEach((a, k) => { const b2 = f[(k + 1) % f.length], key = Math.min(a, b2) + ',' + Math.max(a, b2); cnt.set(key, (cnt.get(key) || 0) + 1); dirEdge.set(key, [a, b2, fi]); }); });
      const map = new Map();
      gr.forEach((fi) => m.f[fi].forEach((vi) => { if (!map.has(vi)) { map.set(vi, m.v.length); m.v.push(m.v[vi].slice()); } }));
      // each outline edge a->b (in its face's winding) moves inwards along n x (b - a); a point moves so both its edges move by the inset
      const acc = new Map();
      cnt.forEach((c, key) => {
        if (c !== 1) return;
        const [a, b2, fi] = dirEdge.get(key), n = nrm(m.f[fi]), A = P(a), B = P(b2), e = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        let w = [n[1] * e[2] - n[2] * e[1], n[2] * e[0] - n[0] * e[2], n[0] * e[1] - n[1] * e[0]]; const l = Math.hypot(w[0], w[1], w[2]) || 1; w = w.map((x) => x / l);
        for (const v of [a, b2]) { const q = acc.get(v) || []; q.push(w); acc.set(v, q); }
        sides.push([a, b2, map.get(b2), map.get(a)]);
      });
      const cen = [0, 0, 0]; map.forEach((nv, vi) => { const q = P(vi); for (let k = 0; k < 3; k++) cen[k] += q[k] / map.size; });
      let lim = Infinity; const dirs = new Map();
      acc.forEach((ws, v) => {
        let d;
        if (ws.length === 2) { const a = ws[0], b2 = ws[1], dt = a[0] * b2[0] + a[1] * b2[1] + a[2] * b2[2], k = 1 / Math.max(1 + dt, 0.15); d = [(a[0] + b2[0]) * k, (a[1] + b2[1]) * k, (a[2] + b2[2]) * k]; }
        else { d = [0, 0, 0]; ws.forEach((w) => { for (let k = 0; k < 3; k++) d[k] += w[k] / ws.length; }); }
        const q = P(v), dl = Math.hypot(d[0], d[1], d[2]) || 1; lim = Math.min(lim, 0.95 * Math.hypot(q[0] - cen[0], q[1] - cen[1], q[2] - cen[2]) / dl);
        dirs.set(map.get(v), d);
      });
      map.forEach((nv) => inset.set(nv, { d: dirs.get(nv) || [0, 0, 0], max: dirs.has(nv) ? lim : 0 }));
      gr.forEach((fi) => { m.f[fi] = m.f[fi].map((vi) => map.get(vi)); });
    }
    sides.forEach((q) => m.f.push(q));
    const used = new Set(); m.f.forEach((f) => f.forEach((v) => used.add(v)));
    const ren = new Map(), nv = []; m.v.forEach((q, i) => { if (used.has(i)) { ren.set(i, nv.length); nv.push(q); } });
    m.v = nv; m.f = m.f.map((f) => f.map((v) => ren.get(v)));
    const insetN = new Map(); inset.forEach((val, i) => { if (ren.has(i)) insetN.set(ren.get(i), val); });
    edList = meshEdges(m); clearSel(); ES.sm = 'f'; fs.forEach((i) => ES.f.add(i));
    meshGeo(o); updateOverlay(); renderUI(); hud();
    startTf('i', { noUndo: true, insetMap: insetN, insetBase: base, individual, m0: insetFaces.m0 });
  }
  function editPick(cx, cy) {
    const o = editO; o.group.updateMatrixWorld(true);
    if (ES.sm === 'f') {
      setNdc(cx, cy); const hits = ray.intersectObject(o.pick, false);
      return hits.length ? { t: 'f', i: o.tris.of[hits[0].faceIndex] } : null;
    }
    const sv = o.mesh.v.map((q) => toScreen(worldOfLocal(o, q)));
    if (ES.sm === 'v') {
      let best = -1, bd = 15 * 15; sv.forEach((s, i) => { const d = (s.x - cx) ** 2 + (s.y - cy) ** 2; if (d < bd) { bd = d; best = i; } });
      return best >= 0 ? { t: 'v', i: best } : null;
    }
    let best = -1, bd = 11 * 11;
    edList.forEach((e, i) => {
      const A = sv[e.a], B = sv[e.b], dx = B.x - A.x, dy = B.y - A.y, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((cx - A.x) * dx + (cy - A.y) * dy) / L)), px = A.x + dx * t - cx, py = A.y + dy * t - cy, d = px * px + py * py;
      if (d < bd) { bd = d; best = i; }
    });
    return best >= 0 ? { t: 'e', i: best } : null;
  }
  function editIsSelected(h) { return h && (h.t === 'v' ? ES.v.has(h.i) : h.t === 'e' ? ES.e.has(h.i) : ES.f.has(h.i)); }
  function editClick(cx, cy, extend) {
    const h = editPick(cx, cy), s = ES[ES.sm];
    if (!h) { if (!extend) { s.clear(); } }
    else if (extend) { if (s.has(h.i)) s.delete(h.i); else s.add(h.i); }
    else { s.clear(); s.add(h.i); }
    updateOverlay(); hud();
  }
  function editBox(r, extend) {
    const o = editO; o.group.updateMatrixWorld(true);
    const inR = (s) => s.x >= r.x0 && s.x <= r.x1 && s.y >= r.y0 && s.y <= r.y1;
    const sv = o.mesh.v.map((q) => toScreen(worldOfLocal(o, q))), set = ES[ES.sm];
    if (!extend) set.clear();
    if (ES.sm === 'v') sv.forEach((s, i) => { if (inR(s)) set.add(i); });
    else if (ES.sm === 'e') edList.forEach((e, i) => { if (inR(sv[e.a]) && inR(sv[e.b])) set.add(i); });
    else o.mesh.f.forEach((f, i) => { let cx = 0, cy = 0; f.forEach((v) => { cx += sv[v].x; cy += sv[v].y; }); if (inR({ x: cx / f.length, y: cy / f.length })) set.add(i); });
    updateOverlay(); hud();
  }

