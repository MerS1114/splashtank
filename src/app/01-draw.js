  // ---------- what is drawn ----------
  // Every view (live, live cache, bake) draws a frame in the cache format: water positions as 16 bits across the box (pos), a speed byte in
  // 16ths of m/s (spd, 255 = gone; caches without spdMs hold 16ths of a scene unit per second) and a white-water byte (fm); whitewater positions and 32-bit codes (sp, see packSpray in flip.js); deep water
  // positions and speed bytes (dp, narrow band look only). A frame goes to the GPU as it is, into integer textures one texel per point and
  // 2048 wide: water from row 0, then deep water, then whitewater. The shaders turn the bytes back into points and make the look-only
  // extras (fixed random offsets from a hash of the point's number), so the CPU never goes over the points one by one.
  // Slots 0 and 6 are the live view and the live cache, used in turn so an upload never rewrites the textures the last draw may still be
  // reading (that made the driver wait). BAKE lists the slots for baked frames: at least five (the two either side of the playhead and up
  // to two ahead), and as many more as the GPU memory budget allows (S.gpuKeepMB), so a dense bake that fits is uploaded once and then
  // plays from the GPU without moving any data (bakeSlots in 09-bake.js).
  const TEXW = 2048, NSLOT = 7;
  const newSlot = () => ({ rows: {}, gl: null, T: null, key: null, used: 0, nW: 0, nD: 0, nS: 0, rowD: 0, rowS: 0, fm: false, b: null, alive: 0 });
  const SLOTS = Array.from({ length: NSLOT }, newSlot);
  const BAKE = [1, 2, 3, 4, 5];
  let liveI = 0;   // the live slot shown now
  function liveLoad(fr, b, key) { liveI = liveI ? 0 : NSLOT - 1; const sl = SLOTS[liveI]; slotLoad(sl, fr, b); sl.key = key; return sl; }
  const perf = { up: 0, upBytes: 0, upN: 0, build: 0, render: 0, frame: 0 };   // milliseconds of the last upload, frame build and draw (for the benchmark)
  // how many points of a frame are really there (counted once per frame)
  function frameAlive(fr, show) {
    if (fr._alive === undefined) {
      let a = 0; const s = fr.spd || fr.sf; for (let i = 0; i < fr.n; i++) if ((s[i] & 255) !== 255) a++;
      if (fr.dp) { const d = fr.dp.spd || fr.dp.sf; for (let i = 0; i < fr.dp.n; i++) if ((d[i] & 255) !== 255) a++; }
      fr._alive = a;
    }
    return fr._alive + (show && fr.sp ? fr.sp.n : 0);
  }
  // the CPU solver's particles as a frame (vs: metres per scene unit, so the speed bytes are in m/s)
  function packCpuFrame(P, Sp, n, b, vs) {
    const k = 16 * (vs || 1);
    const pos = new Uint16Array(n * 3), spd = new Uint8Array(n), kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3; if (P[i3 + 1] < -1e5) { spd[i] = 255; continue; }
      pos[i3] = clamp(Math.round((P[i3] - b.x0) * kx), 0, 65535); pos[i3 + 1] = clamp(Math.round((P[i3 + 1] - b.y0) * ky), 0, 65535); pos[i3 + 2] = clamp(Math.round((P[i3 + 2] - b.z0) * kz), 0, 65535);
      spd[i] = Math.min(191, Sp[i] * k);
    }
    return { n, pos, spd, b };
  }
  let sim = null, runner = null;
  function makeSim() {
    if (typeof lcClear === 'function') lcClear();
    updateDomainViz();
    if (sim && sim.destroy) sim.destroy();
    const o = { d: S.liveD, size: [S.dom.w, S.dom.h, S.dom.d], open: openMask(), ratio: S.cellRatio };
    if (S.engine === 'flip') sim = new FlipSim(S.gpu.dev, Object.assign(o, { maxN: Math.min(PRESET.flip.capMax, Math.max(S.cap, 20000)), out: rawBuf }));
    else if (S.engine === 'gpu') sim = new GpuSim(S.gpu.dev, Object.assign(o, { maxN: Math.min(PRESET.gpu.capMax, Math.max(S.cap, 20000)), out: rawBuf }));
    else sim = new FluidSim(Object.assign(o, { maxN: 16000 }));
    if (isGpu()) sim.rawOut = true;
    if (S.engine === 'flip') { sim.opt.fastAir = S.fastAir; sim.opt.sort = S.sortP; sim.opt.p2gWin = S.p2gWin; sim.opt.ballistic = S.ballistic; sim.opt.settle = S.settle; sim.opt.settleTol = S.settleTol; sim.opt.mg = S.mg; sim.opt.sep = S.sep; sim.opt.apic = S.xfer === 'apic'; sim.setSprayCap(S.sprOn ? S.sprCap : 0); }
    lastGen = -1;
    sim.setCap(S.cap); runner = new SceneRunner(sim);
    if (S.engine === 'flip' && (Math.abs(sim.size[0] - S.dom.w) > 1e-6 || Math.abs(sim.size[1] - S.dom.h) > 1e-6 || Math.abs(sim.size[2] - S.dom.d) > 1e-6)) {
      S.dom.w = sim.size[0]; S.dom.h = sim.size[1]; S.dom.d = sim.size[2]; updateDomainViz(); if (typeof buildBoxUI === 'function') buildBoxUI();
    }
    S.simOrg = Object.assign({}, S.org);
  }
  const isGpu = () => S.engine !== 'cpu';
  function openMask() { const o = S.open; return (o.x0 ? 1 : 0) | (o.x1 ? 2 : 0) | (o.y0 ? 4 : 0) | (o.y1 ? 8 : 0) | (o.z0 ? 16 : 0) | (o.z1 ? 32 : 0); }
  // what the solver gets each step. The scene is in units of S.scale metres, so gravity and every speed in m/s are divided by it; time stays in seconds.
  // how far whitewater may fly past the tank: k times its width and depth (centred), up times its height (S.wwArea, S.wwAreaUp)
  function wwArea() { return { k: Math.max(1, S.wwArea || 1), up: Math.max(1, S.wwAreaUp || 1) }; }
  function simPar() {
    const k = 1 / (S.scale || 1);
    return { g: S.g * k, iters: S.iters, visc: S.visc, flip: S.flip, comp: S.sep > 0 ? 0 : 6, wind: windVec().map((v) => v * k), drag: S.airDrag * k, gust: S.gust * k, foamSens: S.foamSens * k, foamTau: S.foamTau,
      colMax: S.colMax * k, vmax: S.vmaxW * k, scale: S.scale || 1, vs: S.scale || 1, tear: S.tear * 0.5 * Math.pow(S.cellRatio, 3),
      spr: S.sprOn ? { rate: 12 * S.sprAmt, min: S.sprMin, life: S.sprLife, mist: S.sprMist, drag: S.sprDrag, mdrag: S.mistDrag, ww: { foamLife: S.wwFoamLife, rise: S.wwRise * k, crest: S.wwCrest, impact: S.wwImpact, spin: S.wwSpin, edge: S.wwEdge, erode: S.wwErode, land: S.wwLand, trail: S.wwTrail, area: wwArea() } } : null,
      air: S.sprOn && S.airOn ? { on: true, couple: S.airCouple, decay: S.airDecay } : null,
      drip: S.sprOn && S.dripOn ? { on: true, rate: S.dripRate, dry: S.dripDry } : null,
      nb: nbCfg(), ocean: oceanCfg(), time: S.frame * DT };
  }
  const windVec = () => [S.wind.speed * Math.cos(S.wind.az * Math.PI / 180), S.wind.up, S.wind.speed * Math.sin(S.wind.az * Math.PI / 180)];
  function applyOpen() { if (sim.c) sim.c.open = openMask(); else sim.open = openMask(); }
  function applyPreset(eng) {
    const P = PRESET[eng];
    S.engine = eng; S.liveD = P.liveD; S.cap = P.cap; S.iters = P.iters;
    S.bkDetail = eng === 'flip' ? 1 : 2;
  }

