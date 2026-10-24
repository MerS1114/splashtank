  // ---------- save / load scene file ----------
  function sceneData() {
    const sn = snapScene();
    return {
      app: 'SplashTank', version: 2, saved: new Date().toISOString(),
      box: { min: S.min, size: S.dom, open: S.open },
      solver: { engine: S.engine, g: S.g, visc: S.visc, iters: S.iters, flip: S.flip, cap: S.cap, wind: S.wind, airDrag: S.airDrag, cellRatio: S.cellRatio, detail: S.detail, gust: S.gust, foamSens: S.foamSens, foam: S.foam, foamTau: S.foamTau, colMax: S.colMax, dragSpeed: S.dragSpeed, vmaxW: S.vmaxW, subMin: S.subMin, subMax: S.subMax, scale: S.scale, tear: S.tear, sprOn: S.sprOn, sprAmt: S.sprAmt, sprMin: S.sprMin, sprLife: S.sprLife, sprMist: S.sprMist, sprDrag: S.sprDrag, mistDrag: S.mistDrag, sprCap: S.sprCap, streak: S.streak, wwFoamLife: S.wwFoamLife, wwRise: S.wwRise, wwCrest: S.wwCrest, wwImpact: S.wwImpact, wwSpin: S.wwSpin, wwEdge: S.wwEdge, wwErode: S.wwErode, wwLand: S.wwLand, wwTrail: S.wwTrail, wwArea: S.wwArea, wwAreaUp: S.wwAreaUp, airOn: S.airOn, airCouple: S.airCouple, airDecay: S.airDecay, dripOn: S.dripOn, dripRate: S.dripRate, dripDry: S.dripDry, nbOn: S.nbOn, nbBand: S.nbBand, nbLook: S.nbLook, oceanView: S.oceanView }, ocean: S.ocean,
      timeline: S.tl, bake: { dur: S.bk.dur, fps: S.bk.fps, detail: S.bkDetail }, fills: S.fills, events: S.events.map((e) => Object.assign({}, e, { done: false })),
      objs: sn.objs.map((d) => Object.assign({}, d, { sdf: null, rec: d.rec ? { start: d.rec.start, arr: Array.from(d.rec.arr) } : null }))
    };
  }
  function applySceneData(d) {
    if (!d || d.app !== 'SplashTank' || !Array.isArray(d.objs)) throw new Error('This is not a SplashTank scene file.');
    const bx = d.box || {}, sv = d.solver || {};
    S.dom = Object.assign({ w: 3, h: 2.6, d: 3 }, bx.size); S.min = Object.assign({ x: -S.dom.w / 2, y: 0, z: -S.dom.d / 2 }, bx.min); S.open = Object.assign(ALLC(false), bx.open);
    for (const k of ['g', 'visc', 'iters', 'flip', 'cap', 'airDrag', 'cellRatio', 'detail', 'gust', 'foamSens', 'foam', 'foamTau', 'colMax', 'dragSpeed', 'vmaxW', 'subMin', 'subMax', 'scale', 'tear', 'sprAmt', 'sprMin', 'sprLife', 'sprMist', 'sprDrag', 'mistDrag', 'sprCap', 'streak', 'wwFoamLife', 'wwRise', 'wwCrest', 'wwImpact', 'wwSpin', 'wwEdge', 'wwErode', 'wwLand', 'wwTrail', 'wwArea', 'wwAreaUp', 'airCouple', 'airDecay', 'dripRate', 'dripDry']) if (typeof sv[k] === 'number') S[k] = sv[k];
    for (const k of ['airOn', 'dripOn']) if (typeof sv[k] === 'boolean') S[k] = sv[k];
    if (typeof sv.sprOn === 'boolean') S.sprOn = sv.sprOn;
    if (typeof sv.nbOn === 'boolean') S.nbOn = sv.nbOn; if (typeof sv.nbBand === 'number') S.nbBand = sv.nbBand; if (typeof sv.oceanView === 'boolean') S.oceanView = sv.oceanView; if (typeof sv.nbLook === 'boolean') S.nbLook = sv.nbLook;
    S.ocean = Object.assign({}, OCEAN_DEF, d.ocean || {});
    if (sv.wind) S.wind = Object.assign({ speed: 0, az: 0, up: 0 }, sv.wind);
    if (d.timeline) { Object.assign(S.tl, d.timeline); $('#kf-dur').value = S.tl.dur; setSeg($('#kf-interp'), S.tl.smooth ? 'smooth' : 'linear'); setSeg($('#kf-end'), S.tl.end); $('#kf-auto').checked = S.tl.auto !== false; }
    if (d.bake) { if (d.bake.dur) S.bk.dur = d.bake.dur; if (d.bake.fps) S.bk.fps = d.bake.fps; if (d.bake.detail) S.bkDetail = d.bake.detail; }
    LC.staleEnd = 0;
    S.fills = d.fills || []; S.events = d.events || [];
    makeSim(); updateDomainViz();
    sim.clear(); runner.em = {}; runner.prev = {}; clearObjs(); S.frame = 0; S.tl.t = 0; S.selKey = null;
    undoStack.length = 0; redoStack.length = 0; tf = null;
    restoreScene({ objs: d.objs.map((o) => Object.assign({ px: o.x, py: o.y, pz: o.z, keys: [] }, o, { keys: o.keys || [] })), sel: [], active: null });
    const first = objs.find((o) => o.kind === 'emitter') || objs[0] || null;
    selSet.clear(); if (first) selSet.add(first); selected = first;
    pmat.uniforms.uFoam.value = S.foam;
    buildBoxUI(); buildLiveUI(); buildBakeUI(); $('#capshow').textContent = fmtN(S.cap);
    frameAll(); resetSim(0); renderUI(); updateRecInfo(); updateEst(); renderKF(); hud();
  }
  function saveSceneFile() {
    const blob = new Blob([JSON.stringify(sceneData())], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'splashtank-scene.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    flash('Scene saved as splashtank-scene.json (in your Downloads folder).');
  }
  $('#btn-save-scene').addEventListener('click', (e) => { e.currentTarget.blur(); saveSceneFile(); });
  $('#scene-file').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    f.text().then((t) => { try { applySceneData(JSON.parse(t)); flash('Loaded ' + f.name); } catch (err) { flash('Could not load that file: ' + err.message); } });
  });
  window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveSceneFile(); } });

