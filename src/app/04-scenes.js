  // ---------- scenes ----------
  // fills are stored as fractions of the box width and depth so they follow the box size
  let loadingScene = false;   // while a scene is built its water is not poured yet; the restart at the end fills it once
  function fillBox(fx0, fx1, y0, y1, fz0, fz1) {
    S.fills.push({ t: 'box', fx0, fx1, y0, y1, fz0, fz1 }); if (loadingScene) return;
    const f = resolveFills().filter((q) => q.t === 'box').pop(); if (!f) return;
    if (nbActive()) nbSeed(sim, [f], nbCfg(), null, S.frame * DT, S.g / (S.scale || 1), 2); else sim.fillBox(f.x0, f.x1, f.y0, f.y1, f.z0, f.z1);
  }
  function resolveFills() {
    const out = [];
    for (const f of S.fills) {
      if (f.t !== 'box') { out.push(f); continue; }
      const y1 = Math.min(f.y1, S.dom.h);
      if (y1 - f.y0 > 0.01) out.push({ t: 'box', x0: -W / 2 + f.fx0 * W, x1: -W / 2 + f.fx1 * W, y0: f.y0, y1, z0: -Dd / 2 + f.fz0 * Dd, z1: -Dd / 2 + f.fz1 * Dd });
    }
    for (const o of objs) { const v = volRec(o); if (v) out.push(v); }
    return out;
  }
  // a water volume object, as a fill record in solver coordinates
  function volRec(o) {
    if (!o.water) return null;
    ensureSDF(o); if (!o.sdf) return null;
    const R = eulerMat(o.rx, o.yaw, o.rz), ox = S.org.x, oy = S.org.y, oz = S.org.z, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], sx = o.sx || 1, sy = o.sy || 1, sz = o.sz || 1;
    for (const v of o.mesh.v) {
      const q = [v[0] * sx, v[1] * sy, v[2] * sz];
      const w = [R[0] * q[0] + R[1] * q[1] + R[2] * q[2] + o.pos.x - ox, R[3] * q[0] + R[4] * q[1] + R[5] * q[2] + o.pos.y - oy, R[6] * q[0] + R[7] * q[1] + R[8] * q[2] + o.pos.z - oz];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
    }
    return { t: 'vol', sdf: o.sdf, x: o.pos.x - ox, y: o.pos.y - oy, z: o.pos.z - oz, R, s: sizeOf(o), lo, hi };
  }
  function fillNow(o) {
    if (loadingScene) return;
    const v = volRec(o); if (!v) return;
    if (nbActive()) nbSeed(sim, [v], nbCfg(), null, S.frame * DT, S.g / (S.scale || 1), 2); else fillVolume(sim, v);
    updateEst(); if (sim.N >= S.cap - 1) flash('Point limit reached, so the volume is only partly filled. Raise Max points or use a coarser spacing.');
  }
  function waterStyle(o) {
    if (o.kind !== 'mesh') return;
    const m = o.solid.material;
    if (o.water) { m.color.setHex(0x3a9ad9); m.transparent = true; m.opacity = 0.3; m.depthWrite = false; o.wire.material.color.setHex(0x6cc4ff); }
    else { m.color.setHex(GREY); m.transparent = false; m.opacity = 1; m.depthWrite = true; o.wire.material.color.setHex(WIRE); }
    m.needsUpdate = true;
  }
  function applyFills() {
    if (nbActive()) { if (nbSeed(sim, resolveFills(), nbCfg(), oceanCfg(), S.frame * DT, S.g / (S.scale || 1), 1).full) flash('Point limit reached, so the starting water is only partly filled and the rest will drain away. Raise Max points or use a coarser spacing.'); return; }
    for (const f of resolveFills()) { if (f.t === 'box') sim.fillBox(f.x0, f.x1, f.y0, f.y1, f.z0, f.z1); else if (f.t === 'vol') fillVolume(sim, f); else sim.fillSphere(f.x, f.y, f.z, f.r, 0, f.vy || 0, 0); }
  }
  const SCENES = {
    'Wave tank': () => {
      fillBox(0, 1, 0, 0.4, 0, 1);
      makeObj('cube', { x: 0.45, y: 0.55, z: 0.1, hx: 0.3, hy: 0.3, hz: 0.3, yaw: 0.45 });
      makeObj('emitter', { x: -1.25, y: 1.5, z: -0.3, az: 12, el: -32, speed: 4.5, radius: 0.16 });
    },
    'Dam break': () => {
      fillBox(0, 0.32, 0, 1.4, 0, 1);
      makeObj('cube', { x: 0.45, y: 0.45, z: 0, hx: 0.35, hy: 0.45, hz: 0.35, yaw: 0.3 });
      makeObj('sphere', { x: 0.7, y: 0.3, z: 0.9, r: 0.3 });
    },
    'Cascade': () => {
      // after Torc Waterfall: a wide sloping chute between rock walls, a lip, then ledges and a boulder field with whitewater running between the rocks
      let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const A = 0.95, ca = Math.cos(A), sa = Math.sin(A);        // slope angle of the chute, running down towards +x
      const T = [ca, -sa], N = [sa, ca], C = [-0.64, 4.47];        // along the slope, off the slope, chute centre
      const at = (u, v) => ({ x: C[0] + T[0] * u + N[0] * v, y: C[1] + T[1] * u + N[1] * v });
      makeObj('emitter', { x: -1.75, y: 6.95, z: 0, az: 0, el: -20, speed: 1.6, radius: 0.7, turb: 0.7 });   // one wide source
      makeObj('cube', { name: 'backstop', x: -2.3, y: 6.9, z: 0, hx: 0.15, hy: 0.7, hz: 0.95 });
      const ramp = at(0, 0); makeObj('cube', { name: 'chute', x: ramp.x, y: ramp.y, z: 0, hx: 2.3, hy: 0.3, hz: 0.8, rz: -A });
      for (const sg of [-1, 1]) { const p = at(0, 0.7); makeObj('cube', { name: sg < 0 ? 'wallL' : 'wallR', x: p.x, y: p.y, z: sg * 0.95, hx: 2.3, hy: 0.4, hz: 0.15, rz: -A }); }
      for (let i = 0; i < 8; i++) {   // low rough bars across the chute that break the water up into small steps
        const u = -1.7 + i * 0.5 + (rnd() - 0.5) * 0.12, p = at(u, 0.3 + 0.03);
        makeObj('cube', { name: 'bar' + (i + 1), x: p.x, y: p.y, z: (rnd() - 0.5) * 0.15, hx: 0.07, hy: 0.06 + rnd() * 0.06, hz: 0.7, rz: -A + (rnd() - 0.5) * 0.35 });
      }
      makeObj('cube', { name: 'ledge1', x: 1.65, y: 0.8, z: 0, hx: 0.65, hy: 0.8, hz: 1.4 });
      makeObj('cube', { name: 'ledge2', x: 2.75, y: 0.45, z: 0, hx: 0.5, hy: 0.45, hz: 1.4 });
      makeObj('cube', { name: 'ledge3', x: 3.5, y: 0.2, z: 0, hx: 0.3, hy: 0.2, hz: 1.4 });
      for (const sg of [-1, 1]) makeObj('cube', { name: sg < 0 ? 'bankL' : 'bankR', x: 2.4, y: 1.2, z: sg * 1.65, hx: 1.8, hy: 1.2, hz: 0.22 });
      const ground = (x) => (x < 2.3 ? 1.6 : x < 3.25 ? 0.9 : 0.4);
      for (let i = 0; i < 9; i++) {
        const x = 1.2 + rnd() * 2.6, r = 0.2 + rnd() * 0.17;
        makeObj('sphere', { name: 'rock' + (i + 1), x, y: ground(x) + r * 0.55, z: (rnd() - 0.5) * 2.2, r });
      }
      for (let i = 0; i < 6; i++) {
        const x = 1.2 + rnd() * 2.6, hy = 0.15 + rnd() * 0.12;
        makeObj('cube', { name: 'boulder' + (i + 1), x, y: ground(x) + hy * 0.8, z: (rnd() - 0.5) * 2.2, hx: 0.18 + rnd() * 0.14, hy, hz: 0.18 + rnd() * 0.14, yaw: rnd() * 3, rx: (rnd() - 0.5) * 0.5, rz: (rnd() - 0.5) * 0.5 });
      }
    },
    'Ocean': () => {
      const hull = makeObj('cube', { name: 'Hull', x: 0, y: 0.5, z: 0, hx: 0.9, hy: 0.35, hz: 0.45, yaw: 0.4 });
      const K = (t, y) => ({ t, x: 0, y, z: 0, rx: 0, yaw: 0.4, rz: 0 });
      hull.keys = [K(0, 0.5), K(2, 0.5), K(8, 2.55), K(10, 2.55)];   // rises from the sea floor and out through the surface, about 3 m/s
      applyKeysAt(0);
    },
    'Underwater blast': () => {
      // a gas bubble from a blast under the surface: a sphere 0.42 m down swells to 5 times its size in 0.05 s (about 10 m/s at its
      // surface), so it throws the water above it up and breaks the surface, holds, then collapses, and the water rushing back in
      // meets in the middle and jets up
      fillBox(0, 1, 0, 1.4, 0, 1);
      const b = makeObj('sphere', { name: 'Blast', x: 0, y: 0.98, z: 0, r: 0.12 });
      const K = (t, s) => ({ t, sx: s, sy: s, sz: s });
      b.keys = [K(0, 1), K(0.25, 1), K(0.3, 5), K(0.5, 4.6), K(0.75, 1)];
      applyKeysAt(0);
    },
    'Fountain': () => {
      makeObj('emitter', { x: 0, y: 0.12, z: 0, az: 0, el: 90, speed: 6.2, radius: 0.1 });
      makeObj('sphere', { x: 0, y: 1.75, z: 0, r: 0.4 });
    }
  };
  const ALLC = (v) => ({ x0: v, x1: v, y0: v, y1: v, z0: v, z1: v });
  const DEF_CFG = { dom: { w: 3, h: 2.6, d: 3 }, open: ALLC(false) };
  const DEF_PARAMS = { foamSens: 1, foamTau: 1.2, gust: 1, airDrag: 0.3, colMax: 100, vmaxW: 50, subMax: 16, scale: 1 };
  let lastHadParams = false;
  const SCENE_CFG = {
    // a wide tank in narrow band mode (only the water near the surface is particles), so the blast is small next to the sea around it
    'Underwater blast': { dom: { w: 6, h: 4, d: 6 }, open: ALLC(false), linear: true, dur: 3, nb: true, cap: 450000, cam: { theta: 0.6, phi: 1.3, r: 11 } },
    'Cascade': { dom: { w: 7, h: 8, d: 3.6 }, open: ALLC(true), params: { foamSens: 0.6, foamTau: 2.2, gust: 1.5, airDrag: 0.5 }, cam: { theta: 0.6, phi: 1.2, r: 15 } },
    // at scene scale 10: a 60 m patch of open sea, 16 m deep, 3 m waves 40 m long, and an 18 m hull rising out of it
    'Ocean': { dom: { w: 6, h: 3.2, d: 6 }, open: Object.assign(ALLC(false), { y1: true }), params: { foamSens: 0.8, foamTau: 2, gust: 1, airDrag: 0.3, colMax: 300, vmaxW: 200, subMax: 16, scale: 10 },
      cam: { theta: 0.75, phi: 1.15, r: 15 }, dur: 10, nb: true, cap: 450000, ocean: { on: true, height: 3, length: 40, dir: 25, spread: 25, level: 0.5, layer: 0.15, seed: 7 } }
  };
  function loadScene(name) {
    if (typeof SCENE_FILES !== 'undefined' && SCENE_FILES[name]) {   // a preset saved from the app: loaded like a scene file
      applySceneData(JSON.parse(JSON.stringify(SCENE_FILES[name])));
      lcClear(); S.prevStates = null; LC.armed = S.lcOn; LC.staleEnd = 0; lcUi();
      return;
    }
    const cfg = SCENE_CFG[name] || DEF_CFG;
    S.dom = Object.assign({}, cfg.dom); S.min = { x: -cfg.dom.w / 2, y: 0, z: -cfg.dom.d / 2 }; S.open = Object.assign({}, cfg.open);
    if (cfg.params || lastHadParams) Object.assign(S, DEF_PARAMS, cfg.params || {});
    lastHadParams = !!cfg.params;
    S.ocean = Object.assign({}, OCEAN_DEF, cfg.ocean || {}); if (cfg.nb !== undefined) S.nbOn = cfg.nb;
    if (cfg.cap && isGpu()) { S.cap = Math.min(PRESET[S.engine].capMax, Math.max(S.cap, cfg.cap)); $('#capshow').textContent = fmtN(S.cap); }
    if (cfg.waterVol && isGpu()) {   // room for all the starting water at the current spacing, plus a little
      const P = PRESET[S.engine], need = Math.ceil(cfg.waterVol / Math.pow(S.liveD, 3) * 1.05 / 1000) * 1000;
      if (need > S.cap) S.cap = Math.min(P.capMax, need);
      $('#capshow').textContent = fmtN(S.cap);
    }
    S.tl.smooth = !cfg.linear; setSeg($('#kf-interp'), S.tl.smooth ? 'smooth' : 'linear');
    setDur(cfg.dur || 5);
    makeSim(); updateDomainViz(); buildBoxUI(); buildLiveUI();
    cam.target.set(S.org.x, S.org.y + (Hh > 3.5 ? Hh * 0.46 : Hh * 0.27), S.org.z); cam.r = clamp(2.1 * Math.max(W, Dd, Hh * 1.1), 3, 24);
    if (cfg.cam) { cam.theta = cfg.cam.theta; cam.phi = cfg.cam.phi; cam.r = cfg.cam.r; }
    updateCam();
    lcClear(); S.prevStates = null;
    sim.clear(); runner.em = {}; runner.prev = {}; clearObjs(); S.frame = 0; S.fills = []; S.events = []; S.tl.t = 0; S.selKey = null;
    undoStack.length = 0; redoStack.length = 0; if (tf) tf = null;
    loadingScene = true; try { SCENES[name](); } finally { loadingScene = false; }
    resetSim(0);
    const first = objs.find((o) => o.kind === 'emitter') || objs[0] || null;
    selSet.clear(); if (first) selSet.add(first); selected = first;
    objs.forEach(syncMesh); renderUI(); updateRecInfo(); updateEst(); renderKF(); hud(); LC.armed = S.lcOn; LC.staleEnd = 0; lcUi();
  }
  // restart the particles from the initial fills at time t, keeping objects and keyframes
  function resetSim(t) {
    S.vpeak = 0; S.subPeak = 0; S.subHold = 0; S.subHoldT = 0;
    S.lcPlay = false; lcDrop(); LC.armed = S.lcOn && !t; S.prevStates = null;
    sim.clear(); runner.em = {}; runner.prev = {}; S.frame = Math.round((t || 0) * 60); S.tl.t = S.frame / 60;
    applyFills(); S.events.forEach((e) => { e.done = e.t < S.tl.t; if (e.done) return; });
    applyKeysAt(S.tl.t);
  }

  // ---------- undo ----------
  const undoStack = [], redoStack = [];
  function snapScene() {
    return {
      objs: objs.map((o) => ({
        id: o.id, shape: o.shape, name: o.name, x: o.target.x, y: o.target.y, z: o.target.z, px: o.pos.x, py: o.pos.y, pz: o.pos.z,
        rx: o.rx, yaw: o.yaw, rz: o.rz, sx: o.sx, sy: o.sy, sz: o.sz, lockScale: !!o.lockScale, spin: o.spin, az: o.az, el: o.el, speed: o.speed, radius: o.radius, on: o.on, mode: o.mode, spread: o.spread, density: o.density, turb: o.turb, water: o.water,
        mesh: o.mesh ? { v: o.mesh.v.map((q) => q.slice()), f: o.mesh.f.map((q) => q.slice()) } : null, sdf: o.sdf || null, sdfDirty: !!o.sdfDirty,
        keys: o.keys.map((k) => Object.assign({}, k)), rec: o.rec
      })),
      sel: [...selSet].map((o) => o.id), active: selected ? selected.id : null, ui: uiMode, edit: editO ? editO.id : null
    };
  }
  function restoreScene(sn) {
    clearObjs(true);
    for (const d of sn.objs) {
      const o = makeObj(d.shape, Object.assign({}, d, { mesh: d.mesh || undefined }));
      o.pos.set(d.px, d.py, d.pz); o.target.set(d.x, d.y, d.z); o.rec = d.rec; o.keys = d.keys.map((k) => Object.assign({}, k));
    }
    for (const id of sn.sel) { const o = objs.find((q) => q.id === id); if (o) selSet.add(o); }
    selected = objs.find((q) => q.id === sn.active) || [...selSet].pop() || null;
    objs.forEach(syncMesh);
    const eo = sn.edit && objs.find((q) => q.id === sn.edit);
    if (eo) enterEdit(eo, true);
    renderUI(); renderKF(); updateEst(); updateRecInfo(); hud();
  }
  function pushUndo() { lcClear(); undoStack.push(snapScene()); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
  function undo(discard) {
    if (!undoStack.length) { flash('Nothing to undo'); return; }
    if (!discard) redoStack.push(snapScene());
    restoreScene(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) { flash('Nothing to redo'); return; }
    undoStack.push(snapScene()); restoreScene(redoStack.pop());
  }

