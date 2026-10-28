  // ---------- modal transforms (G, R, S) ----------
  const axisVec = (a) => a === 'x' ? new THREE.Vector3(1, 0, 0) : a === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const frameObj = () => tf.edit ? tf.o : (tf.list.length === 1 && tf.list[0].kind === 'mesh' ? tf.list[0] : null);
  // Global or Local (the orientation setting): which axes X, Y and Z mean. Pressing the same axis key twice switches to the other one for this move, as in Blender.
  function useLocalAx() { return !!frameObj() && ((S.orient === 'local') !== !!tf.local); }
  function axisDir(a) {
    const fo = frameObj();
    if (fo && useLocalAx()) { const R = eulerMat(fo.rx, fo.yaw, fo.rz), c = a === 'x' ? 0 : a === 'y' ? 1 : 2; return new THREE.Vector3(R[c], R[3 + c], R[6 + c]); }
    return axisVec(a);
  }
  function curAxis() {
    if (!tf.axis) return null;
    if (tf.axis === 'n') return tf.nrm.clone();
    return axisDir(tf.axis);
  }
  // a scale given along the chosen axes, as a matrix acting on the shape's own (local) coordinates; R turns local into world
  function scaleMatL(R, f, loc) {
    if (loc) return [f[0], 0, 0, 0, f[1], 0, 0, 0, f[2]];
    const M = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let v = 0; for (let k = 0; k < 3; k++) v += R[k * 3 + i] * f[k] * R[k * 3 + j]; M[i * 3 + j] = v; }
    return M;
  }
  const mul3 = (M, x, y, z) => [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z];
  function startTf(type, opts) {
    opts = opts || {};
    if (tf || S.baking || viewMode() === 'cache') return;
    let pivot, rec;
    if (uiMode === 'edit') {
      const o = editO, vs = [...selVerts()];
      if (!vs.length) { flash('Select a point, edge or face first.'); return; }
      const pl = [0, 0, 0]; vs.forEach((i) => { for (let k = 0; k < 3; k++) pl[k] += o.mesh.v[i][k] / vs.length; });
      o.group.updateMatrixWorld(true);
      pivot = worldOfLocal(o, pl);
      rec = { edit: true, o, vs, orig: vs.map((i) => o.mesh.v[i].slice()), pivL: pl };
    } else {
      const list = [...selSet];
      if (!list.length) { flash('Click an object first.'); return; }
      pivot = new THREE.Vector3(); list.forEach((o) => pivot.add(o.target)); pivot.multiplyScalar(1 / list.length);
      rec = { edit: false, list, orig: list.map((o) => ({ x: o.target.x, y: o.target.y, z: o.target.z, rx: o.rx, yaw: o.yaw, rz: o.rz, sx: o.sx || 1, sy: o.sy || 1, sz: o.sz || 1, az: o.az, el: o.el, radius: o.radius })) };
    }
    if (!opts.noUndo) pushUndo();
    tf = Object.assign(rec, { type, pivot, axis: opts.axis || null, nrm: opts.nrm || null, plane: false, local: false, num: '', m0: opts.m0 || { x: lastM.x, y: lastM.y }, fromDrag: !!opts.fromDrag, structural: !!opts.noUndo, ang: 0, prevA: null, d: new THREE.Vector3(), f: [1, 1, 1] });
    if (type === 'i') { tf.inset = rec.vs.map((i) => opts.insetMap.get(i) || { d: [0, 0, 0], max: 0 }); tf.insetBase = opts.insetBase; tf.individual = !!opts.individual; tf.dist = 0; }
    const p = toScreen(pivot); tf.prevA = Math.atan2(lastM.y - p.y, lastM.x - p.x);
    canvas.style.cursor = type === 'g' ? 'move' : 'crosshair';
    evalTf(); hud();
  }
  function evalTf() {
    const t = tf, cur = lastM, p0 = t.m0, ax = curAxis();
    if (t.type === 'g') {
      const d = new THREE.Vector3();
      if (t.num !== '') { const v = parseFloat(t.num); if (!isNaN(v)) d.copy(ax || axisVec('x')).multiplyScalar(v); }
      else {
        const r0 = rayAtClient(p0.x, p0.y), r1 = rayAtClient(cur.x, cur.y);
        if (ax && !t.plane) { const t0 = lineParam(t.pivot, ax, r0), t1 = lineParam(t.pivot, ax, r1); if (t0 !== null && t1 !== null) d.copy(ax).multiplyScalar(t1 - t0); }
        else {
          const nrm = ax && t.plane ? ax : viewDir().negate(), pl = new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, t.pivot);
          const h0 = r0.intersectPlane(pl, new THREE.Vector3()), h1 = r1.intersectPlane(pl, new THREE.Vector3());
          if (h0 && h1) d.copy(h1).sub(h0);
        }
        if (snapAct(cur) && snapMode() === 'increment') {
          if (ax && !t.plane) d.copy(ax).multiplyScalar(Math.round(d.dot(ax) / 0.1) * 0.1);
          else d.set(Math.round(d.x / 0.1) * 0.1, Math.round(d.y / 0.1) * 0.1, Math.round(d.z / 0.1) * 0.1);
        }
      }
      if (t.num === '' && snapAct(cur) && snapMode() !== 'increment') snapMove(t, d, ax, snapMode()); else { t.snapAt = null; snapMark.visible = false; }
      if (d.length() > 60) d.setLength(60);
      t.d = d;
    } else if (t.type === 'r') {
      const p = toScreen(t.pivot), a1 = Math.atan2(cur.y - p.y, cur.x - p.x);
      let da = a1 - t.prevA; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      t.ang += -da; t.prevA = a1;
      let ang = t.ang;
      const axis = ax || viewDir().negate();
      if (ax && ax.dot(viewDir().negate()) < 0) ang = -ang;
      if (t.num !== '') { const v = parseFloat(t.num); ang = isNaN(v) ? 0 : v / R2D; }
      else if (snapAct(cur)) ang = Math.round(ang * R2D / 5) * 5 / R2D;
      t.angRad = ang; t.angDeg = ang * R2D; t.rotAxis = axis.clone().normalize();
    } else if (t.type === 'i') {   // inset: how far the mouse has come towards the faces' centre, in metres at the faces
      const p = toScreen(t.pivot), d0 = Math.hypot(p0.x - p.x, p0.y - p.y), d1 = Math.hypot(cur.x - p.x, cur.y - p.y);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), q = toScreen(t.pivot.clone().add(right)), ppm = Math.max(Math.hypot(q.x - p.x, q.y - p.y), 1e-3);
      let dist = t.num !== '' ? parseFloat(t.num) : Math.max(0, (d0 - d1) / ppm);
      if (isNaN(dist)) dist = 0; if (t.num === '' && snapAct(cur)) dist = Math.round(dist / 0.01) * 0.01;
      t.dist = Math.max(0, dist);
    } else {
      const p = toScreen(t.pivot);
      let k;
      if (t.num !== '') { k = parseFloat(t.num); if (isNaN(k)) k = 1; }
      else {
        const d0 = Math.max(Math.hypot(p0.x - p.x, p0.y - p.y), 24), d1 = Math.hypot(cur.x - p.x, cur.y - p.y);
        k = d1 / d0; if (snapAct(cur)) k = Math.round(k / 0.1) * 0.1;
      }
      k = Math.max(0.02, k); t.k = k;
      const f = [1, 1, 1];
      if (!t.axis || (!t.edit && t.list.every((o) => o.lockScale || o.kind !== 'mesh'))) f[0] = f[1] = f[2] = k;   // locked proportions scale evenly
      else if (t.plane) { for (let i = 0; i < 3; i++) if ('xyz'[i] !== t.axis) f[i] = k; }
      else f['xyz'.indexOf(t.axis)] = k;
      t.f = f;
    }
    applyTf();
  }
  // snapping, as in Blender: the magnet (Shift+Tab) turns it on, holding Ctrl while moving flips it for the moment, and V held snaps to points whatever the setting.
  // Snap to Increment rounds to 0.1 m (5° and 0.1 when rotating or scaling). Point, Edge centre and Face centre: the target nearest the mouse is found on the
  // other objects, the parts of the edited shape that are not moving and the box, and the moving point closest to it lands exactly on it.
  const snapAct = (cur) => S.snapV || (S.snapOn !== !!(cur && cur.ctrl));
  const snapMode = () => S.snapV ? 'vertex' : S.snapTo;
  function snapTargets(t, mode) {
    t._tg = t._tg || {}; if (t._tg[mode]) return t._tg[mode];
    const out = [], moving = t.edit ? new Set(t.vs) : null;
    const add = (o, idx) => { const p = [0, 0, 0]; idx.forEach((i) => { for (let k = 0; k < 3; k++) p[k] += o.mesh.v[i][k] / idx.length; }); out.push(worldOfLocal(o, p)); };
    for (const o of objs) {
      if (!t.edit && t.list.includes(o)) continue;
      if (o.kind !== 'mesh' || !o.mesh) { if (mode === 'vertex') out.push(o.target.clone()); continue; }
      o.group.updateMatrixWorld(true);
      const mine = t.edit && o === t.o, free = (idx) => !mine || idx.every((i) => !moving.has(i));
      if (mode === 'vertex') o.mesh.v.forEach((q, i) => { if (free([i])) out.push(worldOfLocal(o, q)); });
      else if (mode === 'edge') meshEdges(o.mesh).forEach((e) => { if (free([e.a, e.b])) add(o, [e.a, e.b]); });
      else o.mesh.f.forEach((f) => { if (free(f)) add(o, f); });
    }
    const X = [b.x0, b.x1], Y = [b.y0, b.y1], Z = [b.z0, b.z1], cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
    if (mode === 'vertex') { for (const x of X) for (const y of Y) for (const z of Z) out.push(new THREE.Vector3(x, y, z)); }
    else if (mode === 'edge') { for (const y of Y) for (const z of Z) out.push(new THREE.Vector3(cx, y, z)); for (const x of X) for (const z of Z) out.push(new THREE.Vector3(x, cy, z)); for (const x of X) for (const y of Y) out.push(new THREE.Vector3(x, y, cz)); }
    else { for (const x of X) out.push(new THREE.Vector3(x, cy, cz)); for (const y of Y) out.push(new THREE.Vector3(cx, y, cz)); for (const z of Z) out.push(new THREE.Vector3(cx, cy, z)); }
    t._tg[mode] = out; return out;
  }
  function snapSources(t) {   // the moving points where the move started, in world space
    if (t._src) return t._src;
    const srcs = [];
    if (t.edit) { t.o.group.updateMatrixWorld(true); t.orig.forEach((q) => srcs.push(worldOfLocal(t.o, q))); }
    else t.list.forEach((o, k) => {
      const q = t.orig[k], P0 = new THREE.Vector3(q.x, q.y, q.z);
      if (o.kind === 'mesh' && o.mesh) { const R = eulerMat(q.rx, q.yaw, q.rz); o.mesh.v.forEach((v0) => { const v = [v0[0] * q.sx, v0[1] * q.sy, v0[2] * q.sz]; srcs.push(new THREE.Vector3(R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]).add(P0)); }); }
      srcs.push(P0);
    });
    t._src = srcs; return srcs;
  }
  function snapMove(t, d, ax, mode) {
    const r = cr();
    let best = null, bd = 40, bz = 2;   // nearest on screen (within 40 px); points within 6 px of each other go to the one nearer the viewer
    for (const p of snapTargets(t, mode)) {
      const q = p.clone().project(camera); if (q.z > 1 || q.z < -1) continue;
      const sx = r.left + (q.x * 0.5 + 0.5) * r.width, sy = r.top + (-q.y * 0.5 + 0.5) * r.height, dd = Math.hypot(sx - lastM.x, sy - lastM.y);
      if (dd > 40) continue;
      if (dd < bd - 6 || (dd < bd + 6 && q.z < bz)) { bd = Math.min(bd, dd); bz = q.z; best = p; }
    }
    t.snapAt = best;
    if (!best) { snapMark.visible = false; return; }
    let src = null, sd = Infinity;
    for (const p of snapSources(t)) { const e2 = p.clone().add(d).distanceToSquared(best); if (e2 < sd) { sd = e2; src = p; } }
    if (!src) return;
    const nd = best.clone().sub(src);
    if (ax && !t.plane) nd.copy(ax).multiplyScalar(nd.dot(ax)); else if (ax && t.plane) nd.addScaledVector(ax, -nd.dot(ax));
    d.copy(nd);
    snapMark.position.copy(best); snapMark.scale.setScalar(S.ortho ? cam.r * 0.012 : camera.position.distanceTo(best) * 0.012); snapMark.visible = true;
  }
  const clampEm = (o, v) => { v.x = clamp(v.x, b.x0 + 0.05, b.x1 - 0.05); v.z = clamp(v.z, b.z0 + 0.05, b.z1 - 0.05); v.y = clamp(v.y, b.y0 + 0.05, Math.max(b.y1 - 0.05, b.y0 + 0.06)); };
  function applyTf() {
    const t = tf;
    if (t.edit) {
      // worked in the object's rotated frame at its real size (points times Scale), then divided by Scale again, so moves, turns and
      // scales of points are true to the view on a scaled object
      const o = t.o, R = eulerMat(o.rx, o.yaw, o.rz), V = o.mesh.v, s = [o.sx || 1, o.sy || 1, o.sz || 1], pv = [t.pivL[0] * s[0], t.pivL[1] * s[1], t.pivL[2] * s[2]];
      const toL = (w) => new THREE.Vector3(R[0] * w.x + R[3] * w.y + R[6] * w.z, R[1] * w.x + R[4] * w.y + R[7] * w.z, R[2] * w.x + R[5] * w.y + R[8] * w.z);
      t.vs.forEach((vi, k) => {
        const q0 = t.orig[k], q = [q0[0] * s[0], q0[1] * s[1], q0[2] * s[2]]; let r;
        if (t.type === 'g') { const dl = toL(t.d); r = [q[0] + dl.x, q[1] + dl.y, q[2] + dl.z]; }
        else if (t.type === 'r') {
          const al = toL(t.rotAxis).normalize(), v = new THREE.Vector3(q[0] - pv[0], q[1] - pv[1], q[2] - pv[2]).applyAxisAngle(al, t.angRad || 0);
          r = [pv[0] + v.x, pv[1] + v.y, pv[2] + v.z];
        } else if (t.type === 'i') { const iv = t.inset[k], d = Math.min(t.dist || 0, iv.max); r = [q[0] + iv.d[0] * d, q[1] + iv.d[1] * d, q[2] + iv.d[2] * d]; }
        else { const M = t._M || (t._M = scaleMatL(R, t.f, useLocalAx())), w = mul3(M, q[0] - pv[0], q[1] - pv[1], q[2] - pv[2]); r = [pv[0] + w[0], pv[1] + w[1], pv[2] + w[2]]; }
        V[vi] = [r[0] / s[0], r[1] / s[1], r[2] / s[2]];
      });
      t._M = null; meshGeo(o); updateOverlay();
    } else {
      const multi = t.list.length > 1, Rd = t.type === 'r' ? new THREE.Matrix4().makeRotationAxis(t.rotAxis || new THREE.Vector3(0, 1, 0), t.angRad || 0) : null;
      t.list.forEach((o, k) => {
        const q = t.orig[k];
        if (t.type === 'g') {
          o.target.set(q.x + t.d.x, q.y + t.d.y, q.z + t.d.z); if (o.kind === 'emitter') clampEm(o, o.target);
        } else if (t.type === 'r') {
          if (multi) { const v = new THREE.Vector3(q.x, q.y, q.z).sub(t.pivot).applyMatrix4(Rd).add(t.pivot); o.target.copy(v); if (o.kind === 'emitter') clampEm(o, o.target); }
          if (o.kind === 'mesh') {
            const M0 = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(q.rx, q.yaw, q.rz, 'ZYX')), M = new THREE.Matrix4().multiplyMatrices(Rd, M0);
            const e = new THREE.Euler().setFromRotationMatrix(M, 'ZYX'); o.rx = e.x; o.yaw = e.y; o.rz = e.z;
          } else {
            const dir = dirOf({ az: q.az, el: q.el }).applyMatrix4(Rd).normalize();
            o.az = Math.atan2(dir.z, dir.x) * R2D; o.el = Math.asin(clamp(dir.y, -1, 1)) * R2D;
          }
        } else {
          if (multi) { o.target.set(t.pivot.x + (q.x - t.pivot.x) * t.f[0], t.pivot.y + (q.y - t.pivot.y) * t.f[1], t.pivot.z + (q.z - t.pivot.z) * t.f[2]); if (o.kind === 'emitter') clampEm(o, o.target); }
          if (o.kind === 'mesh') {   // the object's Scale, along its own axes; a factor along a global axis goes to its own axes by how much each lines up with it
            let lf = t.f;
            if (!(frameObj() ? useLocalAx() : S.orient === 'local')) {
              const R = eulerMat(q.rx, q.yaw, q.rz); lf = [0, 0, 0];
              for (let i = 0; i < 3; i++) for (let a = 0; a < 3; a++) lf[i] += R[a * 3 + i] * R[a * 3 + i] * t.f[a];
            }
            o.sx = clamp(q.sx * lf[0], 0.02, 1000); o.sy = clamp(q.sy * lf[1], 0.02, 1000); o.sz = clamp(q.sz * lf[2], 0.02, 1000);
          }
          else o.radius = clamp(q.radius * t.k, 0.03, 0.5);
        }
        if (!S.playing) o.pos.copy(o.target);
        syncMesh(o);
      });
      refreshFields();
    }
    hud();
  }
  function confirmTf() {
    const t = tf; if (!t) return;
    tf = null; canvas.style.cursor = 'default';
    if (t.edit) {
      shapeChanged(t.o);   // the water sees the new shape once you leave edit mode, play, step or reset (see ensureSDF)
      meshGeo(t.o); edList = meshEdges(t.o.mesh); updateOverlay();
    } else {
      for (const o of t.list) { syncMesh(o); autoKey(o, tfGroups(o, t.type)); }
      updateEst();
    }
    renderUI(); hud();
  }
  function cancelTf() {
    if (!tf) return;
    const t = tf; tf = null; canvas.style.cursor = 'default';
    const keep = t.edit && !t.structural ? { sm: ES.sm, v: new Set(ES.v), e: new Set(ES.e), f: new Set(ES.f) } : null;
    undo(true);   // back to the state saved when the move started
    if (keep && uiMode === 'edit') { ES.sm = keep.sm; ES.v = keep.v; ES.e = keep.e; ES.f = keep.f; updateOverlay(); renderUI(); hud(); }
  }
  // middle click: lock to the axis that lines up best with where the mouse has moved (or, for rotation, the one facing the view)
  function midAxis() {
    const t = tf, pv = toScreen(t.pivot), dx = lastM.x - t.m0.x, dy = lastM.y - t.m0.y;
    let best = null, bs = -1;
    for (const a of ['x', 'y', 'z']) {
      const v = axisVec(a); let sc;
      if (t.type === 'r') sc = Math.abs(v.dot(viewDir()));
      else {
        if (Math.hypot(dx, dy) < 4) return;
        const q = toScreen(t.pivot.clone().add(v)), ax = q.x - pv.x, ay = q.y - pv.y, L = Math.hypot(ax, ay) * Math.hypot(dx, dy) || 1;
        sc = Math.abs(ax * dx + ay * dy) / L;
      }
      if (sc > bs) { bs = sc; best = a; }
    }
    if (t.axis === best && !t.plane) { t.axis = null; t.local = false; } else { t.axis = best; t.plane = false; t.local = false; }
    evalTf();
  }
  function modalKey(e) {
    const k = e.key, K = k.toLowerCase();
    if (k === 'Escape') { e.preventDefault(); cancelTf(); return; }
    if (k === 'Enter') { e.preventDefault(); confirmTf(); return; }
    lastM.ctrl = e.ctrlKey || e.metaKey;
    if ('xyz'.includes(K) && K.length === 1) {
      e.preventDefault();
      if (e.shiftKey) { tf.axis = K; tf.plane = true; tf.local = false; }
      else if (tf.axis === K && !tf.plane) tf.local = !tf.local;
      else { tf.axis = K; tf.plane = false; tf.local = false; }
    } else if (/^[0-9]$/.test(k) || k === '.' || k === ',') { e.preventDefault(); tf.num += k === ',' ? '.' : k; }
    else if (k === '-') { e.preventDefault(); tf.num = tf.num.startsWith('-') ? tf.num.slice(1) : '-' + tf.num; }
    else if (k === 'Backspace') { e.preventDefault(); tf.num = tf.num.slice(0, -1); }
    else if (k === 'Tab') { e.preventDefault(); return; }
    else if (K === 'i' && tf.type === 'i') {   // I again: each face on its own (or back to one region), keeping the inset so far
      e.preventDefault(); const t = tf; tf = null; insetFaces.m0 = t.m0; insetFaces(!t.individual, t.insetBase); insetFaces.m0 = null;
      if (tf) { tf.num = t.num; evalTf(); hud(); } return;
    }
    else return;
    evalTf();
  }

