  // ---------- scene objects ----------
  const objs = []; let selected = null, uid = 0; const counters = {};
  const selSet = new Set();
  const GREY = 0x9ba1a7, ACCENT = 0xffc233, EMIT = 0x35d07f, OFF = 0x6c7a72, WIRE = 0x4b5259;
  let uiMode = 'object', editO = null;
  const SHAPE_NAME = { emitter: 'source', cube: 'cube', sphere: 'sphere', cylinder: 'cylinder' };

  function dirOf(o) {
    const az = o.az * Math.PI / 180, el = o.el * Math.PI / 180;
    return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
  }
  const ringGeo = (() => { const p = []; for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; p.push(Math.cos(a), Math.sin(a), 0); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); return g; })();

  function newMesh(shape, p) {
    if (p.mesh) return { v: p.mesh.v.map((q) => q.slice()), f: p.mesh.f.map((q) => q.slice()) };
    if (shape === 'cube') return meshCube(p.hx || 0.3, p.hy || 0.3, p.hz || 0.3);
    if (shape === 'sphere') return meshSphere(p.r || 0.35, 14, 9);
    return meshCylinder(p.r || 0.25, p.hh || 0.3, 16);
  }
  // rebuild the render geometry of a mesh object from o.mesh
  function meshGeo(o) {
    const m = o.mesh, tr = meshTris(m); o.tris = tr;
    const n = tr.t.length / 3, pos = new Float32Array(n * 9), nor = new Float32Array(n * 9), V = m.v;
    for (let i = 0; i < n; i++) {
      const a = V[tr.t[i * 3]], b = V[tr.t[i * 3 + 1]], c = V[tr.t[i * 3 + 2]];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      [a, b, c].forEach((q, k) => { const j = i * 9 + k * 3; pos[j] = q[0]; pos[j + 1] = q[1]; pos[j + 2] = q[2]; nor[j] = nx; nor[j + 1] = ny; nor[j + 2] = nz; });
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    o.solid.geometry.dispose(); o.solid.geometry = g;
    const ed = meshEdges(m), lp = new Float32Array(ed.length * 6);
    ed.forEach((e, i) => { const a = V[e.a], b2 = V[e.b]; lp.set([a[0], a[1], a[2], b2[0], b2[1], b2[2]], i * 6); });
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    o.wire.geometry.dispose(); o.wire.geometry = lg;
  }
  function rebuildSDF(o) { sdfDone(o, buildSDF(o.mesh, 0.025, 0.16)); }
  function sdfDone(o, sd) {
    o.sdf = sd;
    { let c = 0; const D = o.sdf.data; for (let i = 0; i < D.length; i++) if (D[i] < 0) c++; const bb = meshBounds(o.mesh), v = (bb.hi[0] - bb.lo[0]) * (bb.hi[1] - bb.lo[1]) * (bb.hi[2] - bb.lo[2]); o.sdf.fillFrac = v > 1e-9 ? Math.min(1, c * o.sdf.cell ** 3 / v) : 0.6; }
    let r = 0; for (const q of o.mesh.v) r = Math.max(r, Math.hypot(q[0], q[1], q[2])); o.rad = r;
  }
  // After a collider is scaled or reshaped its distance grid is rebuilt in a worker, so the page never stops for it; the solver keeps the old
  // grid for the moment that takes (water volumes are rebuilt at once, since their water is poured from it).
  let sdfWorker = null, sdfSeq = 0; const sdfJobs = new Map();
  function rebuildSDFLater(o) {
    let r = 0; for (const q of o.mesh.v) r = Math.max(r, Math.hypot(q[0], q[1], q[2])); o.rad = Math.max(r, o.rad || 0);
    if (o.water || !sharedSrc) { rebuildSDF(o); return; }
    try {
      if (!sdfWorker) {
        const url = URL.createObjectURL(new Blob([sharedSrc + '\nself.onmessage = (e) => { const m = e.data; const sd = buildSDF(m.mesh, 0.025, 0.16); self.postMessage({ key: m.key, dims: sd.dims, origin: sd.origin, cell: sd.cell, data: sd.data }, [sd.data.buffer]); };'], { type: 'text/javascript' }));
        sdfWorker = new Worker(url);
        sdfWorker.onmessage = (e) => {
          const m = e.data, ob = sdfJobs.get(m.key); sdfJobs.delete(m.key);
          if (!ob || ob.sdfJob !== m.key || !objs.includes(ob)) return;
          sdfDone(ob, { id: SDF_ID++, dims: m.dims, origin: m.origin, cell: m.cell, data: m.data }); updateEst();
        };
        sdfWorker.onerror = () => { sdfWorker = null; for (const ob of sdfJobs.values()) rebuildSDF(ob); sdfJobs.clear(); };
      }
      const key = ++sdfSeq; o.sdfJob = key; sdfJobs.set(key, o);
      sdfWorker.postMessage({ key, mesh: { v: o.mesh.v, f: o.mesh.f } });
    } catch (e) { rebuildSDF(o); }
  }
  function makeObj(shape, p) {
    p = p || {};
    const kind = shape === 'emitter' ? 'emitter' : 'mesh';
    let name = p.name;
    if (!name) { counters[shape] = (counters[shape] || 0) + 1; name = SHAPE_NAME[shape] + counters[shape]; }
    const o = Object.assign({ id: ++uid, kind, shape, name, x: 0, y: 1, z: 0, rx: 0, yaw: 0, rz: 0, spin: 0, rec: null, keys: [] }, p, { kind, shape, name });
    if (p.id) { o.id = p.id; if (p.id > uid) uid = p.id; }
    if (kind === 'emitter') Object.assign(o, { az: 0, el: -30, speed: 4, radius: 0.15, on: true, mode: 'smooth', spread: 0, density: 1, turb: 0 }, p);
    o.pos = new THREE.Vector3(o.x, o.y, o.z); o.target = o.pos.clone();
    const g = new THREE.Group(); o.group = g;
    if (kind === 'mesh') {
      o.mesh = newMesh(shape, p); o.sdf = p.sdf || null;
      o.solid = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: GREY, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      o.wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: WIRE }));
      g.add(o.solid, o.wire); o.pick = o.solid; waterStyle(o);
      meshGeo(o); if (!o.sdf) rebuildSDF(o); else { let r = 0; for (const q of o.mesh.v) r = Math.max(r, Math.hypot(q[0], q[1], q[2])); o.rad = r; }
    } else {
      const handle = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshBasicMaterial({ color: EMIT }));
      o.ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: EMIT }));
      o.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.6, EMIT, 0.13, 0.09);
      g.add(handle, o.ring, o.arrow); o.pick = handle; o.handle = handle;
    }
    o.pick.userData.o = o;
    scene.add(g); objs.push(o); syncMesh(o);
    return o;
  }
  function poseGroup(o) {
    o.group.position.copy(o.pos);
    if (o.kind === 'mesh') o.group.rotation.set(o.rx || 0, o.yaw || 0, o.rz || 0, 'ZYX');
  }
  function syncMesh(o) {
    poseGroup(o);
    const sel = selSet.has(o);
    if (o.kind === 'emitter') {
      const dv = dirOf(o);
      o.ring.scale.setScalar(Math.max(o.radius, 0.01));
      o.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dv);
      o.arrow.setDirection(dv); o.arrow.setLength(0.35 + o.speed * 0.1, 0.13, 0.09);
      o.ring.material.color.setHex(o.on ? EMIT : OFF); o.arrow.setColor(o.on ? EMIT : OFF);
      o.handle.material.color.setHex(sel ? (o === selected ? ACCENT : 0xd09a28) : (o.on ? EMIT : OFF));
    } else {
      o.wire.material.color.setHex(sel ? (o === selected ? ACCENT : 0xd09a28) : WIRE);
      o.solid.material.color.setHex(sel && !(uiMode === 'edit' && o === editO) ? (o === selected ? 0xc9bd9a : 0xb5ad9a) : GREY);   // grey while its shape is edited, as in Blender
    }
  }
  function disposeObj(o) {
    scene.remove(o.group);
    o.group.traverse((c) => { if (c.geometry && c.geometry !== ringGeo) c.geometry.dispose(); if (c.material && c.material.dispose) c.material.dispose(); });
  }
  function removeObj(o, quiet) {
    if (editO === o) exitEdit(true);
    disposeObj(o); objs.splice(objs.indexOf(o), 1); selSet.delete(o);
    if (selected === o) selected = [...selSet].pop() || null;
    if (quiet) return;
    objs.forEach(syncMesh); renderUI(); updateRecInfo(); updateEst(); if (typeof renderKF === 'function') renderKF();
  }
  function clearObjs(keepCounters) {
    if (editO) exitEdit(true);
    while (objs.length) disposeObj(objs.pop());
    selSet.clear(); selected = null; if (!keepCounters) for (const k in counters) counters[k] = 0;
  }
  function select(o, extend) {
    if (uiMode === 'edit' && o !== editO) exitEdit();
    if (!o) { selSet.clear(); selected = null; }
    else if (extend) {
      if (selSet.has(o)) { selSet.delete(o); if (selected === o) selected = [...selSet].pop() || null; } else { selSet.add(o); selected = o; }
    } else { selSet.clear(); selSet.add(o); selected = o; }
    if (!extend) S.selKey = null;
    objs.forEach(syncMesh); renderUI(); if (typeof renderKF === 'function') renderKF(); hud();
  }

  // snapshot of an object for the solver (live) or for a bake description
  function snap(o) {
    return {
      id: o.id, kind: o.kind, x: o.pos.x - S.simOrg.x, y: o.pos.y - S.simOrg.y, z: o.pos.z - S.simOrg.z, rx: o.rx || 0, yaw: o.yaw || 0, rz: o.rz || 0, spin: o.spin, sdf: o.sdf || null,
      az: o.az, el: o.el, speed: o.speed, radius: o.radius, on: o.on, mode: o.mode, spread: o.spread, density: o.density, turb: o.turb, water: o.water
    };
  }

