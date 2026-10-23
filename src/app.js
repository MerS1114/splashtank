(function () {
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const PRESET = {
    gpu: { liveD: 0.06, cap: 60000, iters: 3, capMax: 250000, dMin: 0.03, bk: { d: 0.04, sub: 3, iters: 3, maxN: 400000 }, bkMax: 1500000, bkDMin: 0.02 },
    flip: { liveD: 0.04, cap: 120000, iters: 30, capMax: 4000000, dMin: 0.01, bk: { d: 0.025, sub: 2, iters: 60, maxN: 1000000 }, bkMax: 3000000, bkDMin: 0.012 },
    cpu: { liveD: 0.12, cap: 6000, iters: 2, capMax: 14000, dMin: 0.07, bk: { d: 0.06, sub: 3, iters: 3, maxN: 80000 }, bkMax: 200000, bkDMin: 0.03 }
  };
  const S = {
    playing: false, fastAir: false, sortP: true, colMax: 100, dragSpeed: 20, vmaxW: 50, subMin: 1, subMax: 16, scale: 1, tear: 0.5, sprOn: true, sprAmt: 2, sprMin: 2.5, sprLife: 1.2, sprMist: 0.3, sprDrag: 1, mistDrag: 5, sprCap: 600000, streak: 0.02, wwFoamLife: 3, wwRise: 0.4, wwCrest: 1, wwImpact: 0.25, airOn: true, airCouple: 3, airDecay: 0.6, dripOn: true, dripRate: 2, dripDry: 3, sprDetail: 4, gizmo: false, snapV: false, snapOn: false, snapTo: 'vertex', orient: 'global', colorBy: 'speed', nbLook: false, ortho: false, lcOn: true, lcBudget: 2048, lcPlay: false, lcT: 0, g: 9.8, iters: 2, visc: 0.04, cap: 6000, liveD: 0.12, psize: 0.85, vmax: 5,
    frame: 0, drag: 'floor', bg: 'grey', shift: false, rec: false, ms: 0,
    tab: 'live', fills: [], events: [], engine: 'cpu', gpu: null, flip: 0.95,
    dom: { w: 3, h: 2.6, d: 3 }, min: { x: -1.5, y: 0, z: -1.5 }, org: { x: 0, y: 0, z: 0 }, simOrg: { x: 0, y: 0, z: 0 },
    open: { x0: false, x1: false, y0: false, y1: false, z0: false, z1: false },
    wind: { speed: 0, az: 0, up: 0 }, airDrag: 0.3, cellRatio: 2, detail: 0, gust: 1.0, foamSens: 1.0, foam: 0.8, foamTau: 1.2, handles: true,
    tl: { dur: 5, t: 0, auto: true, smooth: true, end: 'hold' }, selKey: null,
    bk: { dur: 5, fps: 24 }, bkDetail: 1,
    nbOn: false, nbBand: 3, oceanView: true,
    ocean: { on: false, height: 2, length: 30, dir: 0, spread: 25, level: 0.5, layer: 0.15, seed: 1 },
    baking: false, cache: null, cplay: true, ct: 0, cloop: true, cspeed: 1
  };
  const S0 = JSON.parse(JSON.stringify(S));   // the app's defaults, for bold labels and Reset to default
  const lsGet = (k) => { try { return localStorage.getItem('splashtank.' + k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem('splashtank.' + k, v); } catch (e) { /* storage blocked */ } };
  // default value of a setting: the solver preset for resolution, otherwise what the app starts with
  function dv(k) {
    const P = PRESET[S.engine] || PRESET.flip;
    if (k === 'liveD') return P.liveD; if (k === 'cap') return P.cap; if (k === 'iters') return P.iters;
    return k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), S0);
  }
  var layState = { ptab: 'sim', livePtab: 'sim', rw: 360, oh: 190, kfh: 96 };   // panel layout (var: read by applyMode before the layout code runs)
  let hoverRow = null, clipVal = null;   // the setting under the mouse, and the copied value
  const DT = 1 / 60;
  const OCEAN_DEF = { on: false, height: 2, length: 30, dir: 0, spread: 25, level: 0.5, layer: 0.15, seed: 1 };
  // the ocean in solver units (the scene is in units of S.scale metres): wave height and length, the still water level and the boundary width
  function oceanCfg() {
    const o = S.ocean; if (!o.on || S.engine !== 'flip') return null;
    const k = 1 / (S.scale || 1);
    return { on: true, height: o.height * k, length: o.length * k, dir: o.dir, spread: o.spread, seed: o.seed | 0, level: o.level * S.dom.h, layer: o.layer * Math.min(S.dom.w, S.dom.d) };
  }
  const nbActive = () => S.engine === 'flip' && (S.nbOn || S.ocean.on);
  function nbCfg() { return nbActive() ? { on: true, band: S.nbBand } : null; }
  const rBuf = new Float32Array(3000000 * 4);   // x, y, z, speed per particle, what is drawn
  const rawBuf = new Float32Array(1500000 * 4 + 4);   // the GPU readback lands here first
  let lastGen = -1, lastK = -1, lastCount = 0;
  // look-only points: extra points around every simulated one. They move with it and cost nothing in the solver.
  const LOOK = new Float32Array(4096 * 3);
  { let sd = 12345; const r = () => { sd = (sd * 16807) % 2147483647; return (sd - 1) / 2147483646; };
    for (let i = 0; i < 4096; i++) { let x, y, z; do { x = r() * 2 - 1; y = r() * 2 - 1; z = r() * 2 - 1; } while (x * x + y * y + z * z > 1); LOOK[i * 3] = x; LOOK[i * 3 + 1] = y; LOOK[i * 3 + 2] = z; } }
  function putPts(n, i, x, y, z, w4, K, rad) {
    const cap = rBuf.length / 4; if (n + K + 1 > cap) return n;
    let k4 = n * 4; rBuf[k4] = x; rBuf[k4 + 1] = y; rBuf[k4 + 2] = z; rBuf[k4 + 3] = w4; n++;
    for (let c = 0; c < K; c++) {
      const t = ((i * 7 + c * 131 + (i >> 3) * 17) & 4095) * 3; k4 = n * 4;
      rBuf[k4] = x + LOOK[t] * rad; rBuf[k4 + 1] = y + LOOK[t + 1] * rad; rBuf[k4 + 2] = z + LOOK[t + 2] * rad; rBuf[k4 + 3] = w4; n++;
    }
    return n;
  }
  // a whitewater point from its packed form (see packSpray in flip.js): spray as short streaks, mist as wide puffs,
  // foam as flat patches on the surface that thin out as it ages, bubbles as small specks
  function putSpray(n, x, y, z, pk, i, cell) {
    const K = S.sprDetail | 0; if (n + 4 + K > rBuf.length / 4) return n;
    const kc = (pk >>> 29) & 3, spd = ((pk >>> 21) & 255) / 4;
    if (kc === 1 || kc === 3) {
      const foam = kc === 1, life = (pk & 1023) / 1023, code = (foam ? 6144 : 7168) + Math.round(life * 63);
      let k4 = n * 4; rBuf[k4] = x; rBuf[k4 + 1] = y; rBuf[k4 + 2] = z; rBuf[k4 + 3] = code; n++;
      if (K > 0) {
        const rad = (cell || 0.08) * (foam ? 0.5 + 0.5 * life : 0.25), flat = foam ? 0.12 : 1, ii = (i | 0) * 3 + 11;
        for (let c = 0, KK = foam ? Math.ceil(K / 2) : Math.min(K, 2); c < KK; c++) {
          const tt = ((ii * 7 + c * 131 + (ii >> 3) * 17) & 4095) * 3; k4 = n * 4;
          rBuf[k4] = x + LOOK[tt] * rad; rBuf[k4 + 1] = y + LOOK[tt + 1] * rad * flat; rBuf[k4 + 2] = z + LOOK[tt + 2] * rad; rBuf[k4 + 3] = code; n++;
        }
      }
      return n;
    }
    const mist = kc === 2;
    const u = (pk & 1023) / 1023 * 2 - 1, w = ((pk >>> 10) & 1023) / 1023 * 2 - 1;
    let nx = u, ny = w; const nz = 1 - Math.abs(u) - Math.abs(w);
    if (nz < 0) { nx = (1 - Math.abs(w)) * (u >= 0 ? 1 : -1); ny = (1 - Math.abs(u)) * (w >= 0 ? 1 : -1); }
    const l = Math.hypot(nx, ny, nz) || 1, code = mist ? 3072 : 2048;
    const L = mist ? 0 : Math.min(spd * S.streak, 0.6), M = L > 0.004 ? 3 : 1;
    for (let m = 0; m < M; m++) {
      const t = M > 1 ? (m / (M - 1)) * L / l : 0, k4 = n * 4;
      rBuf[k4] = x - nx * t; rBuf[k4 + 1] = y - ny * t; rBuf[k4 + 2] = z - nz * t; rBuf[k4 + 3] = code; n++;
    }
    // look-only points for spray: a small cloud around each one (along its streak), a wider puff for mist. Drawing only.
    if (K > 0) {
      const rad = (cell || 0.08) * (mist ? 1.6 : 0.55), ii = (i | 0) + (pk & 4095);
      for (let c = 0; c < K; c++) {
        const tt = ((ii * 7 + c * 131 + (ii >> 3) * 17) & 4095) * 3, along = ((c * 0.618034 + (ii & 255) / 256) % 1) * L / l, k4 = n * 4;
        rBuf[k4] = x - nx * along + LOOK[tt] * rad; rBuf[k4 + 1] = y - ny * along + LOOK[tt + 1] * rad; rBuf[k4 + 2] = z - nz * along + LOOK[tt + 2] * rad; rBuf[k4 + 3] = code; n++;
      }
    }
    return n;
  }
  function expandLook(src, n, K, rad) {
    const U = new Uint32Array(src.buffer, src.byteOffset, src.length);
    let w = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 4; if (src[k + 1] < -1e5) continue;
      if (U[k + 3] >= 0x80000000) { if (S.showSpray !== false) w = putSpray(w, src[k], src[k + 1], src[k + 2], U[k + 3], i, 2 * rad); continue; }
      if (src[k + 3] >= 4096) { w = putPts(w, i, src[k], src[k + 1], src[k + 2], src[k + 3], DEEP_K, rad * S.cellRatio); continue; }   // deep water point (narrow band, look only): fills its cell
      w = putPts(w, i, src[k], src[k + 1], src[k + 2], src[k + 3], K, rad);
    }
    return w;
  }
  // deep water points (narrow band, look only) are drawn with a few look-only points spread through their cell
  const DEEP_K = 4;
  function putDeepSet(dp, b, n, half) {
    if (!dp || !dp.n) return n;
    const qx = (b.x1 - b.x0) / 65535, qy = (b.y1 - b.y0) / 65535, qz = (b.z1 - b.z0) / 65535;
    for (let i = 0; i < dp.n; i++) n = putPts(n, i, dp.pos[i * 3] * qx + b.x0, dp.pos[i * 3 + 1] * qy + b.y0, dp.pos[i * 3 + 2] * qz + b.z0, 4096 + dp.spd[i] / 16, DEEP_K, half);
    return n;
  }
  // spray stored in a cache frame
  function putSpraySet(sp, b, n, cell) {
    if (!sp || S.showSpray === false) return n;
    const qx = (b.x1 - b.x0) / 65535, qy = (b.y1 - b.y0) / 65535, qz = (b.z1 - b.z0) / 65535;
    for (let i = 0; i < sp.n; i++) n = putSpray(n, sp.pos[i * 3] * qx + b.x0, sp.pos[i * 3 + 1] * qy + b.y0, sp.pos[i * 3 + 2] * qz + b.z0, sp.pk[i], i, cell);
    return n;
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
    if (S.engine === 'flip') { sim.opt.fastAir = S.fastAir; sim.opt.sort = S.sortP; sim.setSprayCap(S.sprOn ? S.sprCap : 0); }
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
  function simPar() {
    const k = 1 / (S.scale || 1);
    return { g: S.g * k, iters: S.iters, visc: S.visc, flip: S.flip, comp: 6, wind: windVec().map((v) => v * k), drag: S.airDrag * k, gust: S.gust * k, foamSens: S.foamSens * k, foamTau: S.foamTau,
      colMax: S.colMax * k, vmax: S.vmaxW * k, scale: S.scale || 1, vs: S.scale || 1, tear: S.tear * 0.5 * Math.pow(S.cellRatio, 3),
      spr: S.sprOn ? { rate: 12 * S.sprAmt, min: S.sprMin, life: S.sprLife, mist: S.sprMist, drag: S.sprDrag, mdrag: S.mistDrag, ww: { foamLife: S.wwFoamLife, rise: S.wwRise * k, crest: S.wwCrest, impact: S.wwImpact } } : null,
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

  // ---------- three.js ----------
  const stage = $('#stage'), canvas = $('#gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const perspCam = new THREE.PerspectiveCamera(40, 1, 0.1, 60), orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  let camera = perspCam, viewAspect = 1, viewH = 1;
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(2, 5, 3); scene.add(sun);

  const cam = { theta: 0.8, phi: 1.0, r: 6.2, target: new THREE.Vector3(0, 0.7, 0) };
  function updateCam() {
    const sp = Math.sin(cam.phi), dx = sp * Math.sin(cam.theta), dy = Math.cos(cam.phi), dz = sp * Math.cos(cam.theta);
    perspCam.position.set(cam.target.x + cam.r * dx, cam.target.y + cam.r * dy, cam.target.z + cam.r * dz); perspCam.lookAt(cam.target);
    // orthographic: the same view, as wide as the perspective view is at the target, seen from far away so nothing is cut off
    const hh = cam.r * Math.tan(20 * Math.PI / 180), D = 150;
    orthoCam.left = -hh * viewAspect; orthoCam.right = hh * viewAspect; orthoCam.top = hh; orthoCam.bottom = -hh; orthoCam.updateProjectionMatrix();
    orthoCam.position.set(cam.target.x + D * dx, cam.target.y + D * dy, cam.target.z + D * dz); orthoCam.lookAt(cam.target);
    try { pmat.uniforms.uOrtho.value = S.ortho ? viewH / (2 * hh) : 0; } catch (e) { /* the point material is made a few lines later */ }
  }
  function setOrtho(on) { S.ortho = !!on; camera = S.ortho ? orthoCam : perspCam; updateCam(); }

  const geo = new THREE.BufferGeometry();
  const ibuf = new THREE.InterleavedBuffer(rBuf, 4); ibuf.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', new THREE.InterleavedBufferAttribute(ibuf, 3, 0));
  geo.setAttribute('speed', new THREE.InterleavedBufferAttribute(ibuf, 1, 3));
  geo.setDrawRange(0, 0);
  function uploadParticles(n) { geo.setDrawRange(0, n); ibuf.updateRange.offset = 0; ibuf.updateRange.count = n * 4; ibuf.needsUpdate = true; }
  // the points. speed holds the kind: below 1024 water (speed + 64 x white water level), 2048 spray, 3072 mist, 4096 + speed a deep water point (narrow band, look only).
  // Colour by Speed runs blue to cyan to white with speed and draws churned water white; Colour by Type gives each kind its own colour, as in Houdini.
  // kinds by the speed attribute: below 1024 water (speed + 64 x white-water level), 2048 spray, 3072 mist, 4096 + speed deep water (narrow band),
  // 6144 + life foam, 7168 + life bubbles (life 0 to 63, how much is left)
  const TYPE_COL = { water: [0.16, 0.46, 0.96], churn: [0.55, 0.85, 0.97], foam: [0.98, 0.98, 0.98], spray: [1.0, 0.6, 0.16], mist: [0.86, 0.56, 1.0], deep: [0.07, 0.2, 0.52], bubble: [0.25, 0.85, 0.6] };
  const v3 = (c) => 'vec3(' + c.map((x) => x.toFixed(3)).join(',') + ')';
  const pmat = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 0.1 }, uScale: { value: 600 }, uMax: { value: S.vmax }, uFoam: { value: S.foam }, uOrtho: { value: 0 }, uMode: { value: 0 } },
    vertexShader: 'attribute float speed; uniform float uSize; uniform float uScale; uniform float uFoam; uniform float uOrtho; varying float vS; varying float vF; varying float vK; varying float vL;' +
      'void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;' +
      ' vK = speed >= 7168.0 ? 5.0 : (speed >= 6144.0 ? 4.0 : (speed >= 4096.0 ? 3.0 : (speed >= 3072.0 ? 2.0 : (speed >= 2048.0 ? 1.0 : 0.0))));' +
      ' float sp = vK > 4.5 ? speed - 7168.0 : (vK > 3.5 ? speed - 6144.0 : (vK > 2.5 ? speed - 4096.0 : speed)); float lv = vK > 2.5 ? 0.0 : floor(sp / 64.0 + 0.01); vS = sp - lv * 64.0; vL = lv / 15.0; vF = vL * uFoam;' +
      ' float life = clamp(vS / 63.0, 0.0, 1.0);' +
      ' float sz = vK > 4.5 ? 0.3 : (vK > 3.5 ? 0.34 * (0.6 + 0.4 * life) : (vK > 2.5 ? 1.3 : (vK > 1.5 ? 0.6 : (vK > 0.5 ? 0.42 : 1.0 - 0.3 * vF))));' +
      ' gl_PointSize = max((uOrtho > 0.0 ? uSize * uOrtho : uSize * uScale / (-mv.z)) * sz, (vK > 0.5 && vK < 2.5) || vK > 3.5 ? 1.0 : 1.5); }',
    fragmentShader: 'uniform float uMax; uniform float uMode; varying float vS; varying float vF; varying float vK; varying float vL;' +
      'vec3 ramp(float t){ vec3 a = vec3(0.03,0.12,0.95); vec3 b = vec3(0.0,0.82,0.98); vec3 c = vec3(1.0); return t < 0.5 ? mix(a,b,t*2.0) : mix(b,c,(t-0.5)*2.0); }' +
      'void main(){ vec2 p = gl_PointCoord*2.0-1.0; float r2 = dot(p,p); if(r2 > 1.0) discard; float sh = 0.78+0.22*(1.0-r2);' +
      ' if (vK > 4.5) { gl_FragColor = vec4((uMode > 0.5 ? ' + v3(TYPE_COL.bubble) + ' : vec3(0.72,0.88,0.96))*sh,1.0); return; }' +
      ' if (vK > 3.5) { float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453); if (h > 0.3 + 0.6 * clamp(vS / 63.0, 0.0, 1.0)) discard;' +
      '   gl_FragColor = vec4((uMode > 0.5 ? ' + v3(TYPE_COL.foam) + ' : vec3(0.9,0.94,0.97))*(0.84+0.16*(1.0-r2)),1.0); return; }' +
      ' if (vK > 1.5 && vK < 2.5) { float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453); if (h > 0.28) discard;' +
      '   gl_FragColor = vec4((uMode > 0.5 ? ' + v3(TYPE_COL.mist) + ' : vec3(0.84,0.89,0.94))*(0.9+0.1*(1.0-r2)),1.0); return; }' +
      ' if (vK > 0.5 && vK < 1.5) { gl_FragColor = vec4((uMode > 0.5 ? ' + v3(TYPE_COL.spray) + ' : vec3(0.95,0.98,1.0))*(0.86+0.14*(1.0-r2)),1.0); return; }' +
      ' if (uMode > 0.5) { vec3 c = vK > 2.5 ? ' + v3(TYPE_COL.deep) + ' : (vL > 0.3 ? ' + v3(TYPE_COL.churn) + ' : ' + v3(TYPE_COL.water) + '); gl_FragColor = vec4(c*sh,1.0); return; }' +
      ' float t = clamp(vS/uMax,0.0,1.0); vec3 col = vK > 2.5 ? ramp(t)*0.82 : mix(ramp(t), vec3(0.97,0.99,1.0), vF); gl_FragColor = vec4(col*sh,1.0); }'
  });
  const points = new THREE.Points(geo, pmat); points.frustumCulled = false; scene.add(points);

  // the ocean around the box: a grid of look-only points on the wave surface, worked out on the GPU from the same waves the solver uses.
  // It covers the boundary at the sides (which holds no particles) and runs out past the box; the inside of the box is the simulated water.
  const OV_RES = 400;
  const oceanGeo = new THREE.BufferGeometry();
  { const a = new Float32Array(OV_RES * OV_RES * 3); for (let j = 0; j < OV_RES; j++) for (let i = 0; i < OV_RES; i++) { const k = (j * OV_RES + i) * 3; a[k] = i; a[k + 2] = j; } oceanGeo.setAttribute('position', new THREE.BufferAttribute(a, 3)); }
  const oceanMat = new THREE.ShaderMaterial({
    uniforms: { uW: { value: Array.from({ length: 48 }, () => new THREE.Vector4()) }, uN: { value: 0 }, uT: { value: 0 }, uLevel: { value: 0 }, uBox: { value: new THREE.Vector4() }, uLayer: { value: 0 },
      uOrg: { value: new THREE.Vector2() }, uStep: { value: 0.1 }, uRes: { value: 2 }, uSize: { value: 0.1 }, uScale: { value: 600 }, uOrtho: { value: 0 }, uMax: { value: 5 } },
    vertexShader: 'uniform vec4 uW[48]; uniform float uN; uniform float uT; uniform float uLevel; uniform vec4 uBox; uniform float uLayer; uniform vec2 uOrg; uniform float uStep; uniform float uRes;' +
      ' uniform float uSize; uniform float uScale; uniform float uOrtho; varying float vS;' +
      ' void main(){ if (position.x >= uRes || position.z >= uRes) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }' +
      ' vec2 xz = uOrg + position.xz * uStep;' +
      ' float dw = min(min(xz.x - uBox.x, uBox.y - xz.x), min(xz.y - uBox.z, uBox.w - xz.y));' +
      ' if (dw > 0.5 * uLayer) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }' +
      ' float eta = uLevel; vec3 v = vec3(0.0);' +
      ' for (int k = 0; k < 24; k++) { if (float(k) >= uN) break; vec4 A = uW[2 * k]; vec4 B = uW[2 * k + 1];' +
      '  float th = A.x * xz.x + A.y * xz.y - A.w * uT + B.x; float c = cos(th); float s = sin(th); eta += A.z * c; float aw = A.z * A.w; v.xz += aw * c * A.xy / max(B.y, 1e-4); v.y += aw * s; }' +
      ' vec4 mv = modelViewMatrix * vec4(xz.x, eta, xz.y, 1.0); gl_Position = projectionMatrix * mv; vS = length(v);' +
      ' gl_PointSize = max(uOrtho > 0.0 ? uSize * uOrtho : uSize * uScale / (-mv.z), 1.5); }',
    fragmentShader: 'uniform float uMax; varying float vS;' +
      'vec3 ramp(float t){ vec3 a = vec3(0.03,0.12,0.95); vec3 b = vec3(0.0,0.82,0.98); vec3 c = vec3(1.0); return t < 0.5 ? mix(a,b,t*2.0) : mix(b,c,(t-0.5)*2.0); }' +
      'void main(){ vec2 p = gl_PointCoord*2.0-1.0; float r2 = dot(p,p); if(r2 > 1.0) discard; float t = clamp(vS/uMax,0.0,1.0); gl_FragColor = vec4(ramp(t)*(0.74+0.2*(1.0-r2)),1.0); }'
  });
  const oceanPts = new THREE.Points(oceanGeo, oceanMat); oceanPts.frustumCulled = false; oceanPts.visible = false; scene.add(oceanPts);
  let oceanViewKey = '', oceanViewW = null;
  function oceanUpdate(mode) {
    let cfg = null, t = 0, b = null, org = null, d = S.liveD, g = S.g / (S.scale || 1), sc = S.scale || 1;
    if (mode === 'cache') { const c = S.cache; cfg = c.desc && c.desc.ocean; t = S.ct / c.fps; b = c.b; org = c.org || S.org; d = c.d; if (c.desc && c.desc.g) g = c.desc.g; sc = c.scale || 1; }
    else if (S.lcPlay) { cfg = oceanCfg(); t = S.lcT / 60; b = LC.b; org = LC.org; d = LC.d; }
    else { cfg = oceanCfg(); t = S.frame * DT; b = sim && sim.b; org = S.simOrg; }
    const on = !!(cfg && cfg.on && S.oceanView && b && org);
    oceanPts.visible = on; if (!on) return;
    const key = JSON.stringify(cfg) + '|' + g + '|' + b.y0;
    if (key !== oceanViewKey) { oceanViewKey = key; oceanViewW = oceanWaves(cfg, g, cfg.level - b.y0); }
    const W = oceanViewW, u = oceanMat.uniforms;
    for (let k = 0; k < 24; k++) { const j = k * 8; u.uW.value[2 * k].set(W.w[j], W.w[j + 1], W.w[j + 2], W.w[j + 3]); u.uW.value[2 * k + 1].set(W.w[j + 4], W.w[j + 5], 0, 0); }
    const bw = b.x1 - b.x0, bd = b.z1 - b.z0, ext = 0.75 * Math.max(bw, bd), L = Math.max(bw, bd) + 2 * ext;
    const res = clamp(Math.ceil(L / (1.4 * d)), 64, OV_RES), step = L / (res - 1);
    u.uN.value = W.n; u.uT.value = t; u.uLevel.value = cfg.level; u.uBox.value.set(b.x0, b.x1, b.z0, b.z1); u.uLayer.value = cfg.layer;
    u.uOrg.value.set((b.x0 + b.x1) / 2 - L / 2, (b.z0 + b.z1) / 2 - L / 2); u.uStep.value = step; u.uRes.value = res;
    u.uSize.value = step * 1.25 * S.psize; u.uScale.value = pmat.uniforms.uScale.value; u.uOrtho.value = pmat.uniforms.uOrtho.value;
    u.uMax.value = S.vmax / sc;
    oceanGeo.setDrawRange(0, OV_RES * res);
    oceanPts.position.set(org.x, org.y, org.z);
  }

  const lineMat = new THREE.LineBasicMaterial({ color: 0x8a949e, transparent: true, opacity: 0.5 });
  const b = { x0: -1.5, x1: 1.5, y0: 0, y1: 2.6, z0: -1.5, z1: 1.5 };
  let W = 3, Hh = 2.6, Dd = 3;
  const tank = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), lineMat);
  scene.add(tank);
  const gridGeo = new THREE.BufferGeometry();
  const gridMat = new THREE.LineBasicMaterial({ color: 0x8a949e, transparent: true, opacity: 0.2 });
  scene.add(new THREE.LineSegments(gridGeo, gridMat));
  const openMat = new THREE.LineBasicMaterial({ color: 0xe0a030 });
  const openLines = [];
  for (let i = 0; i < 6; i++) { const l = new THREE.LineLoop(new THREE.BufferGeometry(), openMat); l.frustumCulled = false; l.visible = false; scene.add(l); openLines.push(l); }
  // face handles: an arrow on every face of the sim box that slides the face along its axis
  const FACES = [
    { k: 'x0', ax: 'x', sgn: -1, col: 0xe0554a }, { k: 'x1', ax: 'x', sgn: 1, col: 0xe0554a },
    { k: 'y0', ax: 'y', sgn: -1, col: 0x6cc24a }, { k: 'y1', ax: 'y', sgn: 1, col: 0x6cc24a },
    { k: 'z0', ax: 'z', sgn: -1, col: 0x4a8fe0 }, { k: 'z1', ax: 'z', sgn: 1, col: 0x4a8fe0 }
  ];
  const handleGrp = new THREE.Group(); scene.add(handleGrp);
  const handleMeshes = [];
  FACES.forEach((f) => {
    const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: f.col, depthTest: false, transparent: true, opacity: 0.95 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 8), mat); shaft.position.y = 0.17;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.32, 14), mat); cone.position.y = 0.5;
    [shaft, cone].forEach((m) => { m.renderOrder = 20; m.userData.face = f; g.add(m); handleMeshes.push(m); });
    const dv = new THREE.Vector3(f.ax === 'x' ? f.sgn : 0, f.ax === 'y' ? f.sgn : 0, f.ax === 'z' ? f.sgn : 0);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dv); f.dir = dv; f.group = g; f.mat = mat; handleGrp.add(g);
  });
  function faceCoord(k) { return b[k]; }
  // coloured lines through the pivot for the axis (or the two axes of a plane) a transform is locked to
  const AXCOL = { x: 0xff3352, y: 0x8bdc00, z: 0x2890ff, n: 0xf0d050 };
  const tfLines = [0, 1].map(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 })); l.renderOrder = 30; l.frustumCulled = false; l.visible = false; scene.add(l); return l; });
  function setTfLine(l, p, d, col) { const a = p.clone().addScaledVector(d, -300), c = p.clone().addScaledVector(d, 300), arr = l.geometry.attributes.position.array; arr.set([a.x, a.y, a.z, c.x, c.y, c.z]); l.geometry.attributes.position.needsUpdate = true; l.material.color.setHex(col); l.visible = true; }
  function updateTfLines() {
    tfLines[0].visible = tfLines[1].visible = false;
    if (!tf || !tf.axis) return;
    const ax = curAxis();
    if (!tf.plane) { setTfLine(tfLines[0], tf.pivot, ax, AXCOL[tf.axis]); return; }
    const others = ['x', 'y', 'z'].filter((q) => q !== tf.axis);
    others.forEach((q, i) => setTfLine(tfLines[i], tf.pivot, axisDir(q), AXCOL[q]));
  }
  // where a snapped move lands
  const snapMark = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffb02e, depthTest: false, transparent: true, opacity: 0.95, wireframe: true }));
  snapMark.renderOrder = 31; snapMark.visible = false; scene.add(snapMark);
  // optional 3D gizmo on the selection: arrows move along an axis, rings rotate about it, small cubes scale along it, the centre ball moves freely
  const gizmo = new THREE.Group(); gizmo.visible = false; scene.add(gizmo);
  const gizParts = [];
  {
    const mk = (geo, col, part, hit) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: hit ? 0 : 0.95, depthWrite: false }));
      m.renderOrder = hit ? 24 : 25; m.userData.part = part; m.userData.col = col; gizmo.add(m); if (hit) gizParts.push(m); else part.vis.push(m); return m;
    };
    const up = new THREE.Vector3(0, 1, 0);
    for (const a of ['x', 'y', 'z']) {
      const dir = new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0), q = new THREE.Quaternion().setFromUnitVectors(up, dir), col = AXCOL[a];
      const mv = { type: 'g', axis: a, vis: [] }, sc = { type: 's', axis: a, vis: [] }, ro = { type: 'r', axis: a, vis: [] };
      const sh = mk(new THREE.CylinderGeometry(0.018, 0.018, 0.78, 8), col, mv); sh.quaternion.copy(q); sh.position.copy(dir).multiplyScalar(0.53);
      const cn = mk(new THREE.ConeGeometry(0.07, 0.2, 14), col, mv); cn.quaternion.copy(q); cn.position.copy(dir).multiplyScalar(1.0);
      const hm = mk(new THREE.CylinderGeometry(0.08, 0.08, 0.95, 6), col, mv, true); hm.quaternion.copy(q); hm.position.copy(dir).multiplyScalar(0.6);
      const cb = mk(new THREE.BoxGeometry(0.09, 0.09, 0.09), col, sc); cb.quaternion.copy(q); cb.position.copy(dir).multiplyScalar(0.4);
      const ch = mk(new THREE.BoxGeometry(0.17, 0.17, 0.17), col, sc, true); ch.quaternion.copy(q); ch.position.copy(dir).multiplyScalar(0.4);
      const rq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      const rg = mk(new THREE.TorusGeometry(1.25, 0.012, 6, 64), col, ro); rg.quaternion.copy(rq);
      const rh = mk(new THREE.TorusGeometry(1.25, 0.07, 6, 48), col, ro, true); rh.quaternion.copy(rq);
    }
    const fr = { type: 'g', axis: null, vis: [] };
    mk(new THREE.SphereGeometry(0.07, 12, 8), 0xf2f2f2, fr); mk(new THREE.SphereGeometry(0.14, 8, 6), 0xf2f2f2, fr, true);
  }
  let gizHover = null;
  function gizPivot() {
    if (uiMode === 'edit' && editO) { const vs = [...selVerts()]; if (!vs.length) return null; const pl = [0, 0, 0]; vs.forEach((i) => { for (let k = 0; k < 3; k++) pl[k] += editO.mesh.v[i][k] / vs.length; }); editO.group.updateMatrixWorld(true); return worldOfLocal(editO, pl); }
    const list = [...selSet]; if (!list.length) return null;
    const p = new THREE.Vector3(); list.forEach((o) => p.add(o.pos)); return p.multiplyScalar(1 / list.length);
  }
  function placeGizmo() {
    const p = S.gizmo && viewMode() === 'live' && !S.baking && !tf ? gizPivot() : null;
    gizmo.visible = !!p; if (!p) return;
    gizmo.position.copy(p);
    // a fixed size on screen: the arrows are about 64 px long whatever the zoom
    const hpx = Math.max(200, canvas.clientHeight || 600), worldPerPx = S.ortho ? (camera.top - camera.bottom) / (camera.zoom || 1) / hpx : 2 * Math.tan(camera.fov * Math.PI / 360) * camera.position.distanceTo(p) / hpx;
    gizmo.scale.setScalar(Math.max(1e-4, worldPerPx * 64));
    const fo = uiMode === 'edit' ? editO : (selSet.size === 1 && selected && selected.kind === 'mesh' ? selected : null);
    if (S.orient === 'local' && fo) gizmo.rotation.set(fo.rx || 0, fo.yaw || 0, fo.rz || 0, 'ZYX'); else gizmo.rotation.set(0, 0, 0);
  }
  function pickGizmo(cx, cy) {
    if (!gizmo.visible) return null;
    gizmo.updateMatrixWorld(true); setNdc(cx, cy);
    const hits = ray.intersectObjects(gizParts.filter((m) => m.visible), false);
    if (!hits.length) return null;
    const order = { s: 0, g: 1, r: 2 }; hits.sort((p, q) => (order[p.object.userData.part.type] - order[q.object.userData.part.type]) || (p.distance - q.distance));
    return hits[0].object.userData.part;
  }
  function hoverGizmo(part) {
    if (part === gizHover) return;
    if (gizHover) gizHover.vis.forEach((m) => m.material.color.setHex(m.userData.col));
    gizHover = part; if (part) part.vis.forEach((m) => m.material.color.setHex(0xffd34a));
  }
  function placeHandles() {
    placeGizmo(); updateTfLines(); drawAxisWidget();
    if (!(tf && tf.type === 'g' && tf.snapAt)) snapMark.visible = false;
    const show = S.handles && viewMode() === 'live' && uiMode === 'object' && !S.baking && !tf;
    handleGrp.visible = show; if (!show) return;
    const sc = Math.max(0.3, cam.r * 0.055), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
    for (const f of FACES) {
      f.group.position.set(f.ax === 'x' ? b[f.k] : cx, f.ax === 'y' ? b[f.k] : cy, f.ax === 'z' ? b[f.k] : cz);
      f.group.scale.setScalar(sc);
    }
  }
  function updateDomainViz() {
    W = S.dom.w; Hh = S.dom.h; Dd = S.dom.d;
    const m = S.min;
    b.x0 = m.x; b.x1 = m.x + W; b.y0 = m.y; b.y1 = m.y + Hh; b.z0 = m.z; b.z1 = m.z + Dd;
    S.org.x = m.x + W / 2; S.org.y = m.y; S.org.z = m.z + Dd / 2;
    tank.scale.set(W, Hh, Dd); tank.position.set(b.x0 + W / 2, b.y0 + Hh / 2, b.z0 + Dd / 2);
    const gp = [], nx = Math.max(2, Math.round(W / 0.2)), nz = Math.max(2, Math.round(Dd / 0.2)), gy = b.y0 + 0.002;
    for (let i = 0; i <= nx; i++) { const t = b.x0 + (W / nx) * i; gp.push(t, gy, b.z0, t, gy, b.z1); }
    for (let i = 0; i <= nz; i++) { const t = b.z0 + (Dd / nz) * i; gp.push(b.x0, gy, t, b.x1, gy, t); }
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    const face = (a) => new THREE.Float32BufferAttribute(a, 3), yl = b.y0 + 0.004;
    const quad = {
      x0: [b.x0, b.y0, b.z0, b.x0, b.y1, b.z0, b.x0, b.y1, b.z1, b.x0, b.y0, b.z1], x1: [b.x1, b.y0, b.z0, b.x1, b.y1, b.z0, b.x1, b.y1, b.z1, b.x1, b.y0, b.z1],
      y0: [b.x0, yl, b.z0, b.x1, yl, b.z0, b.x1, yl, b.z1, b.x0, yl, b.z1], y1: [b.x0, b.y1, b.z0, b.x1, b.y1, b.z0, b.x1, b.y1, b.z1, b.x0, b.y1, b.z1],
      z0: [b.x0, b.y0, b.z0, b.x1, b.y0, b.z0, b.x1, b.y1, b.z0, b.x0, b.y1, b.z0], z1: [b.x0, b.y0, b.z1, b.x1, b.y0, b.z1, b.x1, b.y1, b.z1, b.x0, b.y1, b.z1]
    };
    const names = ['x0', 'x1', 'y0', 'y1', 'z0', 'z1'];
    names.forEach((nm, i) => { openLines[i].geometry.setAttribute('position', face(quad[nm])); openLines[i].visible = !!S.open[nm]; });
  }
  updateDomainViz();

  function resize() {
    const w = Math.max(stage.clientWidth, 10), h = Math.max(stage.clientHeight, 10);   // the timeline sits under the viewport now, not over it
    renderer.setSize(w, h, false); try { ovRes(); } catch (e) { /* edit overlay not made yet */ }
    perspCam.aspect = w / h; perspCam.updateProjectionMatrix(); viewAspect = w / h; viewH = renderer.domElement.height;
    pmat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((perspCam.fov * Math.PI / 180) / 2));
    updateCam();
  }
  const ro = new ResizeObserver(() => resize()); ro.observe(stage);

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
  function rebuildSDF(o) {
    o.sdf = buildSDF(o.mesh, 0.025, 0.16);
    { let c = 0; const D = o.sdf.data; for (let i = 0; i < D.length; i++) if (D[i] < 0) c++; const bb = meshBounds(o.mesh), v = (bb.hi[0] - bb.lo[0]) * (bb.hi[1] - bb.lo[1]) * (bb.hi[2] - bb.lo[2]); o.sdf.fillFrac = v > 1e-9 ? Math.min(1, c * o.sdf.cell ** 3 / v) : 0.6; }
    let r = 0; for (const q of o.mesh.v) r = Math.max(r, Math.hypot(q[0], q[1], q[2])); o.rad = r;
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
    if (!o.water || !o.sdf) return null;
    const R = eulerMat(o.rx, o.yaw, o.rz), ox = S.org.x, oy = S.org.y, oz = S.org.z, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const q of o.mesh.v) {
      const w = [R[0] * q[0] + R[1] * q[1] + R[2] * q[2] + o.pos.x - ox, R[3] * q[0] + R[4] * q[1] + R[5] * q[2] + o.pos.y - oy, R[6] * q[0] + R[7] * q[1] + R[8] * q[2] + o.pos.z - oz];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
    }
    return { t: 'vol', sdf: o.sdf, x: o.pos.x - ox, y: o.pos.y - oy, z: o.pos.z - oz, R, lo, hi };
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
    if (nbActive()) { nbSeed(sim, resolveFills(), nbCfg(), oceanCfg(), S.frame * DT, S.g / (S.scale || 1), 1); return; }
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
    'Waterfall': () => {
      // a wide river on a plateau, flanked by rough stone pillars, ending in a ragged sheer drop with a long fall below it
      let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      [-0.6, 0, 0.6].forEach((z) => makeObj('emitter', { x: -2.7, y: 5.85, z, az: 0, el: -3, speed: 2.4, radius: 0.28 }));
      makeObj('cube', { name: 'plateau', x: -2.0, y: 4.6, z: 0, hx: 1.0, hy: 1.0, hz: 1.4 });
      [-1.12, -0.56, 0, 0.56, 1.12].forEach((z, i) => {
        const hy = 0.9 + rnd() * 0.9;
        makeObj('cube', { name: 'lip' + (i + 1), x: -0.9 + (rnd() - 0.5) * 0.2, y: 5.6 - hy, z: z + (rnd() - 0.5) * 0.08, hx: 0.3 + rnd() * 0.15, hy, hz: 0.28, yaw: (rnd() - 0.5) * 0.12, rz: (rnd() - 0.5) * 0.05 });
      });
      for (const sg of [-1, 1]) for (let i = 0; i < 4; i++) {
        const hy = 0.45 + rnd() * 0.5, hx = 0.35 + rnd() * 0.15;
        makeObj('cube', { name: (sg < 0 ? 'pillarL' : 'pillarR') + (i + 1), x: -2.75 + i * 0.7 + (rnd() - 0.5) * 0.12, y: 5.6 + hy, z: sg * (1.15 + rnd() * 0.1), hx, hy, hz: 0.22 + rnd() * 0.06, yaw: (rnd() - 0.5) * 0.15 });
      }
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
    'Meteor lake': () => {
      // at scene scale 10 this is a 52 m lake, 9 m deep, and a 14 m meteor. The meteor waits above the box, jumps to the water faster than its speed limit
      // (so it only displaces water), drives down into the lake below the limit (so it pushes the crater open), then jumps away
      const w = makeObj('cube', { water: true, name: 'Lake', x: 0, y: 0.45, z: 0, hx: 2.55, hy: 0.45, hz: 2.55 });
      const m = makeObj('sphere', { name: 'meteor', x: 1.8, y: 9, z: 0.8, r: 0.7 });
      const K = (t, x, y, z) => ({ t, x, y, z, rx: 0, yaw: 0, rz: 0 });
      m.keys = [K(0, 1.8, 9, 0.8), K(0.8, 1.8, 9, 0.8), K(0.801, 0, 1.65, 0), K(0.891, 0, 0.6, 0), K(1.5, 0, 0.6, 0), K(1.501, 0, 9, 0)];   // at 10 m a unit: a 14 m meteor driving in at about 115 m/s   // the jumps take 1 ms, so they never get split across frames
      applyKeysAt(0); fillNow(w);
    },
    'Ocean': () => {
      const hull = makeObj('cube', { name: 'Hull', x: 0, y: 0.5, z: 0, hx: 0.9, hy: 0.35, hz: 0.45, yaw: 0.4 });
      const K = (t, y) => ({ t, x: 0, y, z: 0, rx: 0, yaw: 0.4, rz: 0 });
      hull.keys = [K(0, 0.5), K(2, 0.5), K(8, 2.55), K(10, 2.55)];   // rises from the sea floor and out through the surface, about 3 m/s
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
    'Waterfall': { dom: { w: 6, h: 7.5, d: 3 }, open: ALLC(true) },
    'Cascade': { dom: { w: 7, h: 8, d: 3.6 }, open: ALLC(true), params: { foamSens: 0.6, foamTau: 2.2, gust: 1.5, airDrag: 0.5 }, cam: { theta: 0.6, phi: 1.2, r: 15 } },
    'Meteor lake': { dom: { w: 5.2, h: 5, d: 5.2 }, open: Object.assign(ALLC(false), { y1: true }), params: { foamSens: 0.8, foamTau: 2, gust: 1, airDrag: 0.4, colMax: 300, vmaxW: 400, subMax: 16, scale: 10 },
      cam: { theta: 0.7, phi: 1.12, r: 14 }, waterVol: 5.1 * 0.9 * 5.1, linear: true, dur: 8 },
    // at scene scale 10: a 60 m patch of open sea, 16 m deep, 3 m waves 40 m long, and an 18 m hull rising out of it
    'Ocean': { dom: { w: 6, h: 3.2, d: 6 }, open: Object.assign(ALLC(false), { y1: true }), params: { foamSens: 0.8, foamTau: 2, gust: 1, airDrag: 0.3, colMax: 300, vmaxW: 200, subMax: 16, scale: 10 },
      cam: { theta: 0.75, phi: 1.15, r: 15 }, dur: 10, nb: true, cap: 450000, ocean: { on: true, height: 3, length: 40, dir: 25, spread: 25, level: 0.5, layer: 0.15, seed: 7 } }
  };
  function loadScene(name) {
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
        rx: o.rx, yaw: o.yaw, rz: o.rz, spin: o.spin, az: o.az, el: o.el, speed: o.speed, radius: o.radius, on: o.on, mode: o.mode, spread: o.spread, density: o.density, turb: o.turb, water: o.water,
        mesh: o.mesh ? { v: o.mesh.v.map((q) => q.slice()), f: o.mesh.f.map((q) => q.slice()) } : null, sdf: o.sdf || null,
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

  // ---------- UI helpers ----------
  function addSlider(parent, o) {
    const row = document.createElement('div'); row.className = 'row';
    // a log slider spends more of its length on small values: position 0..1000 maps to min..max exponentially
    const lg = !!o.log, lr = lg ? Math.log(o.max / o.min) : 0, rd = o.round || 0.001;
    const pos0 = lg ? Math.round(1000 * Math.log(Math.max(o.value, o.min) / o.min) / lr) : o.value;
    row.innerHTML = '<label for="' + o.id + '">' + o.label + '</label><div class="num"><input type="range" id="' + o.id + '" min="' + (lg ? 0 : o.min) + '" max="' + (lg ? 1000 : o.max) + '" step="' + (lg ? 1 : o.step) + '" value="' + pos0 + '"><output for="' + o.id + '"></output></div>';
    const inp = row.querySelector('input'), out = row.querySelector('output'), lab = row.querySelector('label'), box = row.querySelector('.num');
    const fmt = o.fmt || ((v) => String(v));
    const get = () => lg ? Math.min(o.max, Math.max(o.min, +(Math.round(o.min * Math.exp(+inp.value / 1000 * lr) / rd) * rd).toFixed(5))) : +inp.value;
    const tol = (lg ? rd : (o.step || rd)) * 0.5 + 1e-9;
    // a label in bold means the value is not the default (as in Houdini)
    const mark = (v) => { if (o.def !== undefined) row.classList.toggle('nd', Math.abs(v - o.def) > Math.max(tol, Math.abs(o.def) * 1e-4)); };
    const fillP = () => { const a = +inp.min, z = +inp.max; inp.style.setProperty('--p', (z > a ? clamp((+inp.value - a) / (z - a), 0, 1) * 100 : 0) + '%'); };
    const show = () => { const v = get(); out.textContent = fmt(v); mark(v); fillP(); };
    show();
    // Blender style: drag sideways to change the value (from where it was, not where the mouse is), Shift for fine steps; a click without dragging types a value
    inp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); inp.focus({ preventScroll: true });
      const a = +inp.min, z = +inp.max, w = Math.max(80, box.clientWidth), st = +inp.step || 0;
      const d0 = { x: e.clientX, v: +inp.value, moved: false, id: e.pointerId };
      try { inp.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      box.classList.add('dragging');
      const mv = (ev) => {
        if (ev.pointerId !== d0.id) return;
        const dx = ev.clientX - d0.x; if (!d0.moved && Math.abs(dx) < 3) return;
        d0.moved = true;
        let v = d0.v + dx * (z - a) / w * (ev.shiftKey ? 0.1 : 1);
        if (st > 0) v = Math.round((v - a) / st) * st + a;
        v = clamp(v, a, z);
        if (String(v) !== inp.value) { inp.value = String(v); inp.dispatchEvent(new Event('input', { bubbles: true })); }
      };
      const up = (ev) => {
        if (ev.pointerId !== d0.id) return;
        inp.removeEventListener('pointermove', mv); inp.removeEventListener('pointerup', up); inp.removeEventListener('pointercancel', up);
        box.classList.remove('dragging');
        if (d0.moved) inp.dispatchEvent(new Event('change', { bubbles: true })); else out.click();
      };
      inp.addEventListener('pointermove', mv); inp.addEventListener('pointerup', up); inp.addEventListener('pointercancel', up);
    });
    inp.addEventListener('input', () => { show(); if (o.onPreview) o.onPreview(get()); if (!o.onChange) o.onInput(get()); });
    if (o.onChange) inp.addEventListener('change', () => o.onChange(get()));
    // set an exact value (typed, pasted or reset), kept inside the slider's range
    const commit = (c) => {
      c = Math.min(o.max, Math.max(o.min, c));
      inp.value = lg ? String(Math.round(1000 * Math.log(c / o.min) / lr)) : String(c);
      out.textContent = fmt(c); mark(c); fillP();
      row.dispatchEvent(new Event('input', { bubbles: true }));   // lets the panel know something changed (clears the live cache)
      if (o.onPreview) o.onPreview(c);
      if (o.onChange) o.onChange(c); else o.onInput(c);
    };
    lab.dataset.tip = o.tip || '';
    // click the value to type an exact number
    box.title = 'Drag to change, click to type a value';
    out.addEventListener('click', () => {
      if (row.querySelector('input.typed')) return;
      const t = document.createElement('input'); t.type = 'text'; t.className = 'typed'; t.value = String(+get().toFixed(4)); t.setAttribute('aria-label', o.label);
      out.hidden = true; box.appendChild(t); t.focus(); t.select();
      let fin = false;
      const done = (ok) => {
        if (fin || !t.isConnected) return; fin = true;
        const v = parseFloat(t.value.replace(',', '.'));
        t.remove(); out.hidden = false;
        if (ok && isFinite(v)) commit(v);
      };
      t.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      t.addEventListener('blur', () => done(true));
    });
    row._st = { label: o.label.replace(/<[^>]*>/g, ''), get, def: o.def, min: o.min, max: o.max, fmt, commit, type: () => out.click() };
    parent.appendChild(row); return inp;
  }
  // a collapsible sub-panel (like Blender's); whether it is open is remembered in this browser
  let searching = false;
  function sub(parent, key, title, open, tip) {
    const d = document.createElement('details'); d.className = 'sub'; d.dataset.k = key;
    const st = lsGet('open.' + key); d.open = st === null ? !!open : st === '1';
    const sm = document.createElement('summary'); sm.textContent = title; if (tip) sm.dataset.tip = tip; d.appendChild(sm);
    const body = document.createElement('div'); body.className = 'sub-body'; d.appendChild(body);
    d.addEventListener('toggle', () => { if (!searching) lsSet('open.' + key, d.open ? '1' : '0'); });
    parent.appendChild(d); return body;
  }
  // a checkbox row with a tooltip
  function addCheck(parent, id, label, on, tip, cb, def) {
    const row = document.createElement('div'); row.className = 'row plain';
    row.innerHTML = '<label for="' + id + '">' + label + '</label><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '>';
    const lab = row.querySelector('label'); if (tip) lab.dataset.tip = tip;
    const mark = (v) => { if (def !== undefined) row.classList.toggle('nd', v !== def); };
    mark(on);
    row.querySelector('input').addEventListener('change', (e) => { mark(e.target.checked); cb(e.target.checked); });
    parent.appendChild(row); return row;
  }
  // a drop-down row
  function addSelect(parent, id, label, opts, val, tip, cb) {
    const row = document.createElement('div'); row.className = 'row plain sel';
    row.innerHTML = '<label for="' + id + '">' + label + '</label><select id="' + id + '">' + opts.map(([v, l]) => '<option value="' + v + '"' + (v === val ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
    const lab = row.querySelector('label'); if (tip) lab.dataset.tip = tip;
    row.querySelector('select').addEventListener('change', (e) => { e.target.blur(); cb(e.target.value); });
    parent.appendChild(row); return row;
  }
  function setColorBy(v) {
    S.colorBy = v === 'type' ? 'type' : 'speed'; pmat.uniforms.uMode.value = S.colorBy === 'type' ? 1 : 0;
    document.querySelectorAll('#d-colby, #vh-colby').forEach((el) => { el.value = S.colorBy; });
    const lg = $('#legend'); if (lg) lg.hidden = S.colorBy !== 'type';
  }
  const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2), f3 = (v) => v.toFixed(3), f0 = (v) => String(Math.round(v));
  function seg(id, cb) {
    const el = $(id);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      setSeg(el, btn.dataset.v); cb(btn.dataset.v);
    });
  }
  function setSeg(el, v) { el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === String(v) ? 'true' : 'false')); }
  const fmtN = (n) => n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);

  // what a given spacing needs on the GPU, so a setting that cannot work is caught before the buffers are made
  function gridCost(d, ratio, maxN) {
    const h = d * ratio, nx = Math.max(4, Math.round(S.dom.w / h)), ny = Math.max(4, Math.round(S.dom.h / h)), nz = Math.max(4, Math.round(S.dom.d / h));
    const ncell = nx * ny * nz, ntiles = Math.ceil((nx + 1) / 8) * Math.ceil((ny + 1) / 8) * Math.ceil((nz + 1) / 8);
    // FLIP stores the grid in 8x8x8 blocks only near particles, about 20 KB a block (cells and faces). Particles: position, velocity,
    // fluid cell lists, plus the sort copy when sorting is on; the live view reads back at most about 300k points through a ring of three.
    const sm = Math.min(maxN, 300001), perP = 16 + 16 + 8 + (S.sortP ? 32 : 0), block = 512 * 40 + 12;
    const start = Math.max(64, Math.ceil(maxN / 1024)), compact = Math.ceil(maxN / ratio / ratio / ratio / 512 * 2.5);   // blocks when all points sit in solid water
    const particles = maxN * perP + sm * 16 * 4 + ntiles * 16;
    const biggest = Math.max(maxN * 16, start * 6144, ntiles * 8), total = particles + start * block;
    return { nx, ny, nz, ncell, biggest, total, particles, block, compact };
  }
  function resInfoText(d, ratio) {
    const c = gridCost(d, ratio, S.cap), lim = S.gpu ? S.gpu.maxBuf : 1 << 27, mb = (v) => Math.max(1, Math.round(v / 1048576));
    let t = 'Box ' + c.nx + ' × ' + c.ny + ' × ' + c.nz + ' = ' + (c.ncell / 1e6).toFixed(2) + 'M cells.';
    if (S.engine === 'flip') t += ' Particles about ' + mb(c.particles) + ' MB, grid about ' + mb(c.compact * c.block) + ' MB when full.';
    else t += ' About ' + mb(c.total) + ' MB on the GPU.';
    if (S.engine === 'flip' && S.cap > 300000) t += ' The live view shows a sample of about 300k points; every point is still simulated.';
    if (c.biggest > lim) t += ' TOO BIG for this GPU (one buffer would need ' + mb(c.biggest) + ' MB, the limit is ' + mb(lim) + ' MB). Lower Max points or raise the spacing.';
    return { text: t, bad: c.biggest > lim };
  }
  // live solver group, rebuilt when the engine changes
  const gs = $('#g-sim');
  function setSpacing(v) {
    const P = PRESET[S.engine], old = S.liveD; v = clamp(v, P.dMin, 0.16);
    const cap = v < old ? Math.min(P.capMax, Math.round(S.cap * Math.pow(old / v, 3) / 1000) * 1000) : S.cap;   // keep the same fill proportions when the spacing shrinks
    const c = gridCost(v, S.cellRatio, cap), lim = S.gpu ? S.gpu.maxBuf : 1 << 27;
    if (S.engine !== 'cpu' && c.biggest > lim) { flash('That spacing is too big for this GPU. Raise Grid cell size or shrink the box first.'); buildLiveUI(); return; }
    S.liveD = v; S.cap = cap; makeSim(); resetSim(S.tl.t); buildLiveUI();
  }
  function buildLiveUI() {
    [...gs.children].forEach((n) => { if (n.tagName !== 'H2') n.remove(); });
    const P = PRESET[S.engine], flip = S.engine === 'flip';
    const subt = $('#subtitle'); if (subt) subt.textContent = flip ? 'FLIP · GPU' : S.engine === 'gpu' ? 'PBF · GPU' : 'PBF · CPU';
    const er = document.createElement('div'); er.className = 'row plain';
    er.innerHTML = '<label>Solver</label><div class="seg" id="seg-engine" role="group" aria-label="Solver"><button type="button" data-v="flip" aria-pressed="' + flip + '"' + (S.gpu ? '' : ' disabled') + '>FLIP</button><button type="button" data-v="gpu" aria-pressed="' + (S.engine === 'gpu') + '"' + (S.gpu ? '' : ' disabled') + '>PBF GPU</button><button type="button" data-v="cpu" aria-pressed="' + (S.engine === 'cpu') + '">PBF CPU</button></div>';
    er.querySelector('label').dataset.tip = flip ? 'FLIP on ' + S.gpu.name + ': a pressure solve on a grid with particles carrying the motion. Real water behaviour, incompressible, with splashes.' : S.engine === 'gpu' ? 'Position based fluids on ' + S.gpu.name + '. Fast and splashy, less exact than FLIP.' : (S.gpu ? 'CPU solver. Slower, but works anywhere.' : 'WebGPU is not available in this browser, so the CPU solver is in use. Chrome or Edge on Windows normally have it.');
    gs.appendChild(er);
    er.querySelector('.seg').addEventListener('click', (e) => { const bt = e.target.closest('button'); if (bt && !bt.disabled && bt.dataset.v !== S.engine) setEngine(bt.dataset.v); });

    // resolution
    const rs = sub(gs, 'res', 'Resolution', true);
    const qr = document.createElement('div'); qr.className = 'row plain';
    qr.innerHTML = '<label data-tip="Quick spacing presets, from coarse and fast to fine and slow.">Preset</label><div class="seg" id="seg-prev" role="group" aria-label="Resolution preset"><button type="button" data-v="1.6">Draft</button><button type="button" data-v="1">Normal</button><button type="button" data-v="0.7">Fine</button><button type="button" data-v="0.5">Ultra</button></div>';
    qr.querySelector('.seg').addEventListener('click', (e) => {
      const bt = e.target.closest('button'); if (!bt) return;
      setSpacing(Math.round(P.liveD * parseFloat(bt.dataset.v) * 1000) / 1000);
    });
    rs.appendChild(qr);
    addSlider(rs, { id: 's-res', label: 'Spacing', min: P.dMin, max: 0.16, log: true, value: S.liveD, def: dv('liveD'), fmt: (v) => v.toFixed(3) + ' m', tip: 'Distance between particles. Smaller is finer and slower: halving it means about eight times the particles. The grid is only stored in 8×8×8 blocks near the water, so a big box costs almost nothing.', onInput: () => {}, onPreview: (v) => { const r = resInfoText(v, S.cellRatio), el = $('#res-info'); if (el) { el.textContent = r.text; el.classList.toggle('warn', r.bad); } }, onChange: (v) => { setSpacing(v); } });
    if (flip) addSlider(rs, { id: 's-ratio', label: 'Grid cell', min: 1.6, max: 3.2, step: 0.1, value: S.cellRatio, def: dv('cellRatio'), fmt: (v) => v.toFixed(1) + '×', tip: 'Size of a pressure-grid cell, as a multiple of the particle spacing. Bigger cells are faster but blur small detail.', onInput: () => {}, onPreview: (v) => { const r = resInfoText(S.liveD, v), el = $('#res-info'); if (el) { el.textContent = r.text; el.classList.toggle('warn', r.bad); } }, onChange: (v) => { if (gridCost(S.liveD, v, S.cap).biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27)) { flash('That grid is too big for this GPU.'); buildLiveUI(); return; } S.cellRatio = v; makeSim(); resetSim(S.tl.t); buildLiveUI(); } });
    addSlider(rs, { id: 's-cap', label: 'Max points', min: 1000, max: P.capMax, step: P.capMax > 400000 ? 5000 : P.capMax > 20000 ? 1000 : 500, value: S.cap, def: dv('cap'), fmt: fmtN, tip: 'The most particles the sim may hold. Sources stop emitting when it is full.', onPreview: (v) => { $('#capshow').textContent = fmtN(v); }, onChange: (v) => {
      S.cap = v;
      if (v <= sim.MAXN || S.engine === 'cpu') { sim.setCap(v); return; }
      if (gridCost(S.liveD, S.cellRatio, v).biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27)) { S.cap = sim.MAXN; flash('That many points does not fit in one GPU buffer here.'); buildLiveUI(); return; }
      makeSim(); resetSim(S.tl.t);
    } });
    { const ri = document.createElement('div'); ri.className = 'pos'; ri.id = 'res-info'; const r = resInfoText(S.liveD, S.cellRatio); ri.textContent = r.text; ri.classList.toggle('warn', r.bad); rs.appendChild(ri); }

    // physics
    const ph = sub(gs, 'phys', 'Physics', true);
    addSlider(ph, { id: 's-grav', label: 'Gravity', min: 0, max: 20, step: 0.1, value: S.g, def: dv('g'), fmt: (v) => v.toFixed(1) + ' m/s²', tip: 'Downward pull. 9.8 is Earth.', onInput: (v) => { S.g = v; } });
    if (flip) {
      addSlider(ph, { id: 's-flip', label: 'FLIP ratio', min: 0, max: 1, step: 0.01, value: S.flip, def: dv('flip'), fmt: f2, tip: 'How much particles keep their own motion (1, splashy and lively) versus taking the smoothed grid motion (0, calm and thick).', onInput: (v) => { S.flip = v; } });
      addSlider(ph, { id: 's-iters', label: 'Pressure iters', min: 5, max: 150, step: 5, value: S.iters, def: dv('iters'), fmt: f0, tip: 'Passes of the pressure solve each step. More keeps the volume better (less squashing at the bottom) but costs time.', onInput: (v) => { S.iters = v; } });
    } else {
      addSlider(ph, { id: 's-visc', label: 'Viscosity', min: 0, max: 0.3, step: 0.005, value: S.visc, def: dv('visc'), fmt: f2, tip: 'Thickness. 0 is water, higher is more like syrup.', onInput: (v) => { S.visc = v; } });
      addSlider(ph, { id: 's-iters', label: 'Iterations', min: 1, max: 6, step: 1, value: S.iters, def: dv('iters'), fmt: f0, tip: 'Solver passes each step. More is stiffer and slower.', onInput: (v) => { S.iters = v; } });
    }
    const scInfo = () => { const el = $('#scale-info'); if (el) { const k = S.scale || 1, f = (v) => (v * k >= 100 ? Math.round(v * k) : +(v * k).toFixed(v * k >= 10 ? 1 : 2)); el.textContent = 'The box is ' + f(S.dom.w) + ' × ' + f(S.dom.h) + ' × ' + f(S.dom.d) + ' m, one grid cell ' + f(S.liveD * S.cellRatio) + ' m.'; } };
    addSlider(ph, { id: 's-scale', label: 'Scene scale', min: 0.1, max: 200, log: true, round: 0.1, value: S.scale, def: dv('scale'), fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' m/unit', tip: 'How many metres one unit of the scene stands for. Gravity and every speed in m/s are converted, so a bigger scale makes the same box behave like a bigger, slower body of water.', onInput: (v) => { S.scale = Math.max(0.1, v); scInfo(); } });
    { const el = document.createElement('div'); el.className = 'pos'; el.id = 'scale-info'; ph.appendChild(el); scInfo(); }

    if (flip) {
      const aw = sub(gs, 'air', 'Air and wind', false);
      addSlider(aw, { id: 's-wind', label: 'Wind speed', min: 0, max: 20, step: 0.5, value: S.wind.speed, def: dv('wind.speed'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'Steady wind that pushes on water exposed to the air.', onInput: (v) => { S.wind.speed = v; } });
      addSlider(aw, { id: 's-windaz', label: 'Wind heading', min: -180, max: 180, step: 5, value: S.wind.az, def: dv('wind.az'), fmt: (v) => v + '°', tip: 'Direction the wind blows towards, around the vertical axis.', onInput: (v) => { S.wind.az = v; } });
      addSlider(aw, { id: 's-up', label: 'Updraft', min: -5, max: 8, step: 0.5, value: S.wind.up, def: dv('wind.up'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'Vertical air movement. Positive lifts spray, negative pushes it down.', onInput: (v) => { S.wind.up = v; } });
      addSlider(aw, { id: 's-drag', label: 'Air drag', min: 0, max: 3, step: 0.05, value: S.airDrag, def: dv('airDrag'), fmt: (v) => v.toFixed(2) + ' /s', tip: 'How quickly flying water slows down in the air.', onInput: (v) => { S.airDrag = v; } });
      addSlider(aw, { id: 's-gust', label: 'Air turbulence', min: 0, max: 6, step: 0.25, value: S.gust, def: dv('gust'), fmt: (v) => v.toFixed(2) + ' m/s', tip: 'Random gusts that break up flying sheets and spray.', onInput: (v) => { S.gust = v; } });

      const ww = sub(gs, 'white', 'White water and tearing', false);
      addSlider(ww, { id: 's-foamsens', label: 'White water amount', min: 0.3, max: 3, step: 0.1, value: 1 / S.foamSens, def: 1 / dv('foamSens'), fmt: (v) => v.toFixed(1) + '×', tip: 'How easily fast, churned water turns white.', onInput: (v) => { S.foamSens = 1 / v; } });
      addSlider(ww, { id: 's-foamtau', label: 'White water fade', min: 0.3, max: 4, step: 0.1, value: S.foamTau, def: dv('foamTau'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long white water takes to fade back to blue.', onInput: (v) => { S.foamTau = v; } });
      addSlider(ww, { id: 's-tear', label: 'Sheet tearing', min: 0, max: 1, step: 0.05, value: S.tear, def: dv('tear'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2)), tip: 'Lets thin sheets and drops fly apart instead of being held together as a membrane (the lace look). Too high and thin water starts to look lost.', onInput: (v) => { S.tear = v; } });

      const sp = sub(gs, 'spray', 'Whitewater', true, 'Spray, mist, foam and bubbles, as in Houdini: points thrown off the water that never push it. Each is sorted every step by how deep in water it is: spray that lands turns to foam, foam rides the surface and fades, foam pushed under turns to bubbles, and bubbles rise back up as foam.');
      addCheck(sp, 'c-spray', 'Enabled', S.sprOn, 'Turns whitewater (spray, mist, foam and bubbles), the air field and dripping on or off.', (on) => { S.sprOn = on; if (sim && sim.setSprayCap) sim.setSprayCap(S.sprOn ? S.sprCap : 0); lastGen = -1; }, dv('sprOn'));
      addSlider(sp, { id: 's-spramt', label: 'Spray amount', min: 0.1, max: 6, log: true, round: 0.05, value: S.sprAmt, def: dv('sprAmt'), fmt: (v) => v.toFixed(2) + '×', tip: 'How many spray points fast water throws off.', onInput: (v) => { S.sprAmt = v; } });
      addSlider(sp, { id: 's-sprmin', label: 'Spray from', min: 0.5, max: 30, log: true, round: 0.1, value: S.sprMin, def: dv('sprMin'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'Water faster than this, near the surface, throws off spray. Lower makes more spray from calmer water.', onInput: (v) => { S.sprMin = v; } });
      addSlider(sp, { id: 's-sprlife', label: 'Spray lifetime', min: 0.2, max: 6, step: 0.1, value: S.sprLife, def: dv('sprLife'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long a spray point lives before it fades.', onInput: (v) => { S.sprLife = v; } });
      addSlider(sp, { id: 's-wwcrest', label: 'From crests', min: 0, max: 3, step: 0.05, value: S.wwCrest, def: dv('wwCrest'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Whitewater from fast, exposed water: wave crests, thin sheets and splashes (Houdini sources this from curvature and speed).', onInput: (v) => { S.wwCrest = v; } });
      addSlider(sp, { id: 's-wwimpact', label: 'From churn', min: 0, max: 3, step: 0.05, value: S.wwImpact, def: dv('wwImpact'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Whitewater from churning white water: impacts, breaking waves, hard turns (Houdini sources this from acceleration). Made under the surface it starts as bubbles.', onInput: (v) => { S.wwImpact = v; } });
      addSlider(sp, { id: 's-wwfoam', label: 'Foam lifetime', min: 0.3, max: 20, log: true, round: 0.1, value: S.wwFoamLife, def: dv('wwFoamLife'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long foam lasts on the surface before it breaks up. Long foam leaves the trails and patches that make big water read as big.', onInput: (v) => { S.wwFoamLife = v; } });
      addSlider(sp, { id: 's-wwrise', label: 'Bubble rise', min: 0.05, max: 2, log: true, round: 0.01, value: S.wwRise, def: dv('wwRise'), fmt: (v) => v.toFixed(2) + ' m/s', tip: 'How fast bubbles rise through the water before they surface as foam.', onInput: (v) => { S.wwRise = v; } });
      addSlider(sp, { id: 's-sprmist', label: 'Mist share', min: 0, max: 1, step: 0.05, value: S.sprMist, def: dv('sprMist'), fmt: f2, tip: 'Fraction of the spray that is fine mist: lighter, slowed hard by the air, drawn as soft puffs.', onInput: (v) => { S.sprMist = v; } });
      addSlider(sp, { id: 's-sprdrag', label: 'Spray drag', min: 0, max: 6, step: 0.1, value: S.sprDrag, def: dv('sprDrag'), fmt: (v) => v.toFixed(1) + ' /s', tip: 'How quickly spray droplets slow down in the air.', onInput: (v) => { S.sprDrag = v; } });
      addSlider(sp, { id: 's-mistdrag', label: 'Mist drag', min: 0.5, max: 30, log: true, round: 0.1, value: S.mistDrag, def: dv('mistDrag'), fmt: (v) => v.toFixed(1) + ' /s', tip: 'How quickly mist slows down in the air. High values make it hang and drift.', onInput: (v) => { S.mistDrag = v; } });
      const ap = sub(gs, 'airfield', 'Air field', false, 'A coarse grid of moving air. Water near the surface, flying spray and moving objects drag it along; it spreads out and settles back to the wind. Spray and mist drift with it, so mist billows and trails behind a splash. It never pushes the water itself.');
      addCheck(ap, 'c-air', 'Enabled', S.airOn, 'Spray and mist move with the air the water and objects drag along, instead of only the wind.', (on) => { S.airOn = on; }, dv('airOn'));
      addSlider(ap, { id: 's-aircouple', label: 'Drag along', min: 0.2, max: 20, log: true, round: 0.1, value: S.airCouple, def: dv('airCouple'), fmt: (v) => v.toFixed(1), tip: 'How strongly moving water, spray and objects pull the air with them.', onInput: (v) => { S.airCouple = v; } });
      addSlider(ap, { id: 's-airdecay', label: 'Settle', min: 0.05, max: 5, log: true, round: 0.05, value: S.airDecay, def: dv('airDecay'), fmt: (v) => v.toFixed(2) + ' /s', tip: 'How quickly stirred-up air settles back to the wind. Low values leave long trailing gusts.', onInput: (v) => { S.airDecay = v; } });
      const dp = sub(gs, 'drip', 'Dripping', false, 'Objects coming out of the water stay wet and drip for a while: points over their surface remember being in water, dry out, and let go of drops as they do (more from surfaces facing down).');
      addCheck(dp, 'c-drip', 'Enabled', S.dripOn, 'Wet objects drip after they leave the water.', (on) => { S.dripOn = on; }, dv('dripOn'));
      addSlider(dp, { id: 's-driprate', label: 'Drip amount', min: 0.1, max: 20, log: true, round: 0.1, value: S.dripRate, def: dv('dripRate'), fmt: (v) => v.toFixed(1), tip: 'Drops a second from each wet spot on the surface (about one spot per grid cell of surface), while it is fully wet.', onInput: (v) => { S.dripRate = v; } });
      addSlider(dp, { id: 's-dripdry', label: 'Dries in', min: 0.3, max: 20, log: true, round: 0.1, value: S.dripDry, def: dv('dripDry'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long an object keeps dripping after it leaves the water.', onInput: (v) => { S.dripDry = v; } });
      addSlider(sp, { id: 's-sprcap', label: 'Max whitewater', min: 50000, max: 4000000, log: true, round: 10000, value: S.sprCap, def: dv('sprCap'), fmt: fmtN, tip: 'The most whitewater (spray, mist, foam and bubble) points alive at once. They use GPU memory but never slow the water solve.', onInput: () => {}, onChange: (v) => { S.sprCap = v; if (sim && sim.setSprayCap && S.sprOn) sim.setSprayCap(v); } });
    }

    if (flip) {   // narrow band and ocean
      const nbp = sub(gs, 'nband', 'Narrow band', S.nbOn || S.ocean.on, 'Particles only in a band under the surface, as in Houdini. The deep water is kept on the grid, so big bodies of water need far fewer particles and a much finer spacing fits. From the side, the deep water shows hollow.');
      const nr = addCheck(nbp, 'c-nb', 'Enabled', S.nbOn || S.ocean.on, 'Keep particles only near the surface. Restarts the particles.', (on) => { S.nbOn = on; lcClear(); resetSim(S.tl.t); buildLiveUI(); }, false);
      if (S.ocean.on) { nr.querySelector('input').disabled = true; nr.querySelector('label').dataset.tip = 'The ocean needs narrow band, so it stays on while the ocean is on.'; }
      addCheck(nbp, 'c-nblook', 'Deep water', S.nbLook, 'Look only: draws the deep water under the band (which has no particles) as points too, so the water does not look hollow from the side. Drawing only, also kept in bakes. Costs some drawing time.', (on) => { S.nbLook = on; lastGen = -1; }, false);
      addSlider(nbp, { id: 's-nbband', label: 'Band', min: 2, max: 6, step: 1, value: S.nbBand, def: 3, fmt: (v) => v + ' cells', tip: 'How many grid cells deep the particles reach under the surface. More keeps detail in deep, churning water; fewer is faster.', onInput: (v) => { S.nbBand = v; } });
      const op = sub(gs, 'ocean', 'Ocean', S.ocean.on, 'Waves from an ocean spectrum roll in through the sides of the box, like Houdini\'s wave tank. The sides become a boundary that moves with the waves.');
      addCheck(op, 'c-ocean', 'Enabled', S.ocean.on, 'Fills the box with sea up to the water level and drives waves in from the sides. Turns narrow band on. Restarts the particles.', (on) => { S.ocean.on = on; lcClear(); resetSim(S.tl.t); buildLiveUI(); }, false);
      const ocS = (id, label, key, min, max, o) => addSlider(op, Object.assign({ id, label, min, max, value: S.ocean[key], def: OCEAN_DEF[key], onInput: (v) => { S.ocean[key] = v; } }, o));
      ocS('s-ohgt', 'Wave height', 'height', 0.05, 40, { log: true, round: 0.05, fmt: (v) => v.toFixed(v < 10 ? 2 : 1) + ' m', tip: 'Significant wave height: about the average of the biggest third of the waves, trough to crest, in metres (Scene scale applies).' });
      ocS('s-olen', 'Wavelength', 'length', 1, 600, { log: true, round: 0.5, fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' m', tip: 'Length of the main waves, crest to crest, in metres. Longer waves travel faster and stir the water deeper.' });
      ocS('s-odir', 'Direction', 'dir', -180, 180, { step: 5, fmt: (v) => v + '°', tip: 'Direction the waves travel towards. 0 is along +X.' });
      ocS('s-ospr', 'Spread', 'spread', 0, 90, { step: 5, fmt: (v) => v + '°', tip: 'How far the wave directions fan out. 0 gives long parallel swell; more gives a choppy, crossing sea.' });
      ocS('s-olvl', 'Water level', 'level', 0.1, 0.9, { step: 0.01, fmt: (v) => Math.round(v * 100) + '%', tip: 'Still water height, as a share of the box height. Restarts the particles.', onInput: () => {}, onChange: (v) => { S.ocean.level = v; lcClear(); resetSim(S.tl.t); } });
      ocS('s-olay', 'Boundary', 'layer', 0.05, 0.4, { step: 0.01, fmt: (v) => Math.round(v * 100) + '%', tip: 'Width of the boundary along the sides, as a share of the box. Its outer half moves with the waves like a wall; its inner half eases the water into the waves, which keeps reflections down.' });
      ocS('s-oseed', 'Seed', 'seed', 1, 99, { step: 1, fmt: (v) => String(v), tip: 'A different pattern of the same kind of sea.' });
    }

    // motion: substeps for the whole scene and how fast things may go
    const mo = sub(gs, 'motion', 'Substeps and speed limits', false, 'Each frame is split into substeps so nothing moves more than about 1.5 grid cells per step; the count follows the fastest water, source or object.');
    addSlider(mo, { id: 's-submin', label: 'Min substeps', min: 1, max: 8, step: 1, value: S.subMin, def: dv('subMin'), fmt: f0, tip: 'Substeps every frame even when the water is calm.', onInput: (v) => { S.subMin = v; } });
    addSlider(mo, { id: 's-submax', label: 'Max substeps', min: 1, max: 32, step: 1, value: S.subMax, def: dv('subMax'), fmt: f0, tip: 'The most substeps a frame may take when things move fast.', onInput: (v) => { S.subMax = v; } });
    addSlider(mo, { id: 's-colmax', label: 'Object speed limit', min: 5, max: 1000, log: true, round: 1, value: S.colMax, def: dv('colMax'), fmt: (v) => Math.round(v) + ' m/s', tip: 'An object moving faster than this counts as jumping: it shows up in the new place and only pushes water out of its way, without carrying it along.', onInput: (v) => { S.colMax = v; } });
    if (flip) addSlider(mo, { id: 's-wmax', label: 'Max water speed', min: 5, max: 200, log: true, round: 1, value: S.vmaxW, def: dv('vmaxW'), fmt: (v) => Math.round(v) + ' m/s', tip: 'Water is never allowed to go faster than this. A safety limit against blow-ups.', onInput: (v) => { S.vmaxW = v; } });
    addSlider(mo, { id: 's-dragspd', label: 'Drag speed', min: 1, max: 100, log: true, round: 0.5, value: S.dragSpeed, def: dv('dragSpeed'), fmt: (v) => v.toFixed(v < 10 ? 1 : 0) + ' m/s', tip: 'How fast objects follow the mouse when you drag them while the sim runs.', onInput: (v) => { S.dragSpeed = v; } });

    if (isGpu()) {   // live cache controls; changing these never clears the cache
      const lc = sub(gs, 'lcache', 'Live cache', false, 'While the sim runs from the start, the frames are kept in memory so Reset, Rewind and the timeline play them back without simulating. Blue on the timeline is cached, orange is out of date.');
      const box = document.createElement('div'); box.dataset.keep = '1'; box.className = 'params'; lc.appendChild(box);
      addCheck(box, 'c-lc', 'Live cache', S.lcOn, 'Keep the frames the live view shows, so they replay without simulating.', (on) => { S.lcOn = on; if (!S.lcOn) { lcClear(); LC.staleEnd = 0; } lcUi(); }, true);
      addSlider(box, { id: 's-lcmem', label: 'Cache memory', min: 128, max: 8192, log: true, round: 64, value: S.lcBudget, def: dv('lcBudget'), fmt: (v) => (v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : Math.round(v) + ' MB'), tip: 'The most memory the live cache may use. Recording stops when it is full.', onInput: (v) => { S.lcBudget = v; } });
      const st = document.createElement('div'); st.className = 'pos'; st.id = 'lc-info'; box.appendChild(st);
      const br = document.createElement('div'); br.className = 'btnrow'; br.innerHTML = '<button class="btn flat" id="btn-lc-clear" type="button">Clear cache</button>'; box.appendChild(br);
      br.querySelector('button').addEventListener('click', () => { lcClear(); LC.staleEnd = 0; lcUi(); flash('Live cache cleared'); });
      lcUi();
    }
    if (flip) {
      const su = sub(gs, 'speedups', 'Speed-ups', false);
      addCheck(su, 'c-sort', 'Sort particles', S.sortP, 'Reorders particles by position every 16 steps so neighbours sit together in memory. Same result. Clearly faster with a million or more points; about even on small scenes. Costs 32 bytes per point of GPU memory.', (on) => { S.sortP = on; if (sim && sim.opt) sim.opt.sort = on; }, dv('sortP'));
    }
    if (searching) filterPanel($('#psearch').value);
  }

  const gd = $('#g-disp');
  addSelect(gd, 'd-colby', 'Colour by', [['speed', 'Speed'], ['type', 'Type']], S.colorBy, 'Speed: blue to cyan to white as the water speeds up, churned water white. Type: one colour per kind of point: water blue, churned water pale blue, foam white, spray orange, mist lilac, bubbles green, deep water (narrow band) dark blue.', (v) => setColorBy(v));
  addSlider(gd, { id: 'd-size', label: 'Point size', min: 0.3, max: 1.6, step: 0.05, value: S.psize, def: dv('psize'), fmt: (v) => v.toFixed(2) + '×', tip: 'How big each point is drawn, compared with the particle spacing.', onInput: (v) => { S.psize = v; } });
  addSlider(gd, { id: 'd-vmax', label: 'White at', min: 1, max: 12, step: 0.5, value: S.vmax, def: dv('vmax'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'The speed that is coloured white. Slower water runs from blue to cyan.', onInput: (v) => { S.vmax = v; pmat.uniforms.uMax.value = v; } });
  addSlider(gd, { id: 'd-foam', label: 'White water', min: 0, max: 1, step: 0.05, value: S.foam, def: dv('foam'), fmt: (v) => v === 0 ? 'off' : v.toFixed(2), tip: 'How strongly churned water is drawn white.', onInput: (v) => { S.foam = v; pmat.uniforms.uFoam.value = v; } });
  addCheck(gd, 'c-gizmo', 'Transform gizmo', S.gizmo, 'Arrows move along an axis, rings rotate, small cubes scale, the centre ball moves freely. Hold V while moving to snap to points.', (on) => { setTool(on ? 'transform' : 'select'); $('#c-gizmo').blur(); }, false);
  addCheck(gd, 'c-oview', 'Ocean around box', S.oceanView, 'With the ocean on, draws its surface over the boundary and out past the box, so the box sits in open sea. Drawing only.', (on) => { S.oceanView = on; }, true);
  addSlider(gd, { id: 'd-sprdetail', label: 'Spray detail', min: 0, max: 12, step: 1, value: S.sprDetail, def: dv('sprDetail'), fmt: (v) => (v === 0 ? 'off' : '×' + (v + 1)), tip: 'Extra look-only points drawn around each spray and mist point, so spray looks denser. Drawing only.', onInput: (v) => { S.sprDetail = v; lastGen = -1; } });
  addSlider(gd, { id: 'd-streak', label: 'Spray streaks', min: 0, max: 0.1, step: 0.005, value: S.streak, def: dv('streak'), fmt: (v) => (v === 0 ? 'off' : Math.round(v * 1000) + ' ms'), tip: 'Draws fast spray as short streaks along its motion, like a camera shutter of this length.', onInput: (v) => { S.streak = v; lastGen = -1; } });
  seg('#seg-detail', (v) => { S.detail = +v; lastGen = -1; });
  seg('#seg-bg', (v) => {
    S.bg = v; stage.classList.toggle('black', v === 'black'); stage.classList.toggle('light', v === 'light');
    const grey = v === 'light';   // dark lines on the light background, light lines on the dark ones
    lineMat.color.setHex(grey ? 0x2b333b : 0x8a949e); lineMat.opacity = grey ? 0.55 : 0.5;
    gridMat.color.setHex(grey ? 0x2b333b : 0x8a949e); gridMat.opacity = grey ? 0.22 : 0.2;
  });

  // bake group, rebuilt when the engine changes
  const gb = $('#g-bake'); const bakeAnchor = $('#bake-est');
  const bakeHolder = document.createElement('div'); bakeHolder.className = 'params'; gb.insertBefore(bakeHolder, bakeAnchor);
  function buildBakeUI() {
    bakeHolder.innerHTML = '';
    addSlider(bakeHolder, { id: 'b-dur', label: 'Duration', min: 1, max: 60, step: 0.5, value: S.bk.dur, fmt: (v) => v.toFixed(1) + ' s', tip: 'Length of the bake. The same as the timeline length.', onInput: (v) => { setDur(v); } });
    const fpsRow = document.createElement('div'); fpsRow.className = 'row plain';
    fpsRow.innerHTML = '<label data-tip="Frames stored per second of the bake.">Frame rate</label><div class="seg" id="seg-fps" role="group" aria-label="Frame rate"><button type="button" data-v="24" aria-pressed="' + (S.bk.fps === 24) + '">24</button><button type="button" data-v="30" aria-pressed="' + (S.bk.fps === 30) + '">30</button><button type="button" data-v="60" aria-pressed="' + (S.bk.fps === 60) + '">60</button></div>';
    bakeHolder.appendChild(fpsRow);
    seg('#seg-fps', (v) => { S.bk.fps = +v; updateEst(); });
    const dRow = document.createElement('div'); dRow.className = 'row plain';
    dRow.innerHTML = '<label data-tip="Same as live bakes exactly what you see in the live view. 1.5× and 2× divide the spacing by that much and raise Max points to match, for a more detailed bake of the same scene.">Detail</label><div class="seg" id="seg-bkdetail" role="group" aria-label="Bake detail"><button type="button" data-v="1">Same as live</button><button type="button" data-v="1.5">1.5×</button><button type="button" data-v="2">2×</button></div>';
    bakeHolder.appendChild(dRow); setSeg($('#seg-bkdetail'), S.bkDetail);
    seg('#seg-bkdetail', (v) => { S.bkDetail = +v; updateEst(); });
    const ri = document.createElement('div'); ri.className = 'pos'; ri.id = 'bake-res'; bakeHolder.appendChild(ri);
    updateEst();
  }
  function setEngine(eng) {
    if (S.baking) return;
    applyPreset(eng); buildLiveUI(); buildBakeUI(); makeSim(); $('#capshow').textContent = fmtN(S.cap);
    resetSim(S.tl.t);
  }

  // box size and open faces
  const gbx = $('#g-box');
  function commitBox() { makeSim(); resetSim(S.tl.t); updateDomainViz(); renderUI(); updateEst(); buildBoxUI(); }
  // move one face of the box (world coordinate v), keeping the box between 0.6 and 14 m
  function setFaceCoord(k, v) {
    const B = { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1 }, lo = k.endsWith('0');
    const other = B[lo ? k[0] + '1' : k[0] + '0'];
    B[k] = lo ? clamp(v, other - 14, other - 0.6) : clamp(v, other + 0.6, other + 14);
    S.min = { x: B.x0, y: B.y0, z: B.z0 }; S.dom = { w: B.x1 - B.x0, h: B.y1 - B.y0, d: B.z1 - B.z0 };
    updateDomainViz();
  }
  function setDomain(w, h, d) {
    S.dom = { w, h, d }; S.min = { x: -w / 2, y: 0, z: -d / 2 }; updateDomainViz();
    for (const o of objs) if (o.kind === 'emitter') { clampEm(o, o.target); o.pos.copy(o.target); syncMesh(o); }
    cam.target.set(S.org.x, S.org.y + (Hh > 3.5 ? Hh * 0.46 : Hh * 0.27), S.org.z); cam.r = clamp(2.1 * Math.max(W, Dd, Hh * 1.1), 3, 24); updateCam();
    commitBox();
  }
  const FACE_ROWS = [['x0', 'Left (-X)'], ['x1', 'Right (+X)'], ['y0', 'Floor'], ['y1', 'Top'], ['z0', 'Back (-Z)'], ['z1', 'Front (+Z)']];
  function buildBoxUI() {
    gbx.querySelectorAll(':scope > :not(h2)').forEach((n) => n.remove());
    gbx.querySelector('h2').dataset.tip = 'Drag the coloured arrows on the box in the view, or type a position for each face. Tick Open to delete particles that cross that face.';
    FACE_ROWS.forEach(([k, lab]) => {
      const row = document.createElement('div'); row.className = 'row face';
      row.innerHTML = '<label for="face-' + k + '">' + lab + '</label><input type="number" id="face-' + k + '" step="0.1" value="' + (+b[k].toFixed(3)) + '"><label class="check"><input type="checkbox" id="open-' + k + '"' + (S.open[k] ? ' checked' : '') + '><span>Open</span></label>';
      row.querySelector('input[type=number]').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { setFaceCoord(k, v); commitBox(); } else e.target.value = +b[k].toFixed(3); });
      row.querySelector('input[type=checkbox]').addEventListener('change', (e) => { S.open[k] = e.target.checked; applyOpen(); updateDomainViz(); });
      gbx.appendChild(row);
    });
    const sz = document.createElement('div'); sz.className = 'pos'; sz.id = 'box-size';
    sz.innerHTML = 'size <b>' + S.dom.w.toFixed(2) + '</b> × <b>' + S.dom.h.toFixed(2) + '</b> × <b>' + S.dom.d.toFixed(2) + '</b> m. Changing the box restarts the particles.'; gbx.appendChild(sz);
    const fr = document.createElement('div'); fr.className = 'row face';
    fr.innerHTML = '<label for="fill-h">Fill tank</label><input type="number" id="fill-h" step="0.1" value="' + (+Math.min(1, S.dom.h * 0.4).toFixed(2)) + '"><button type="button" class="btn flat" id="btn-filltank">to height</button>';
    fr.querySelector('button').addEventListener('click', () => {
      const h = Math.max(0.1, Math.min(S.dom.h, parseFloat(fr.querySelector('input').value) || 1)); pushUndo();
      const o = makeObj('cube', { water: true, name: 'Tank water', x: (b.x0 + b.x1) / 2, y: b.y0 + h / 2, z: (b.z0 + b.z1) / 2, hx: S.dom.w / 2 - 0.02, hy: h / 2, hz: S.dom.d / 2 - 0.02 });
      select(o); fillNow(o);
    });
    gbx.appendChild(fr);
    const hl = document.createElement('label'); hl.className = 'check';
    hl.innerHTML = '<input type="checkbox" id="show-handles"' + (S.handles ? ' checked' : '') + '><span>Show face arrows</span>';
    hl.querySelector('input').addEventListener('change', (e) => { S.handles = e.target.checked; });
    gbx.appendChild(hl);
  }
  buildBoxUI();

  // what the bake uses: the shared Simulation settings, optionally finer. Substep limits are per 1/60 s in the live view, so they are converted to the bake frame rate.
  function bakeRes() {
    const P = PRESET[S.engine], f = S.bkDetail || 1, fps = S.bk.fps || 24, k = 60 / fps;
    const d = +(S.liveD / f).toFixed(4);
    const maxN = Math.round(Math.min(S.cap * f * f * f, Math.max(P.bkMax, S.cap)));
    const lo = Math.max(1, S.subMin | 0), hi = Math.max(lo, S.subMax | 0);
    return { d, maxN, sub: Math.max(1, Math.ceil(lo * k * (S.engine === 'flip' ? 1 : f) - 1e-9)), maxSub: Math.max(1, Math.ceil(hi * k * f - 1e-9)), iters: S.iters };
  }
  function estimate() {
    const bk = Object.assign({}, S.bk, bakeRes()), d3 = bk.d * bk.d * bk.d;
    let fill = 0;
    for (const f of resolveFills()) fill += f.t === 'box' ? (f.x1 - f.x0) * (f.y1 - f.y0) * (f.z1 - f.z0) : f.t === 'vol' ? (f.hi[0] - f.lo[0]) * (f.hi[1] - f.lo[1]) * (f.hi[2] - f.lo[2]) * (f.sdf.fillFrac || 0.6) : (4 / 3) * Math.PI * f.r ** 3;
    for (const e of S.events) fill += (4 / 3) * Math.PI * e.r ** 3;
    let flow = 0;
    for (const o of objs) if (o.kind === 'emitter' && o.on) flow += Math.PI * o.radius * o.radius * Math.max(o.speed, 0.3) * (o.mode === 'random' ? o.density : 0.85);
    if (S.ocean.on && S.engine === 'flip') fill += S.dom.w * S.dom.d * S.ocean.level * S.dom.h;
    let n0 = fill / d3;
    if (nbActive()) n0 = Math.min(n0, S.dom.w * S.dom.d * S.nbBand * bk.d * S.cellRatio / d3 * 1.35);   // narrow band: about one band-deep layer across the box, plus spare slots
    const n1 = n0 + (flow * bk.dur) / d3;
    const frames = Math.round(bk.dur * bk.fps);
    const capped = Math.min(n1, bk.maxN);
    const bytes = frames * ((n0 + capped) / 2) * 7;
    return { n0, n1, capped, frames, mb: bytes / 1048576, steps: frames * bk.sub, over: n1 > bk.maxN };
  }
  function updateEst() {
    const e = estimate(); const el = $('#bake-est');
    const br = $('#bake-res'); if (br) { const r = bakeRes(), c = isGpu() ? gridCost(r.d, S.cellRatio, r.maxN) : null, bad = c && c.biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27);
      br.innerHTML = 'Spacing <b>' + r.d.toFixed(3) + ' m</b>, max <b>' + fmtN(r.maxN) + '</b> points, ' + (S.engine === 'flip' ? r.sub + ' to ' + r.maxSub + ' substeps' : r.sub + ' substeps') + ' a frame, ' + r.iters + ' iterations.' + (bad ? ' TOO BIG for this GPU: pick less detail or lower Max points.' : '') + (nbActive() ? ' Narrow band: particles only in the band under the surface.' : '');
      br.classList.toggle('warn', !!bad); }
    el.classList.toggle('warn', e.over);
    el.innerHTML = 'About <b>' + fmtN(Math.round(e.capped)) + '</b> points, <b>' + e.frames + '</b> frames, <b>' + e.steps + '</b> solver steps, cache around <b>' + e.mb.toFixed(0) + ' MB</b>.' +
      (e.over ? '<br>This scene would reach ' + fmtN(Math.round(e.n1)) + ' points. Emission stops when Max points is full.' : '');
  }

  // ---------- object list and parameters ----------
  let tf = null;   // active modal transform
  function addVec(parent, label, ids, vals, step, onSet) {
    const row = document.createElement('div'); row.className = 'row vec';
    row.innerHTML = '<label>' + label + '</label>' + ['x', 'y', 'z'].map((a, i) => '<input type="number" id="' + ids + a + '" step="' + step + '" value="' + (+vals[i].toFixed(3)) + '" aria-label="' + label + ' ' + a.toUpperCase() + '">').join('');
    row.querySelectorAll('input').forEach((inp, i) => inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!isNaN(v)) onSet(i, v); }));
    parent.appendChild(row);
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
      pushUndo(); const t = o.target; if (i === 0) t.x = v; else if (i === 1) t.y = v; else t.z = v; if (!S.playing) o.pos.copy(t); syncMesh(o); if (!S.playing) autoKey(o);
    });
    if (o.kind === 'mesh') {
      const wl = document.createElement('label'); wl.className = 'check';
      wl.innerHTML = '<input type="checkbox" id="' + pre + 'water"' + (o.water ? ' checked' : '') + '><span data-tip="The shape is filled with water instead of colliding. Moving or resizing it takes effect when you press Reset.">Water volume</span>';
      wl.querySelector('input').addEventListener('change', (e) => { pushUndo(); o.water = e.target.checked; waterStyle(o); if (o.water) fillNow(o); renderUI(); updateEst(); });
      p.appendChild(wl);
      if (o.water) {
        btn(p, 'Fill now', 'btn-fillnow', () => fillNow(o));
      }
      addVec(p, 'Rotation', 'rot-', [o.rx * R2D, o.yaw * R2D, o.rz * R2D], 5, (i, v) => {
        pushUndo(); const r = v / R2D; if (i === 0) o.rx = r; else if (i === 1) o.yaw = r; else o.rz = r; syncMesh(o); if (!S.playing) autoKey(o);
      });
      const bb = meshBounds(o.mesh), sz = bb.hi.map((h, k) => h - bb.lo[k]);
      const dim = document.createElement('div'); dim.className = 'pos'; dim.id = 'dim-readout';
      dim.innerHTML = 'size <b>' + sz[0].toFixed(2) + '</b> × <b>' + sz[1].toFixed(2) + '</b> × <b>' + sz[2].toFixed(2) + '</b> m · ' + o.mesh.v.length + ' points';
      p.appendChild(dim);
    }
    if (o.kind === 'emitter') {
      const lab = document.createElement('label'); lab.className = 'check';
      lab.innerHTML = '<input type="checkbox" id="' + pre + 'on"' + (o.on ? ' checked' : '') + '><span>Emitting</span>';
      lab.querySelector('input').addEventListener('change', (e) => { o.on = e.target.checked; sync(); updateEst(); if (!S.playing) autoKey(o); });
      p.appendChild(lab);
      const modeRow = document.createElement('div'); modeRow.className = 'row plain';
      modeRow.innerHTML = '<label>Emission</label><div class="seg" id="' + pre + 'mode" role="group" aria-label="Emission mode"><button type="button" data-v="smooth" aria-pressed="' + (o.mode === 'smooth') + '">Smooth</button><button type="button" data-v="random" aria-pressed="' + (o.mode === 'random') + '">Random</button></div>';
      p.appendChild(modeRow);
      modeRow.querySelector('.seg').addEventListener('click', (e) => {
        const bt = e.target.closest('button'); if (!bt) return; o.mode = bt.dataset.v; renderUI(); updateEst();
      });
      addSlider(p, { id: pre + 'speed', label: 'Speed', min: 0, max: 10, step: 0.1, value: o.speed, fmt: f1, onInput: (v) => { o.speed = v; sync(); updateEst(); if (!S.playing) autoKey(o); } });
      addSlider(p, { id: pre + 'rad', label: 'Radius', min: 0.03, max: 0.5, step: 0.01, value: o.radius, fmt: f2, onInput: (v) => { o.radius = v; sync(); updateEst(); } });
      addSlider(p, { id: pre + 'az', label: 'Heading', min: -180, max: 180, step: 1, value: Math.round(o.az), fmt: (v) => v + '°', onInput: (v) => { o.az = v; sync(); } });
      addSlider(p, { id: pre + 'el', label: 'Pitch', min: -90, max: 90, step: 1, value: Math.round(o.el), fmt: (v) => v + '°', onInput: (v) => { o.el = v; sync(); } });
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
    if (o.kind === 'mesh') { set('rot-x', o.rx * R2D); set('rot-y', o.yaw * R2D); set('rot-z', o.rz * R2D); }
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
        x: o.pos.x, y: o.pos.y, z: o.pos.z, rx: o.rx, yaw: o.yaw, rz: o.rz, spin: o.spin, name: o.name.replace(/\.\d+$/, '') + '.001',
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

  // ---------- keyframes and timeline ----------
  const kfNames = $('#kf-names'), kfTracks = $('#kf-tracks');
  const FPS_TL = 24;
  function sortKeys(o) { o.keys.sort((a, c) => a.t - c.t); }
  function poseOf(o) {
    const src = S.playing ? o.pos : o.target;
    const k = { t: 0, x: src.x, y: src.y, z: src.z, rx: o.rx || 0, yaw: o.yaw || 0, rz: o.rz || 0 };
    if (o.kind === 'emitter') { k.on = o.on; k.speed = o.speed; }
    return k;
  }
  function addKey(o, t) {
    t = clamp(Math.round(t * FPS_TL) / FPS_TL, 0, S.tl.dur);
    const k = poseOf(o); k.t = t;
    const ex = o.keys.find((q) => Math.abs(q.t - t) < 0.5 / FPS_TL);
    if (ex) Object.assign(ex, k, { t: ex.t }); else o.keys.push(k);
    sortKeys(o); S.selKey = { o, k: ex || k }; renderKF(); updateEst(); lcClear();
  }
  function autoKey(o) { if (S.tl.auto && o.keys.length) addKey(o, S.tl.t); }
  function deleteKey() {
    const sk = S.selKey; if (!sk) return;
    const i = sk.o.keys.indexOf(sk.k); if (i >= 0) sk.o.keys.splice(i, 1);
    S.selKey = null; renderKF(); updateEst(); lcClear();
  }
  // put every keyed object where its keys say it is at time t
  function applyKeysAt(t) {
    for (const o of objs) {
      if (!o.keys.length) continue;
      const k = keyPose(o.keys, t, S.tl.smooth);
      o.target.set(k.x, k.y, k.z); o.pos.copy(o.target); o.rx = k.rx || 0; o.yaw = k.yaw || 0; o.rz = k.rz || 0;
      if (o.kind === 'emitter') { if (k.on !== undefined) o.on = k.on; if (k.speed !== undefined) o.speed = k.speed; }
      syncMesh(o);
    }
  }
  function setDur(v) {
    v = clamp(Math.round(v * 2) / 2, 1, 60); S.tl.dur = v; S.bk.dur = v;
    for (const o of objs) for (const k of o.keys) if (k.t > v) k.t = v;
    $('#kf-dur').value = v;
    const bd = $('#b-dur'); if (bd) { bd.value = v; bd.parentNode.querySelector('output').textContent = v.toFixed(1) + ' s'; }
    S.tl.t = Math.min(S.tl.t, v); renderKF(); updateEst();
  }
  const tAt = (clientX) => { const r = kfTracks.getBoundingClientRect(); return clamp((clientX - r.left) / r.width, 0, 1) * S.tl.dur; };
  function renderKF() {
    kfNames.innerHTML = ''; kfTracks.innerHTML = '';
    const sp = document.createElement('div'); sp.className = 'spacer'; kfNames.appendChild(sp);
    const sp2 = document.createElement('div'); sp2.className = 'spacer c'; kfNames.appendChild(sp2);
    const ruler = document.createElement('div'); ruler.className = 'kf-ruler'; ruler.dataset.role = 'ruler';
    const step = S.tl.dur > 24 ? 5 : S.tl.dur > 12 ? 2 : 1;
    for (let sec = 0; sec <= S.tl.dur + 1e-6; sec += step) {
      const x = (sec / S.tl.dur) * 100;
      ruler.insertAdjacentHTML('beforeend', '<i style="left:' + x + '%"></i><span style="left:' + x + '%">' + sec + 's</span>');
    }
    kfTracks.appendChild(ruler);
    // cache lanes, coloured like Houdini's: blue cached in memory, orange out of date, purple baked, stripes baking now
    const lanes = document.createElement('div'); lanes.className = 'kf-cache'; lanes.dataset.role = 'ruler';
    lanes.dataset.tipTitle = 'Cache'; lanes.dataset.tip = 'Blue: cached in memory, plays back without simulating. Orange: out of date because something changed; Reset simulates it again. Purple: baked frames (click to play the bake). Stripes: baking now.';
    lanes.innerHTML = '<i id="bk-bar" data-role="bake" hidden></i><i id="bk-prog" hidden></i><i id="lc-stale" hidden></i><i id="lc-bar" hidden></i>';
    kfTracks.appendChild(lanes);
    for (const o of objs) {
      const nm = document.createElement('div'); nm.textContent = o.name; nm.className = o === selected ? 'cur' : '';
      nm.addEventListener('click', () => select(o)); kfNames.appendChild(nm);
      const row = document.createElement('div'); row.className = 'kf-row' + (o === selected ? ' cur' : ''); row.dataset.role = 'row'; row.dataset.oid = o.id;
      for (const k of o.keys) {
        const d = document.createElement('div'); d.className = 'kf-key' + (o.kind === 'emitter' ? ' emitter' : '') + (S.selKey && S.selKey.k === k ? ' cur' : '');
        d.style.left = (k.t / S.tl.dur) * 100 + '%'; d.dataset.role = 'key'; d.title = o.name + ' at ' + k.t.toFixed(2) + ' s';
        d._o = o; d._k = k; row.appendChild(d);
      }
      kfTracks.appendChild(row);
    }
    const ph = document.createElement('div'); ph.className = 'kf-ph'; ph.id = 'kf-ph'; kfTracks.appendChild(ph);
    updatePlayhead(); if (typeof lcUi === 'function') lcUi();
  }
  function updatePlayhead() {
    const ph = $('#kf-ph'); if (!ph) return;
    ph.style.left = (clamp(S.tl.t, 0, S.tl.dur) / S.tl.dur) * 100 + '%';
    $('#kf-time').textContent = S.tl.t.toFixed(2) + ' s · frame ' + (Math.round(S.tl.t * FPS_TL) + 1) + ' / ' + Math.round(S.tl.dur * FPS_TL);
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
    if (kdrag.type === 'head') scrubTo(S.tl.t, true); else if (kdrag.moved) { const t = S.tl.t; applyKeysAt(t); updateEst(); lcClear(); }
    kdrag = null; renderUI();
  }
  kfTracks.addEventListener('pointerup', endKdrag); kfTracks.addEventListener('pointercancel', endKdrag);
  // move the playhead. final = true restarts the particles from this time.
  function scrubTo(t, final) {
    t = clamp(t, 0, S.tl.dur); setPlaying(false); S.tl.t = t;
    if (lcCanPlay(t)) { lcEnter(t); updatePlayhead(); return; }
    applyKeysAt(t);
    if (final) resetSim(t); else updatePlayhead();
    updatePlayhead();
  }
  $('#kf-rewind').addEventListener('click', () => { scrubTo(0, true); renderUI(); });
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

  // ---------- buttons ----------
  function setPlaying(v) {
    S.playing = v;
    $('#btn-play').setAttribute('aria-pressed', v ? 'true' : 'false');
    $('#ico-pause').toggleAttribute('hidden', !v); $('#ico-play').toggleAttribute('hidden', v); $('#play-label').textContent = v ? 'Stop' : 'Start';
    if (typeof updStatus === 'function') try { updStatus(); } catch (e) { /* panel not ready */ }
  }
  function setCPlay(v) {
    S.cplay = v;
    $('#ico-cpause').toggleAttribute('hidden', !v); $('#ico-cplay').toggleAttribute('hidden', v); $('#cplay-label').textContent = v ? 'Pause' : 'Play';
    $('#btn-cplay').setAttribute('aria-pressed', v ? 'true' : 'false');
  }
  $('#btn-play').addEventListener('click', () => setPlaying(!S.playing));
  $('#btn-cplay').addEventListener('click', () => { if (!S.cplay && S.cache && S.ct >= S.cache.frames.length - 1) S.ct = 0; setCPlay(!S.cplay); });
  $('#btn-crewind').addEventListener('click', () => { S.ct = 0; });
  $('#btn-reset').addEventListener('click', () => { if (tf) return; lcRestart(0); renderUI(); renderKF(); updatePlayhead(); });
  $('#scene').addEventListener('change', (e) => loadScene(e.target.value));
  $('#btn-drop').addEventListener('click', () => {
    if (S.lcPlay) lcClear();
    const x = (Math.random() - 0.5) * Math.min(0.8, S.dom.w * 0.5), z = (Math.random() - 0.5) * Math.min(0.8, S.dom.d * 0.5);
    const y = Math.max(0.6, Math.min(2.0, S.dom.h - 0.5));
    sim.fillSphere(x, y, z, 0.38, 0, -1, 0);
    S.events.push({ t: S.frame / 60, x, y, z, r: 0.38, done: true }); updateEst();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') S.shift = true;
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) {
      e.preventDefault(); if (viewMode() === 'cache') $('#btn-cplay').click(); else setPlaying(!S.playing);
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') S.shift = false; });

  // ---------- modes ----------
  function viewMode() { return S.tab === 'bake' && S.cache ? 'cache' : 'live'; }
  function applyMode() {
    const cache = viewMode() === 'cache';
    $('#tab-live').hidden = S.tab !== 'live'; $('#tab-bake').hidden = S.tab !== 'bake';
    $('#bar-live').hidden = cache; $('#bar-cache').hidden = !cache;
    $('#tl-live').hidden = cache; $('#tl-cache').hidden = !cache; $('#kf').hidden = cache;
    setSeg($('#seg-mode'), S.tab); hud();
    try { syncPtab(); } catch (e) { /* the layout code runs later at start */ }
    resize();
  }
  seg('#seg-mode', (v) => { S.tab = v; if (v === 'bake') { updateEst(); } applyMode(); });

  // ---------- baking ----------
  let worker = null, sharedSrc = '';
  function buildDesc() {
    const bk = Object.assign({}, S.bk, bakeRes());
    return {
      d: bk.d, maxN: bk.maxN, fps: bk.fps, substeps: bk.sub, frames: Math.round(bk.dur * bk.fps), g: S.g / (S.scale || 1), iters: bk.iters, visc: S.visc, flip: S.flip, comp: 6, cellRatio: S.cellRatio, fastAir: S.fastAir, sortP: S.sortP, maxSub: bk.maxSub, detail: S.bkDetail || 1, colMax: simPar().colMax, vmaxW: simPar().vmax, wind: simPar().wind, drag: simPar().drag, gust: simPar().gust, foamSens: simPar().foamSens, foamTau: S.foamTau,
      scale: S.scale || 1, tear: simPar().tear, spr: simPar().spr, air: simPar().air, drip: simPar().drip, nb: nbCfg(), ocean: oceanCfg(), sprayCap: S.sprOn && S.engine === 'flip' ? S.sprCap : 0, nbLook: !!(S.nbLook && nbActive()), size: [S.dom.w, S.dom.h, S.dom.d], open: openMask(),
      fills: resolveFills().map((f) => Object.assign({}, f)), events: S.events.map((e) => Object.assign({}, e)),
      objs: objs.map((o) => Object.assign(snap(o), { rec: o.rec && o.rec.arr.length >= 4 ? { start: o.rec.start, arr: Float32Array.from(o.rec.arr, (v, i) => v - (i % 4 === 0 ? S.org.x : i % 4 === 1 ? S.org.y : i % 4 === 2 ? S.org.z : 0)) } : null, keys: o.keys.length ? o.keys.map((k) => Object.assign({}, k, { x: k.x - S.org.x, y: k.y - S.org.y, z: k.z - S.org.z })) : null, smooth: S.tl.smooth }))
    };
  }
  function setBakeUI(running) {
    $('#btn-bake').disabled = running; $('#btn-cancel').hidden = !running; $('#bake-progress').hidden = !running;
    $('#seg-mode').querySelectorAll('button').forEach((x) => { x.disabled = running; });
  }
  function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function cacheBytes(c) { let n = 0; for (const f of c.frames) n += f.pos.byteLength + f.spd.byteLength + f.objs.byteLength + (f.fm ? f.fm.byteLength : 0) + (f.sp ? f.sp.pos.byteLength + f.sp.pk.byteLength : 0) + (f.dp ? f.dp.pos.byteLength + f.dp.spd.byteLength : 0); return n; }

  // the bake settings without the heavy parts (distance grids, recorded motion), for the cache file and the report
  function lightDesc(desc) {
    const d = Object.assign({}, desc);
    d.fills = (desc.fills || []).map((f) => (f.sdf ? Object.assign({}, f, { sdf: { dims: f.sdf.dims, cell: f.sdf.cell } }) : f));   // water volumes without their distance grids
    d.objs = desc.objs.map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, z: o.z, rx: o.rx, yaw: o.yaw, rz: o.rz, spin: o.spin, on: o.on, speed: o.speed, radius: o.radius, water: o.water, keys: o.keys, recFrames: o.rec ? o.rec.arr.length / 4 : 0, sdfCells: o.sdf ? o.sdf.dims : null }));
    return d;
  }
  function onBakeFrame(fr, info, cache) {
    cache.frames.push(fr);
    if (info.diag && cache.diag) cache.diag.push(Object.assign({ f: info.f, t: info.f / cache.fps, n: info.n, elapsed: info.elapsed }, info.diag));
    cache.maxN = Math.max(cache.maxN, fr.n);
    const pct = (info.f / info.F) * 100; S.bakeT = info.f / cache.fps; lcUi();
    $('#bake-prog').style.width = pct + '%';
    const eta = info.f > 0 ? (info.elapsed / info.f) * (info.F - info.f) : 0;
    $('#bake-status').innerHTML = 'Frame <b>' + info.f + '</b> of ' + info.F + ' · <b>' + fmtN(info.n) + '</b> points · ' + fmtTime(info.elapsed) + ' elapsed, about ' + fmtTime(eta) + ' left' + (info.full ? '<br>Max points reached, emission stopped.' : '');
  }
  function finishBake(cache, cancelled) {
    S.baking = false; setBakeUI(false); S.bakeT = 0;
    if (worker) { worker.terminate(); worker = null; }
    if (cancelled || cache.frames.length < 2) {
      $('#bake-status').textContent = cancelled ? 'Bake cancelled.' : 'Nothing was baked.'; return;
    }
    S.cache = cache; S.ct = 0; setCPlay(true);
    buildTicks(); updateCacheInfo();
    $('#bake-status').innerHTML = 'Baked <b>' + (cache.frames.length - 1) + '</b> frames in ' + fmtTime(cache.seconds) + '.';
    applyMode(); lcUi();
  }
  function startBake() {
    if (S.baking) return;
    setPlaying(false);
    const desc = buildDesc();
    if (!desc.frames) return;
    if (isGpu() && gridCost(desc.d, S.cellRatio, desc.maxN).biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27)) { $('#bake-status').textContent = 'That bake does not fit in one GPU buffer here. Pick less detail or lower Max points.'; flash('Bake too big for this GPU.'); return; }
    const cache = { b: { x0: -W / 2, x1: W / 2, y0: 0, y1: Hh, z0: -Dd / 2, z1: Dd / 2 }, org: Object.assign({}, S.org), fps: desc.fps, d: desc.d, frames: [], maxN: 0, ids: desc.objs.map((o) => o.id), seconds: 0, startedAt: Date.now(),
      engine: S.engine, scene: sceneData(), desc: lightDesc(desc), diag: [], stableIds: true, scale: S.scale || 1 };
    S.baking = true; setBakeUI(true); S.bakeT = 0; lcUi();
    $('#bake-prog').style.width = '0%'; $('#bake-status').textContent = 'Starting…';
    const done = (cancelled) => { cache.seconds = (Date.now() - cache.startedAt) / 1000; finishBake(cache, cancelled); };
    if (isGpu()) {
      S.cancelPage = false;
      (S.engine === 'flip' ? runBakeFlipGpu : runBakeGpu)(desc, S.gpu, (fr, info) => onBakeFrame(fr, info, cache), () => S.cancelPage).then((ok) => done(!ok))
        .catch((err) => { (window.__errLog = window.__errLog || []).push({ t: new Date().toISOString(), msg: 'Bake failed: ' + (err && err.stack ? err.stack : err) }); S.baking = false; setBakeUI(false); $('#bake-status').textContent = 'The GPU bake failed: ' + (err && err.message ? err.message : err) + '. Try a larger spacing or a lower Max points.'; });
      return;
    }
    let usedWorker = false;
    try {
      const src = sharedSrc + '\nlet cancelled = false;\nself.onmessage = async (e) => { const m = e.data; if (m.type === "cancel") { cancelled = true; return; }' +
        ' if (m.type === "bake") { cancelled = false; const ok = await runBake(m.desc, (fr, info) => { self.postMessage({ type: "frame", fr, info }, [fr.pos.buffer, fr.spd.buffer, fr.objs.buffer]); }, () => cancelled); self.postMessage({ type: "done", cancelled: !ok }); } };';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url); usedWorker = true;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'frame') onBakeFrame(m.fr, m.info, cache);
        else if (m.type === 'done') done(m.cancelled);
      };
      worker.onerror = () => { worker = null; $('#bake-status').textContent = 'The worker failed. Trying again on the page itself, which will freeze the view while it runs.'; runOnPage(); };
      worker.postMessage({ type: 'bake', desc });
    } catch (err) { usedWorker = false; }
    if (!usedWorker) runOnPage();
    function runOnPage() {
      cache.frames = []; cache.maxN = 0; S.cancelPage = false;
      runBake(desc, (fr, info) => onBakeFrame(fr, info, cache), () => S.cancelPage).then((ok) => done(!ok));
    }
  }
  $('#btn-bake').addEventListener('click', startBake);
  $('#btn-cancel').addEventListener('click', () => { S.cancelPage = true; if (worker) worker.postMessage({ type: 'cancel' }); });

  function updateCacheInfo() {
    const c = S.cache, el = $('#cache-info');
    if (!c) { el.textContent = 'No cache yet.'; return; }
    const last = c.frames[c.frames.length - 1];
    el.innerHTML = '<b>' + (c.frames.length - 1) + '</b> frames at ' + c.fps + ' fps, up to <b>' + fmtN(c.maxN) + '</b> points, spacing ' + c.d.toFixed(3) + ', <b>' + (cacheBytes(c) / 1048576).toFixed(0) + ' MB</b> in memory.';
  }
  $('#c-loop').addEventListener('change', (e) => { S.cloop = e.target.checked; });
  seg('#seg-cspeed', (v) => { S.cspeed = +v; });
  $('#c-clear').addEventListener('click', () => { S.cache = null; updateCacheInfo(); applyMode(); lcUi(); });
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  }
  $('#c-save').addEventListener('click', (e) => {
    e.currentTarget.blur(); const c = S.cache; if (!c) { flash('Bake something first.'); return; }
    download(new Blob(writeCacheParts(c), { type: 'application/octet-stream' }), 'splashtank-bake.splc');
    flash('Saved splashtank-bake.splc (' + Math.round(cacheBytes(c) / 1048576) + ' MB) to your Downloads folder.');
  });
  // measurements from a stored frame, for bakes that did not record them while running
  function frameStats(fr, c) {
    const b = c.b || DEFB, qx = (b.x1 - b.x0) / 65535, qy = (b.y1 - b.y0) / 65535, qz = (b.z1 - b.z0) / 65535, H = 16, hist = new Array(H).fill(0);
    let alive = 0, sx = 0, sy = 0, sz = 0, ss = 0, smax = 0, fl = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < fr.n; i++) {
      if (fr.spd[i] === 255) continue;
      alive++;
      const x = fr.pos[i * 3] * qx + b.x0, y = fr.pos[i * 3 + 1] * qy + b.y0, z = fr.pos[i * 3 + 2] * qz + b.z0, sp = fr.spd[i] / 16;
      sx += x; sy += y; sz += z; ss += sp; if (sp > smax) smax = sp; if (fr.fm) fl += fr.fm[i] / 255;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      hist[Math.max(0, Math.min(H - 1, Math.floor((y - b.y0) / ((b.y1 - b.y0) / H))))]++;
    }
    const a = Math.max(alive, 1);
    return { n: fr.n, alive, gone: fr.n - alive, meanSpeed: ss / a, maxSpeed: smax, meanFoam: fl / a, center: [sx / a, sy / a, sz / a], bbox: alive ? [x0, y0, z0, x1, y1, z1] : null, heightHist: hist };
  }
  $('#c-report').addEventListener('click', (e) => {
    e.currentTarget.blur(); const c = S.cache; if (!c) { flash('Bake something first.'); return; }
    const rnd = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(rnd) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, q]) => [k, rnd(q)])) : v);
    const per = c.diag && c.diag.length ? c.diag : c.frames.map((fr, f) => Object.assign({ f, t: f / c.fps }, frameStats(fr, c)));
    const names = {}; ((c.scene && c.scene.objs) || []).forEach((o) => { names[o.id] = o.name || o.shape; });
    // a sample of points at about ten frames: x, y, z, speed (16ths of m/s, stored up to about 12 m/s), white water 0..1
    const b = c.b || DEFB, qx = (b.x1 - b.x0) / 65535, qy = (b.y1 - b.y0) / 65535, qz = (b.z1 - b.z0) / 65535, F = c.frames.length, picks = new Set();
    for (let k = 0; k < 10; k++) picks.add(Math.round((k / 9) * (F - 1)));
    const snapshots = [...picks].map((f) => {
      const fr = c.frames[f], step = Math.max(1, Math.ceil(fr.n / 3000)), pts = [];
      for (let i = 0; i < fr.n; i += step) { if (fr.spd[i] === 255) continue; pts.push([fr.pos[i * 3] * qx + b.x0, fr.pos[i * 3 + 1] * qy + b.y0, fr.pos[i * 3 + 2] * qz + b.z0, fr.spd[i] / 16, fr.fm ? fr.fm[i] / 255 : 0]); }
      return { f, t: f / c.fps, points: fr.n, every: step, sample: pts };
    });
    const rep = {
      app: 'SplashTank bake report', version: 1, created: new Date().toISOString(), browser: navigator.userAgent, gpu: S.gpu ? { name: S.gpu.name, maxBuffer: S.gpu.maxBuf } : null,
      engine: c.engine || null, bakeSettings: c.desc || null,
      cache: { frames: F - 1, fps: c.fps, spacing: c.d, box: c.b, origin: c.org, maxPoints: c.maxN, seconds: c.seconds, megabytes: Math.round(cacheBytes(c) / 1048576) },
      objects: { ids: c.ids, names }, perFrame: per, objectPoses: { layout: 'per frame, per object: x y z rx yaw rz (solver coordinates)', frames: c.frames.map((fr) => Array.from(fr.objs)) },
      snapshots, errors: (window.__errLog || []).slice(-80), scene: c.scene || null
    };
    download(new Blob([JSON.stringify(rnd(rep))], { type: 'application/json' }), 'splashtank-bake-report.json');
    flash('Saved splashtank-bake-report.json to your Downloads folder. Attach it in the chat.');
  });

  function buildTicks() {
    const c = S.cache, F = c.frames.length - 1, tk = $('#ticks'); tk.innerHTML = '';
    const sc = $('#scrub'); sc.max = F; sc.value = 0;
    $('#c-total').textContent = String(F + 1).padStart(4, '0');
    for (let k = 0; k <= F; k += c.fps) {
      const s = document.createElement('span'); s.style.left = (k / F) * 100 + '%'; s.textContent = k / c.fps + 's'; tk.appendChild(s);
    }
  }
  $('#scrub').addEventListener('input', (e) => { S.ct = +e.target.value; });

  const DEFB = { x0: -1.5, x1: 1.5, y0: 0, y1: 2.6, z0: -1.5, z1: 1.5 };
  function showCache(t) {
    const c = S.cache, fr = c.frames, last = fr.length - 1; lastGen = -1;
    t = clamp(t, 0, last);
    // blend between frames only when the same slot is the same particle in both (older caches with sorting were not saved that way)
    const a = Math.floor(t), bi = Math.min(a + 1, last), w = c.stableIds ? t - a : 0, A = fr[a], B = fr[bi];
    const nA = A.n, nB = B.n, pa = A.pos, pb = B.pos, sa = A.spd, sb = B.spd, fa = A.fm, fb = B.fm, og = c.org || { x: 0, y: 0, z: 0 };
    const cb = c.b || DEFB, qx = (cb.x1 - cb.x0) / 65535, qy = (cb.y1 - cb.y0) / 65535, qz = (cb.z1 - cb.z0) / 65535;
    let n = 0;
    for (let i = 0; i < nB; i++) {
      if (sb[i] === 255) continue;   // left the box through an open face
      const j = i * 3;
      let x = pb[j] * qx + cb.x0, y = pb[j + 1] * qy + cb.y0, z = pb[j + 2] * qz + cb.z0, s = sb[i];
      if (i < nA && w < 1 && sa[i] !== 255) {
        const x0 = pa[j] * qx + cb.x0, y0 = pa[j + 1] * qy + cb.y0, z0 = pa[j + 2] * qz + cb.z0;
        x = x0 + (x - x0) * w; y = y0 + (y - y0) * w; z = z0 + (z - z0) * w; s = sa[i] + (s - sa[i]) * w;
      }
      let fo = fb ? fb[i] / 255 : 0;
      if (i < nA && w < 1 && sa[i] !== 255) fo = (fa ? fa[i] / 255 : 0) + (fo - (fa ? fa[i] / 255 : 0)) * w;
      n = putPts(n, i, x, y, z, s / 16 + 64 * Math.round(fo * 15), S.detail, 0.5 * c.d);
    }
    n = putSpraySet((w < 0.5 ? A : B).sp, cb, n, 2 * c.d);
    n = putDeepSet((w < 0.5 ? A : B).dp, cb, n, 0.5 * c.d * ((c.desc && c.desc.cellRatio) || 2));
    uploadParticles(n);
    c.ids.forEach((id, k) => {
      const o = objs.find((q) => q.id === id); if (!o) return;
      const k4 = k * 6, ao = A.objs, bo = B.objs, L = (j) => ao[k4 + j] + (bo[k4 + j] - ao[k4 + j]) * w;
      o.group.position.set(L(0) + og.x, L(1) + og.y, L(2) + og.z);
      if (o.kind === 'mesh') o.group.rotation.set(L(3), L(4), L(5), 'ZYX');
    });
    return n;
  }


  // ---------- load a cache file ----------
  $('#cache-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const st = $('#load-status'); st.classList.remove('warn'); st.textContent = 'Reading ' + file.name + '…';
    try {
      const buf = await file.arrayBuffer();
      const c = parseCache(buf);
      if (c.frames.length < 2) throw new Error('The file has no frames.');
      if (c.scene && (c.ids || []).some((id) => !objs.find((o) => o.id === id))) { try { applySceneData(c.scene); } catch (e2) { /* keep the current scene */ } }
      S.cache = c; S.ct = 0; setCPlay(true); buildTicks(); updateCacheInfo(); S.tab = 'bake'; applyMode(); lcUi();
      st.textContent = 'Loaded ' + file.name + '.';
    } catch (err) { st.classList.add('warn'); st.textContent = 'Could not load the file: ' + err.message; }
    e.target.value = '';
  });

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
    p.appendChild(r1);
    const r2 = document.createElement('div'); r2.className = 'btnrow';
    btn(r2, 'Select all (A)', 'btn-all', () => selectAllEdit(true)); btn(r2, 'None (Alt+A)', 'btn-none', () => selectAllEdit(false));
    btn(r2, 'Done (Tab)', 'btn-done', () => exitEdit());
    p.appendChild(r2);
    const info = document.createElement('div'); info.className = 'pos'; info.id = 'edit-info'; p.appendChild(info);
    const note = document.createElement('div'); note.className = 'pos';
    note.textContent = 'Drag in empty space to box select. Shift+click adds or removes. The water sees the new shape as soon as you confirm each change. Keep the shape closed: extrude and move, but do not leave holes.';
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
    const R = eulerMat(o.rx, o.yaw, o.rz), nl = new THREE.Vector3(nx, ny, nz).normalize();
    const nw = new THREE.Vector3(R[0] * nl.x + R[1] * nl.y + R[2] * nl.z, R[3] * nl.x + R[4] * nl.y + R[5] * nl.z, R[6] * nl.x + R[7] * nl.y + R[8] * nl.z).normalize();
    startTf('g', { axis: 'n', nrm: nw, noUndo: true });
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
      rec = { edit: false, list, v0: list.map((o) => o.kind === 'mesh' && o.mesh ? o.mesh.v.map((q) => q.slice()) : null), orig: list.map((o) => ({ x: o.target.x, y: o.target.y, z: o.target.z, rx: o.rx, yaw: o.yaw, rz: o.rz, az: o.az, el: o.el, radius: o.radius })) };
    }
    if (!opts.noUndo) pushUndo();
    tf = Object.assign(rec, { type, pivot, axis: opts.axis || null, nrm: opts.nrm || null, plane: false, local: false, num: '', m0: { x: lastM.x, y: lastM.y }, fromDrag: !!opts.fromDrag, structural: !!opts.noUndo, ang: 0, prevA: null, d: new THREE.Vector3(), f: [1, 1, 1] });
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
      if (!t.axis) f[0] = f[1] = f[2] = k;
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
      if (o.kind === 'mesh' && o.mesh) { const R = eulerMat(q.rx, q.yaw, q.rz); o.mesh.v.forEach((v) => srcs.push(new THREE.Vector3(R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]).add(P0))); }
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
      const o = t.o, R = eulerMat(o.rx, o.yaw, o.rz), V = o.mesh.v;
      const toL = (w) => new THREE.Vector3(R[0] * w.x + R[3] * w.y + R[6] * w.z, R[1] * w.x + R[4] * w.y + R[7] * w.z, R[2] * w.x + R[5] * w.y + R[8] * w.z);
      t.vs.forEach((vi, k) => {
        const q = t.orig[k]; let r;
        if (t.type === 'g') { const dl = toL(t.d); r = [q[0] + dl.x, q[1] + dl.y, q[2] + dl.z]; }
        else if (t.type === 'r') {
          const al = toL(t.rotAxis).normalize(), v = new THREE.Vector3(q[0] - t.pivL[0], q[1] - t.pivL[1], q[2] - t.pivL[2]).applyAxisAngle(al, t.angRad || 0);
          r = [t.pivL[0] + v.x, t.pivL[1] + v.y, t.pivL[2] + v.z];
        } else { const M = t._M || (t._M = scaleMatL(R, t.f, useLocalAx())), w = mul3(M, q[0] - t.pivL[0], q[1] - t.pivL[1], q[2] - t.pivL[2]); r = [t.pivL[0] + w[0], t.pivL[1] + w[1], t.pivL[2] + w[2]]; }
        V[vi] = r;
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
          if (o.kind === 'mesh' && t.v0[k]) {   // the shape is scaled along the global or the object's own axes
            const M = scaleMatL(eulerMat(q.rx, q.yaw, q.rz), t.f, frameObj() ? useLocalAx() : S.orient === 'local');
            o.mesh.v = t.v0[k].map((v) => mul3(M, v[0], v[1], v[2])); meshGeo(o);
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
      rebuildSDF(t.o);
      meshGeo(t.o); edList = meshEdges(t.o.mesh); updateOverlay();
    } else {
      for (const o of t.list) {
        if (t.type === 's' && o.kind === 'mesh') { o.group.scale.set(1, 1, 1); meshGeo(o); rebuildSDF(o); }
        syncMesh(o);
        if (!S.playing && o.keys.length) autoKey(o);
      }
      updateEst();
    }
    renderUI(); hud();
  }
  function cancelTf() {
    if (!tf) return;
    const t = tf; tf = null; canvas.style.cursor = 'default';
    if (!t.edit) t.list.forEach((o) => o.group.scale.set(1, 1, 1));
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
    else return;
    evalTf();
  }

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
      if (k === '1' || k === '2' || k === '3') { e.preventDefault(); setSelMode(['', 'v', 'e', 'f'][+k]); return; }
      if (K === 'x' || k === 'Delete') { flash('Points and faces cannot be deleted because the collider has to stay closed. Move or scale them instead.'); return; }
      return;
    }
    if (K === 'x' || k === 'Delete') { if (k === 'Delete' && S.selKey) return; e.preventDefault(); deleteSelected(); return; }
    if (K === 'i') { e.preventDefault(); selSet.forEach((o) => addKey(o, S.tl.t)); return; }
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

  // ---------- save / load scene file ----------
  function sceneData() {
    const sn = snapScene();
    return {
      app: 'SplashTank', version: 2, saved: new Date().toISOString(),
      box: { min: S.min, size: S.dom, open: S.open },
      solver: { engine: S.engine, g: S.g, visc: S.visc, iters: S.iters, flip: S.flip, cap: S.cap, wind: S.wind, airDrag: S.airDrag, cellRatio: S.cellRatio, detail: S.detail, gust: S.gust, foamSens: S.foamSens, foam: S.foam, foamTau: S.foamTau, colMax: S.colMax, dragSpeed: S.dragSpeed, vmaxW: S.vmaxW, subMin: S.subMin, subMax: S.subMax, scale: S.scale, tear: S.tear, sprOn: S.sprOn, sprAmt: S.sprAmt, sprMin: S.sprMin, sprLife: S.sprLife, sprMist: S.sprMist, sprDrag: S.sprDrag, mistDrag: S.mistDrag, sprCap: S.sprCap, streak: S.streak, wwFoamLife: S.wwFoamLife, wwRise: S.wwRise, wwCrest: S.wwCrest, wwImpact: S.wwImpact, airOn: S.airOn, airCouple: S.airCouple, airDecay: S.airDecay, dripOn: S.dripOn, dripRate: S.dripRate, dripDry: S.dripDry, nbOn: S.nbOn, nbBand: S.nbBand, nbLook: S.nbLook, oceanView: S.oceanView }, ocean: S.ocean,
      timeline: S.tl, bake: { dur: S.bk.dur, fps: S.bk.fps, detail: S.bkDetail }, fills: S.fills, events: S.events.map((e) => Object.assign({}, e, { done: false })),
      objs: sn.objs.map((d) => Object.assign({}, d, { sdf: null, rec: d.rec ? { start: d.rec.start, arr: Array.from(d.rec.arr) } : null }))
    };
  }
  function applySceneData(d) {
    if (!d || d.app !== 'SplashTank' || !Array.isArray(d.objs)) throw new Error('This is not a SplashTank scene file.');
    const bx = d.box || {}, sv = d.solver || {};
    S.dom = Object.assign({ w: 3, h: 2.6, d: 3 }, bx.size); S.min = Object.assign({ x: -S.dom.w / 2, y: 0, z: -S.dom.d / 2 }, bx.min); S.open = Object.assign(ALLC(false), bx.open);
    for (const k of ['g', 'visc', 'iters', 'flip', 'cap', 'airDrag', 'cellRatio', 'detail', 'gust', 'foamSens', 'foam', 'foamTau', 'colMax', 'dragSpeed', 'vmaxW', 'subMin', 'subMax', 'scale', 'tear', 'sprAmt', 'sprMin', 'sprLife', 'sprMist', 'sprDrag', 'mistDrag', 'sprCap', 'streak', 'wwFoamLife', 'wwRise', 'wwCrest', 'wwImpact', 'airCouple', 'airDecay', 'dripRate', 'dripDry']) if (typeof sv[k] === 'number') S[k] = sv[k];
    for (const k of ['airOn', 'dripOn']) if (typeof sv[k] === 'boolean') S[k] = sv[k];
    if (typeof sv.sprOn === 'boolean') S.sprOn = sv.sprOn;
    if (typeof sv.nbOn === 'boolean') S.nbOn = sv.nbOn; if (typeof sv.nbBand === 'number') S.nbBand = sv.nbBand; if (typeof sv.oceanView === 'boolean') S.oceanView = sv.oceanView; if (typeof sv.nbLook === 'boolean') S.nbLook = sv.nbLook;
    S.ocean = Object.assign({}, OCEAN_DEF, d.ocean || {});
    if (sv.wind) S.wind = Object.assign({ speed: 0, az: 0, up: 0 }, sv.wind);
    if (d.timeline) Object.assign(S.tl, d.timeline);
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
    buildBoxUI(); buildLiveUI(); buildBakeUI();
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

  // ---------- benchmark ----------
  let benching = false;
  const bout = $('#bench-out');
  async function runBenchmark() {
    if (benching || S.baking) return;
    if (S.engine !== 'flip') { bout.value = 'The benchmark times the FLIP solver. Pick FLIP in the Live solver panel first.'; return; }
    benching = true; const wasPlaying = S.playing, endMode = S.tl.end, opt0 = Object.assign({}, sim.opt), sub0 = [S.subMin, S.subMax];
    S.subMin = 1; S.subMax = 1;   // one solver step per measured step
    setPlaying(false); S.tl.end = 'hold';
    const lines = [], say = (t) => { lines.push(t); bout.value = lines.join('\n'); bout.scrollTop = bout.scrollHeight; };
    const settle = () => sim.dev.queue.onSubmittedWorkDone();
    try {
      say('Warming up, this fills the scene with water first...');
      resetSim(0);
      for (let i = 0, W = window.__benchW || 150; i < W; i++) { stepOnce(); if (i % 10 === 9) await settle(); }
      await settle();
      const N = sim.N, M = window.__benchM || 24, ST = ['sort', 'blocks', 'clear', 'p2g', 'classify', 'normFaces', 'divergence', 'pressure', 'project', 'g2p', 'spray'];
      const f1 = (v) => v.toFixed(2), mb = (v) => Math.round(v / 1048576);
      const BASE = { noFoam: false, noCull: false, noSolidCache: false, fastAir: false, sort: true, sortEvery: 16, iters: 0 };
      let lastSum = null;
      const measure = async (label, opt, quiet) => {
        Object.assign(sim.opt, BASE, opt);
        const sum = {}; lastSum = sum; let cpu = 0, tot = 0;
        for (let r = 0; r < M; r++) {
          let cap = null; sim.step = (dt, o) => { cap = { dt, o }; };
          const t0 = performance.now(); stepOnce(); cpu += performance.now() - t0; delete sim.step;
          const t = await sim.stepTimed(cap.dt, cap.o); for (const k in t) sum[k] = (sum[k] || 0) + t[k];
        }
        for (let r = 0; r < M; r++) { const t0 = performance.now(); stepOnce(); await settle(); tot += performance.now() - t0; }
        if (quiet) return tot / M;
        let s = 0; const parts = ST.filter((k) => sum[k] !== undefined).map((k) => { const v = (sum[k] || 0) / M; s += v; return k + ' ' + f1(v); });
        say('');
        say(label);
        say('  whole step ' + f1(tot / M) + ' ms  (about ' + Math.round(1000 / (tot / M)) + ' steps/s), JS side ' + f1(cpu / M) + ' ms');
        say('  stages, each timed alone: ' + parts.join(', ') + '  (sum ' + f1(s) + ')');
        return tot / M;
      };
      await settle();
      const active = await sim.activeCells();
      const denseF = (sim.nx + 1) * sim.ny * sim.nz + sim.nx * (sim.ny + 1) * sim.nz + sim.nx * sim.ny * (sim.nz + 1);
      say('SplashTank benchmark');
      say('GPU: ' + (S.gpu && S.gpu.name) + '   Browser: ' + navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 90));
      say('FLIP, ' + N + ' particles, spacing ' + sim.d.toFixed(3) + ', grid cell ' + sim.ratio.toFixed(1) + '× spacing');
      say('Box ' + sim.nx + ' × ' + sim.ny + ' × ' + sim.nz + ' = ' + sim.ncell + ' cells, ' + active + ' hold water (' + (100 * active / sim.ncell).toFixed(1) + '%)');
      { const gridMB = sim.scap * (512 * 40 + 12) / 1048576; say('Sparse grid: ' + sim.blocksUsed + ' blocks of 8×8×8 in use (' + (100 * sim.blocksUsed * 512 / sim.ncell).toFixed(1) + '% of the box), room for ' + sim.scap + ' = ' + gridMB.toFixed(gridMB < 10 ? 1 : 0) + ' MB. As a full grid it would be ' + mb(denseF * 8 + sim.ncell * 24) + ' MB. Everything on the GPU: about ' + mb(sim.memBytes()) + ' MB'); }
      say('Pressure iterations ' + S.iters + ', wind ' + S.wind.speed + ', air drag ' + S.airDrag + ', air turbulence ' + S.gust + ', look-only points ×' + (S.detail + 1));
      await measure('', {}, true);   // warm-up, lets the GPU clock up before anything is timed
      say('(stage times each include a fixed cost of a few ms for submitting and waiting on one stage alone)');
      // The GPU can slow down during a long test, so every variant is measured right after a short rest, between two reference runs, and compared with their average.
      const rest = (ms) => new Promise((r) => setTimeout(r, ms));
      const trio = async (label, opt) => {
        await settle(); await rest(window.__benchRest === undefined ? 6000 : window.__benchRest);
        const r1 = await measure('', {}, true);
        const v = await measure(label, opt);
        const r2 = await measure('', {}, true);
        const ref = (r1 + r2) / 2, pc = (v / ref - 1) * 100;
        say('  reference before ' + f1(r1) + ' ms and after ' + f1(r2) + ' ms, so this is ' + (pc <= 0 ? Math.abs(pc).toFixed(0) + '% faster' : pc.toFixed(0) + '% slower') + ' than their average');
        return { ref, v, pc };
      };
      await measure('A. reference: everything on (particles sorted every 16th step)', {});
      await trio('S. particles not sorted', { sort: false });
      const pi = S.iters > 20 ? 20 : 40;
      await trio('P. ' + pi + ' pressure iterations instead of ' + S.iters, { iters: pi });
      await trio('C. white water and air drag skipped (for comparison)', { noFoam: true });
      say('');
      say('Blocks: at most ' + (sim.peak || sim.blocksUsed) + ' in use during the test, room for ' + sim.scap + (sim.grew ? ', the pool grew ' + sim.grew + ' times' : ''));
      Object.assign(sim.opt, opt0);
      // moving particles to the CPU for drawing
      const tmp = new Float32Array(sim.MAXN * 4 + 4); await sim.readbackInto(tmp);
      let rb = 0; for (let r = 0; r < 6; r++) { const t0 = performance.now(); await sim.readbackInto(tmp); rb += performance.now() - t0; }
      const dp = (K) => { const t0 = performance.now(); for (let r = 0; r < 5; r++) expandLook(tmp, Math.min(N, sim.ringCap || N), K, 0.5 * S.liveD); return (performance.now() - t0) / 5; };
      say('');
      say('Copying all particles to the CPU: ' + f1(rb / 6) + ' ms each (live view now does this in the background, without stalling steps)');
      say('Building the draw buffer on the CPU: ' + f1(dp(0)) + ' ms with look-only points off, ' + f1(dp(7)) + ' ms at ×8');
      say('');
      say('Done. Press Copy results and paste it back.');
    } catch (e) { say('Benchmark failed: ' + (e && e.message || e)); }
    delete sim.step; Object.assign(sim.opt, opt0); S.tl.end = endMode; S.subMin = sub0[0]; S.subMax = sub0[1]; resetSim(0); renderUI(); renderKF(); setPlaying(wasPlaying); benching = false;
  }
  $('#btn-bench').addEventListener('click', (e) => { e.currentTarget.blur(); runBenchmark(); });
  $('#btn-bench-copy').addEventListener('click', (e) => {
    e.currentTarget.blur(); bout.select();
    try { navigator.clipboard.writeText(bout.value).catch(() => document.execCommand('copy')); } catch (er) { try { document.execCommand('copy'); } catch (e2) { /* ignore */ } }
  });

  // box face arrows
  let fdrag = null, hoverF = null;
  function pickHandle(cx, cy) {
    if (!handleGrp.visible) return null;
    handleGrp.updateMatrixWorld(true); setNdc(cx, cy); const hits = ray.intersectObjects(handleMeshes, false);
    return hits.length ? hits[0].object.userData.face : null;
  }
  function hoverHandle(e) {
    if (tf || viewMode() === 'cache') return;
    const f = pickHandle(e.clientX, e.clientY);
    if (f !== hoverF) { if (hoverF) hoverF.mat.color.setHex(hoverF.col); hoverF = f; if (f) f.mat.color.setHex(ACCENT); canvas.style.cursor = f ? 'grab' : 'default'; }
  }
  function startFaceDrag(f, e) {
    const axis = f.dir.clone(), P = new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2); P[f.ax] = b[f.k];
    const t0 = lineParam(P, axis, rayAtClient(e.clientX, e.clientY));
    fdrag = { f, axis, P, t0: t0 === null ? 0 : t0, orig: b[f.k], changed: false }; f.mat.color.setHex(ACCENT); canvas.style.cursor = 'grabbing';
  }
  function moveFaceDrag(e) {
    const d = fdrag; if (!d) return;
    const t = lineParam(d.P, d.axis, rayAtClient(e.clientX, e.clientY)); if (t === null) return;
    let v = d.orig + (t - d.t0) * d.f.sgn; v = Math.round(v / (e.ctrlKey ? 0.5 : 0.05)) * (e.ctrlKey ? 0.5 : 0.05);
    if (Math.abs(v - b[d.f.k]) < 1e-6) return;
    setFaceCoord(d.f.k, v); d.changed = true;
    const inp = document.getElementById('face-' + d.f.k); if (inp) inp.value = +b[d.f.k].toFixed(3);
    const sz = document.getElementById('box-size'); if (sz) sz.innerHTML = 'size <b>' + S.dom.w.toFixed(2) + '</b> × <b>' + S.dom.h.toFixed(2) + '</b> × <b>' + S.dom.d.toFixed(2) + '</b> m. Changing the box restarts the particles.';
  }
  function endFaceDrag() {
    const d = fdrag; fdrag = null; if (!d) return;
    d.f.mat.color.setHex(d.f.col); canvas.style.cursor = 'default';
    if (d.changed) commitBox();
  }
  function orbit(dx, dy) { if (S.ortho) setOrtho(false); cam.theta -= dx * 0.007; cam.phi = clamp(cam.phi - dy * 0.007, 0.02, Math.PI - 0.02); updateCam(); }
  function pan(dx, dy) {
    camera.updateMatrixWorld(); const m = camera.matrixWorld.elements, k = cam.r * 0.0012;
    cam.target.x += (-m[0] * dx + m[4] * dy) * k; cam.target.y += (-m[1] * dx + m[5] * dy) * k; cam.target.z += (-m[2] * dx + m[6] * dy) * k; updateCam();
  }
  function trackMouse(e) { lastM.x = e.clientX; lastM.y = e.clientY; lastM.ctrl = e.ctrlKey || e.metaKey; }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    trackMouse(e);
    if (!addMenu.hidden) closeAddMenu();
    if (e.button === 1) e.preventDefault();
    if (tf) { e.preventDefault(); if (e.button === 0) confirmTf(); else if (e.button === 2) cancelTf(); else if (e.button === 1) midAxis(); return; }
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { press = null; const [a, c] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - c.x, a.y - c.y); r0 = cam.r; mid0 = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }; camGoal = null; return; }
    if (ptrs.size > 2) return;
    const cache = viewMode() === 'cache', touch = e.pointerType === 'touch';
    press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, mode: 'click', shift: e.shiftKey, hit: null };
    if (e.button === 1 || (e.button === 0 && e.altKey) || e.button === 2 || cache) { press.mode = e.shiftKey && (e.button === 1 || e.button === 2 || e.altKey) ? 'pan' : (e.ctrlKey && (e.button === 1 || e.altKey) ? 'zoom' : 'orbit'); camGoal = null; return; }
    if (e.button !== 0) return;
    { const gp = pickGizmo(e.clientX, e.clientY); if (gp) { press = null; startTf(gp.type, { axis: gp.axis, fromDrag: true }); if (tf) { tf.m0 = { x: e.clientX, y: e.clientY }; const pv = toScreen(tf.pivot); tf.prevA = Math.atan2(e.clientY - pv.y, e.clientX - pv.x); evalTf(); } return; } }
    if (uiMode === 'object' && S.handles) { const fh = pickHandle(e.clientX, e.clientY); if (fh) { startFaceDrag(fh, e); press.mode = 'face'; return; } }
    if (uiMode === 'edit') { const h = editPick(e.clientX, e.clientY); press.hit = h; press.hitSel = editIsSelected(h); }
    else { const o = pickObject(e.clientX, e.clientY); press.hit = o; press.hitSel = !!o && selSet.has(o); if (touch && !o) press.mode = 'orbit'; }
  });
  canvas.addEventListener('pointermove', (e) => {
    trackMouse(e);
    if (tf) { evalTf(); return; }
    const p = ptrs.get(e.pointerId);
    if (!p) { const gp = pickGizmo(e.clientX, e.clientY); hoverGizmo(gp); if (gp) { canvas.style.cursor = 'pointer'; return; } hoverHandle(e); return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) {
      const [a, c] = [...ptrs.values()]; const dist = Math.hypot(a.x - c.x, a.y - c.y);
      if (pinch0 > 0) { cam.r = clamp(r0 * pinch0 / dist, 1.2, 40); updateCam(); }
      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2; if (mid0) pan(mx - mid0.x, my - mid0.y); mid0 = { x: mx, y: my };
      return;
    }
    if (!press || press.id !== e.pointerId) return;
    const far = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
    if (press.mode === 'orbit') { orbit(dx, dy); return; }
    if (press.mode === 'pan') { pan(dx, dy); return; }
    if (press.mode === 'face') { moveFaceDrag(e); return; }
    if (press.mode === 'zoom') { cam.r = clamp(cam.r * Math.exp(dy * 0.01), 1.2, 40); updateCam(); return; }
    if (press.mode === 'click' && far > 4) { press.moved = true; press.mode = 'box'; }   // dragging never moves things: it draws a selection box (move with G or the gizmo)
    if (press.mode === 'box') {
      const r = stage.getBoundingClientRect(), x0 = Math.min(press.x0, e.clientX), x1 = Math.max(press.x0, e.clientX), y0 = Math.min(press.y0, e.clientY), y1 = Math.max(press.y0, e.clientY);
      boxEl.hidden = false; boxEl.style.left = x0 - r.left + 'px'; boxEl.style.top = y0 - r.top + 'px'; boxEl.style.width = x1 - x0 + 'px'; boxEl.style.height = y1 - y0 + 'px';
      press.rect = { x0, x1, y0, y1 };
    }
  });
  function endPtr(e) {
    trackMouse(e);
    ptrs.delete(e.pointerId);
    if (tf && tf.fromDrag) { confirmTf(); }
    else if (press && press.id === e.pointerId) {
      const pr = press; press = null;
      if (pr.mode === 'face') { endFaceDrag(); boxEl.hidden = true; return; }
      if (pr.mode === 'box' && pr.rect) {
        if (uiMode === 'edit') editBox(pr.rect, pr.shift);
        else {
          if (!pr.shift) { selSet.clear(); selected = null; }
          objs.forEach((o) => { const s = toScreen(o.pos); if (s.x >= pr.rect.x0 && s.x <= pr.rect.x1 && s.y >= pr.rect.y0 && s.y <= pr.rect.y1) { selSet.add(o); selected = o; } });
          objs.forEach(syncMesh); renderUI(); hud();
        }
      } else if (pr.mode === 'click' && !pr.moved) {
        if (uiMode === 'edit') editClick(e.clientX, e.clientY, pr.shift);
        else if (pr.hit) select(pr.hit, pr.shift);
        else if (!pr.shift) select(null);
      }
    }
    boxEl.hidden = true;
    if (ptrs.size === 0 && !tf) { press = null; canvas.style.cursor = 'default'; }
  }
  canvas.addEventListener('pointerup', endPtr); canvas.addEventListener('pointercancel', endPtr);
  window.addEventListener('pointermove', (e) => { if (tf && e.target !== canvas) { trackMouse(e); evalTf(); } });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); camGoal = null; cam.r = clamp(cam.r * Math.exp(e.deltaY * 0.001), 1.2, 40); updateCam(); }, { passive: false });

  // ---------- live cache ----------
  // While the sim runs from the start with nothing changed, the frames the live view shows are kept in memory (8 bytes a point).
  // Reset, Rewind and scrubbing play them back; at the end of the cache the sim carries on from where it really is.
  // Any change to the scene clears it, and it starts again the next time the sim runs from the beginning.
  const LC = { frames: [], fnum: [], ids: [], bytes: 0, armed: false, full: false, parked: 0, b: null, org: null, d: 0, staleEnd: 0 };
  function lcDrop() { LC.frames = []; LC.fnum = []; LC.bytes = 0; LC.full = false; if (typeof lcUi === 'function') lcUi(); }
  function lcClear() {
    if (!LC.frames.length && !LC.armed && !S.lcPlay) return;
    if (LC.frames.length > 1) LC.staleEnd = Math.max(LC.staleEnd || 0, lcEnd());   // shown orange on the timeline until it is simulated again
    const wasPlay = S.lcPlay;
    lcDrop(); LC.armed = false; lcUi();
    if (wasPlay) { S.lcPlay = false; applyKeysAt(S.tl.t); resetSim(S.tl.t); }
  }
  function lcEnd() { return LC.fnum.length ? LC.fnum[LC.fnum.length - 1] : -1; }
  function lcCanPlay(t) { return S.lcOn && LC.frames.length > 1 && t * 60 <= lcEnd() && viewMode() === 'live'; }
  function lcEnter(t) {
    if (!S.lcPlay) { LC.parked = S.frame; S.lcPlay = true; LC.armed = false; }
    S.lcT = t * 60; S.tl.t = t;
  }
  function lcRestart(t) { if (lcCanPlay(t)) lcEnter(t); else resetSim(t); }
  function lcExit() {
    S.lcPlay = false; lastGen = -1;
    if (LC.parked - lcEnd() > 6) { setPlaying(false); flash('End of the cached part (cache memory full). Start carries on from ' + (LC.parked / 60).toFixed(1) + ' s.'); }
    S.tl.t = LC.parked / 60; applyKeysAt(S.tl.t);
    LC.armed = !LC.full;
  }
  function lcRecord() {
    if (!LC.armed || S.lcPlay || !S.playing || !isGpu() || !sim.outN) return;
    const f = S.frame, last = lcEnd();
    if (!LC.frames.length && f > 8) { LC.armed = false; return; }   // it did not start at the beginning
    if (f - last < 2 || f < last) return;                              // about 30 frames a second is enough
    if (LC.bytes > S.lcBudget * 1048576) { LC.full = true; LC.armed = false; lcUi(); return; }
    if (!LC.frames.length) { LC.ids = objs.map((o) => o.id); LC.b = Object.assign({}, sim.b); LC.org = Object.assign({}, S.simOrg); LC.d = S.liveD; LC.scale = S.scale || 1; }
    const fr = packFrameBuf(rawBuf, sim.outN, sim.b, S.lastStates || []);
    LC.frames.push(fr); LC.fnum.push(f); LC.bytes += fr.n * (fr.fm ? 8 : 7) + 96 + (fr.sp ? fr.sp.n * 10 : 0) + (fr.dp ? fr.dp.n * 7 : 0);
    if (LC.staleEnd && lcEnd() >= LC.staleEnd) LC.staleEnd = 0;
    lcUi();
  }
  function lcShow() {
    const fn = LC.fnum; let lo = 0, hi = fn.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (fn[m] <= S.lcT) lo = m; else hi = m - 1; }
    const A = LC.frames[lo], cb = LC.b, og = LC.org;
    const qx = (cb.x1 - cb.x0) / 65535, qy = (cb.y1 - cb.y0) / 65535, qz = (cb.z1 - cb.z0) / 65535, pa = A.pos, sa = A.spd, fa = A.fm;
    let n = 0;
    for (let i = 0; i < A.n; i++) {
      if (sa[i] === 255) continue;
      const j = i * 3, fo = fa ? fa[i] / 255 : 0;
      n = putPts(n, i, pa[j] * qx + cb.x0, pa[j + 1] * qy + cb.y0, pa[j + 2] * qz + cb.z0, sa[i] / 16 + 64 * Math.round(fo * 15), S.detail, 0.5 * LC.d);
    }
    n = putSpraySet(A.sp, cb, n, 2 * LC.d);
    n = putDeepSet(A.dp, cb, n, 0.5 * LC.d * S.cellRatio);
    uploadParticles(n); lastGen = -1;
    LC.ids.forEach((id, k) => {
      const o = objs.find((q) => q.id === id); if (!o) return;
      const ob = A.objs, k6 = k * 6;
      o.group.position.set(ob[k6] + og.x, ob[k6 + 1] + og.y, ob[k6 + 2] + og.z);
      if (o.kind === 'mesh') o.group.rotation.set(ob[k6 + 3], ob[k6 + 4], ob[k6 + 5], 'ZYX');
    });
    return n;
  }
  function lcUi() {
    const el = $('#lc-info');
    if (el) {
      if (!S.lcOn) el.textContent = 'Off.';
      else if (LC.frames.length > 1) el.textContent = 'Cached 0 to ' + (lcEnd() / 60).toFixed(1) + ' s (' + Math.round(LC.bytes / 1048576) + ' MB)' + (LC.full ? ', memory full' : '') + '. Reset, Rewind or the timeline play it back without simulating; changing anything clears it.';
      else if (LC.staleEnd > 0) el.textContent = 'Out of date: something changed. Press Reset to simulate and cache it again.';
      else el.textContent = LC.armed ? 'Recording from the start as the sim runs.' : 'Empty. It records the next time the sim runs from the beginning (press Reset).';
    }
    const dur = S.tl.dur || 1, pc = (s) => clamp(s / dur, 0, 1) * 100;
    const bar = $('#lc-bar'), stl = $('#lc-stale'), bk = $('#bk-bar'), bp = $('#bk-prog');
    const on = S.lcOn && LC.frames.length > 1, endS = on ? lcEnd() / 60 : 0, se = S.lcOn ? LC.staleEnd / 60 : 0;
    if (bar) { bar.hidden = !on; if (on) bar.style.width = pc(endS) + '%'; }
    if (stl) { const show = se > endS + 1e-3; stl.hidden = !show; if (show) { stl.style.left = pc(endS) + '%'; stl.style.width = (pc(se) - pc(endS)) + '%'; } }
    if (bk) { const c = S.cache, show = !!c && !S.baking; bk.hidden = !show; if (show) bk.style.width = pc((c.frames.length - 1) / c.fps) + '%'; }
    if (bp) { bp.hidden = !S.baking; if (S.baking) bp.style.width = pc(S.bakeT || 0) + '%'; }
    const sr = $('#st-right');
    if (sr) {
      let t = '';
      if (S.baking) t = 'Baking ' + Math.round(pc(S.bakeT || 0)) + '%';
      else if (S.lcPlay) t = 'Playing the live cache';
      else if (on) t = 'Cached 0–' + endS.toFixed(1) + ' s · ' + Math.round(LC.bytes / 1048576) + ' MB' + (LC.full ? ' (memory full)' : '');
      else if (se > 0) t = '<span class="stale">Cache out of date · Reset to simulate again</span>';
      else if (S.lcOn && LC.armed && isGpu()) t = 'Caching from the start';
      const eng = S.engine === 'flip' ? 'FLIP' : S.engine === 'gpu' ? 'PBF GPU' : 'PBF CPU', g = S.gpu ? ' · ' + String(S.gpu.name).replace(/[<>&]/g, '') : '';
      const s = (t ? t + ' · ' : '') + eng + g; if (sr._s !== s) { sr._s = s; sr.innerHTML = s; }
    }
  }
  // anything changed in the objects, box or solver panels clears the cache (the cache's own controls are marked data-keep)
  ['#g-objects', '#g-box', '#g-sim'].forEach((sel) => {
    const g = $(sel); if (!g) return;
    const hit = (e) => { if (!e.target.closest('[data-keep]')) lcClear(); };
    g.addEventListener('input', hit); g.addEventListener('change', hit);
    g.addEventListener('click', (e) => { if (e.target.closest('.seg button')) hit(e); });
  });
  $('#kf-interp').addEventListener('click', () => lcClear());

  // ---------- live loop ----------
  // positions and angles part way between two sets of object states
  function lerpStates(a, b, w) {
    return b.map((o, i) => {
      const p = a[i]; if (!p || p.id !== o.id) return o;
      const L = (k) => (p[k] || 0) + ((o[k] || 0) - (p[k] || 0)) * w;
      return Object.assign({}, o, { x: L('x'), y: L('y'), z: L('z'), rx: L('rx'), yaw: L('yaw'), rz: L('rz') });
    });
  }
  function stepOnce() {
    const maxMove = S.dragSpeed / (S.scale || 1) * DT, states = [], tn = (S.frame + 1) * DT;
    for (const o of objs) {
      if (o.keys.length) {
        const k = keyPose(o.keys, tn, S.tl.smooth);
        o.target.set(k.x, k.y, k.z); o.pos.copy(o.target); o.rx = k.rx || 0; o.yaw = k.yaw || 0; o.rz = k.rz || 0;
        if (o.kind === 'emitter') { if (k.on !== undefined) o.on = k.on; if (k.speed !== undefined) o.speed = k.speed; }
        states.push(snap(o)); continue;
      }
      const dx = o.target.x - o.pos.x, dy = o.target.y - o.pos.y, dz = o.target.z - o.pos.z, L = Math.hypot(dx, dy, dz);
      if (L > maxMove) { const k = maxMove / L; o.pos.x += dx * k; o.pos.y += dy * k; o.pos.z += dz * k; } else o.pos.copy(o.target);
      if (o.kind === 'mesh') o.yaw += o.spin * DT;
      states.push(snap(o));
    }
    if (S.rec) recordStep();
    // substeps for the whole scene: the fastest particle (from the GPU, a step or two old), source or object decides how many
    const prev = S.prevStates && S.prevStates.length === states.length ? S.prevStates : null;
    const vfast = Math.max(objSpeed(prev, states, DT, S.colMax / (S.scale || 1)), (sim.stats && sim.stats.vmax) || 0);
    const hc = S.engine === 'flip' ? sim.h : 2 * S.liveD, lo = Math.max(1, S.subMin | 0), hi = Math.max(lo, S.subMax | 0);
    const n = clamp(Math.ceil(DT * vfast / (1.5 * hc)), lo, hi); S.lastSub = n;
    const par = simPar();
    const t0 = performance.now();
    for (let s = 1; s <= n; s++) { par.time = (S.frame + s / n) * DT; runner.step(DT / n, prev && s < n ? lerpStates(prev, states, s / n) : states, par); }
    S.prevStates = states; S.lastStates = states;
    const el = performance.now() - t0; S.ms = S.ms ? S.ms * 0.9 + el * 0.1 : el;
    S.frame++;
    for (const e of S.events) if (!e.done && e.t <= tn) { e.done = true; sim.fillSphere(e.x, e.y, e.z, e.r, 0, -1, 0); }
    S.tl.t = S.frame * DT;
    if (S.tl.t >= S.tl.dur) {
      if (S.tl.end === 'stop') { S.tl.t = S.tl.dur; setPlaying(false); }
      else if (S.tl.end === 'loop') lcRestart(0);
    }
  }

  let last = performance.now(), acc = 0, fpsE = 60, uiT = 0, recUi = 0;
  function frame(now) {
    requestAnimationFrame(frame); stepCam();
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    fpsE = fpsE * 0.92 + (1 / Math.max(dt, 1e-3)) * 0.08;
    const mode = viewMode();
    let count = 0, fresh = true;
    if (mode === 'cache') {
      const c = S.cache, lastF = c.frames.length - 1;
      if (S.cplay) {
        S.ct += dt * c.fps * S.cspeed;
        if (S.ct >= lastF) { if (S.cloop) S.ct = S.ct % lastF; else { S.ct = lastF; setCPlay(false); } }
      }
      pmat.uniforms.uMax.value = S.vmax / (c.scale || 1); pmat.uniforms.uSize.value = S.psize * c.d; points.position.set((c.org || S.org).x, (c.org || S.org).y, (c.org || S.org).z);
      count = showCache(S.ct);
      uiT += dt;
      if (uiT > 0.1) {
        uiT = 0; const fi = Math.round(S.ct);
        $('#c-frame').textContent = String(fi + 1).padStart(4, '0'); $('#c-count').textContent = count; $('#c-fps').textContent = Math.round(fpsE);
        const sc = $('#scrub'); if (document.activeElement !== sc) sc.value = fi;
      }
    } else if (S.lcPlay) {
      if (S.playing) {
        S.lcT += dt * 60;
        const end = LC.fnum[LC.fnum.length - 1];
        if (S.tl.end === 'loop' && S.lcT >= S.tl.dur * 60) S.lcT = 0;
        else if (S.tl.end === 'stop' && S.lcT >= S.tl.dur * 60) { S.lcT = S.tl.dur * 60; setPlaying(false); }
        else if (S.lcT >= end) lcExit();
      }
      if (S.lcPlay) {
        count = lcShow(); S.tl.t = S.lcT / 60;
        pmat.uniforms.uMax.value = S.vmax / (LC.scale || 1); pmat.uniforms.uSize.value = S.psize * LC.d; points.position.set(LC.org.x, LC.org.y, LC.org.z);
        uiT += dt;
        if (uiT > 0.2) { uiT = 0; $('#frame').textContent = String(Math.floor((S.lcT / 60) * 24) + 1).padStart(4, '0'); updatePlayhead(); $('#count').textContent = count; $('#fps').textContent = Math.round(fpsE); $('#ms').textContent = '— (cache)'; }
      }
    } else {
      if (S.playing && !S.baking) {
        if (isGpu()) {
          acc = Math.min(acc + dt, 3 * DT);
          if (acc >= DT && (sim.inflight || 0) < 2 * (S.lastSub || 1)) { acc -= DT; stepOnce(); }
        } else {
          acc += dt; let n = 0;
          while (acc >= DT && n < 2) { stepOnce(); acc -= DT; n++; }
          if (n === 2) acc = 0;
        }
      } else { acc = 0; for (const o of objs) o.pos.copy(o.target); }
      for (const o of objs) poseGroup(o);
      if (tf) refreshFields();
      if (isGpu()) {
        if (sim.setDeepLook) sim.setDeepLook(S.nbLook && nbActive());
        sim.pump();
        if (sim.gen !== lastGen || S.detail !== lastK) { if (sim.gen !== lastGen) lcRecord(); count = expandLook(rawBuf, sim.outN, S.detail, 0.5 * S.liveD); lastGen = sim.gen; lastK = S.detail; lastCount = count; fresh = true; } else { count = lastCount; fresh = false; }
        S.ms = sim.lastMs;
      }
      else {
        count = sim.N; const Pp = sim.P, Sp = sim.S;
        let w = 0;
        for (let i = 0; i < count; i++) { const i3 = i * 3; if (Pp[i3 + 1] < -1e5) continue; w = putPts(w, i, Pp[i3], Pp[i3 + 1], Pp[i3 + 2], Sp[i], S.detail, 0.5 * S.liveD); }
        count = w; fresh = true;
      }
      if (fresh) uploadParticles(count); else geo.setDrawRange(0, count);
      pmat.uniforms.uMax.value = S.vmax / (S.scale || 1); pmat.uniforms.uSize.value = S.psize * S.liveD; points.position.set(S.simOrg.x, S.simOrg.y, S.simOrg.z);
      uiT += dt;
      if (uiT > 0.2) {
        uiT = 0;
        $('#frame').textContent = String(Math.floor((S.frame / 60) * 24) + 1).padStart(4, '0');
        updatePlayhead();
        const simN = isGpu() ? sim.N : count; $('#count').textContent = simN; $('#fps').textContent = Math.round(fpsE); $('#ms').textContent = S.ms.toFixed(1) + ((S.lastSub || 1) > 1 ? ' ×' + S.lastSub : '');
        if (LC.frames.length && Math.random() < 0.25) lcUi();
        $('#meter').style.width = Math.min(100, (simN / S.cap) * 100) + '%';
      }
      recUi += dt; if (S.rec && recUi > 0.5) { recUi = 0; updateRecInfo(); updateEst(); }
    }
    vpT += dt; if (vpT > 0.25) { vpT = 0; try { vpInfo(); } catch (e) { /* not ready */ } }
    placeHandles();
    oceanUpdate(mode);
    renderer.render(scene, camera);
  }

  // ---------- panel: collapsible groups, tooltips, right-click menu, search, status bar ----------
  const panelEl = $('.panel');
  // every group header folds its group; the choice is remembered in this browser
  const GROUP_CLOSED = ['g-native'];   // with the properties split into tabs, most panels start open
  function setGroupOpen(g, open) { g.classList.toggle('closed', !open); const h2 = g.querySelector(':scope > h2'); if (h2) h2.setAttribute('aria-expanded', String(open)); }
  panelEl.querySelectorAll('.group').forEach((g) => {
    const h2 = g.querySelector(':scope > h2'); if (!h2 || !g.id) return;
    h2.tabIndex = 0; h2.setAttribute('role', 'button');
    const st = lsGet('grp.' + g.id); setGroupOpen(g, st === null ? !GROUP_CLOSED.includes(g.id) : st === '1');
    const tog = () => { if (searching) return; const open = g.classList.contains('closed'); setGroupOpen(g, open); lsSet('grp.' + g.id, open ? '1' : '0'); };
    h2.addEventListener('click', tog);
    h2.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); tog(); } });
  });

  // tooltips: hover anything with data-tip; slider rows add their default and range
  const tipEl = $('#tip'); let tipT = 0, tipFor = null;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function hideTip() { clearTimeout(tipT); tipT = 0; tipEl.hidden = true; }
  function showTip(el) {
    if (!el.isConnected) return;
    const row = el.closest('.row'), st = row && row._st && row.contains(el) && el.tagName === 'LABEL' ? row._st : null;
    const title = el.dataset.tipTitle || (st ? st.label : el.textContent.replace(/\s+/g, ' ').trim());
    let s = '<b>' + esc(title) + '</b>';
    if (el.dataset.tip) s += '<div>' + esc(el.dataset.tip) + '</div>';
    if (st) s += '<div class="tk">' + (st.def !== undefined ? 'Default ' + esc(st.fmt(st.def)) + ' · ' : '') + 'range ' + esc(st.fmt(st.min)) + ' to ' + esc(st.fmt(st.max)) + '</div><div class="tk">Drag sideways to change, click to type · right-click to reset or copy</div>';
    if (!el.dataset.tip && !st) return;
    tipEl.innerHTML = s; tipEl.hidden = false;
    const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    let x = r.left, y = r.bottom + 6;
    if (panelEl.contains(el)) { x = panelEl.getBoundingClientRect().left - w - 10; y = r.top - 4; if (x < 4) { x = r.left; y = r.bottom + 6; } }
    tipEl.style.left = clamp(x, 4, innerWidth - w - 4) + 'px'; tipEl.style.top = clamp(y, 4, innerHeight - hh - 4) + 'px';
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el === tipFor) return;
    hideTip(); tipFor = el;
    if (el) tipT = setTimeout(() => showTip(el), 450);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('wheel', hideTip, { passive: true, capture: true });
  panelEl.addEventListener('scroll', hideTip, { passive: true });

  // which setting the mouse is over (Backspace resets it, Ctrl+C / Ctrl+V copy and paste, like Blender)
  panelEl.addEventListener('mouseover', (e) => { const r = e.target.closest('.row'); const h = r && r._st ? r : null; if (h !== hoverRow) { hoverRow = h; updStatus(); } });
  panelEl.addEventListener('mouseleave', () => { if (hoverRow) { hoverRow = null; updStatus(); } });
  function resetRow(row) { const st = row._st; if (st.def === undefined) return; st.commit(st.def); flash(st.label + ' reset to ' + st.fmt(st.def)); }
  function copyRow(row) { const st = row._st, v = st.get(); clipVal = v; try { navigator.clipboard.writeText(String(v)).catch(() => {}); } catch (e) { /* no clipboard here */ } flash('Copied ' + st.label + ' ' + st.fmt(v)); }
  function pasteRow(row) { if (clipVal === null) { flash('Nothing copied yet'); return; } row._st.commit(clipVal); flash(row._st.label + ' set to ' + row._st.fmt(row._st.get())); }

  const ctxEl = $('#ctx'); let ctxRow = null;
  function closeCtx() { ctxEl.hidden = true; ctxRow = null; }
  function openCtx(row, x, y) {
    ctxRow = row; const st = row._st, v = st.get();
    const atDef = st.def === undefined || Math.abs(v - st.def) < 1e-9;
    ctxEl.innerHTML = '<button type="button" data-a="reset"' + (atDef ? ' disabled' : '') + '>Reset to default' + (st.def !== undefined ? ' (' + esc(st.fmt(st.def)) + ')' : '') + '<span>Backspace</span></button>' +
      '<button type="button" data-a="type">Type a value<span>click value</span></button><hr>' +
      '<button type="button" data-a="copy">Copy value<span>Ctrl C</span></button>' +
      '<button type="button" data-a="paste"' + (clipVal === null ? ' disabled' : '') + '>Paste value' + (clipVal === null ? '' : ' (' + esc(+clipVal.toFixed(4)) + ')') + '<span>Ctrl V</span></button>';
    ctxEl.hidden = false;
    const w = ctxEl.offsetWidth, hh = ctxEl.offsetHeight;
    ctxEl.style.left = clamp(x, 4, innerWidth - w - 4) + 'px'; ctxEl.style.top = clamp(y, 4, innerHeight - hh - 4) + 'px';
    const f = ctxEl.querySelector('button:not(:disabled)'); if (f) f.focus({ preventScroll: true });
  }
  panelEl.addEventListener('contextmenu', (e) => { const row = e.target.closest('.row'); if (!row || !row._st) return; e.preventDefault(); hideTip(); openCtx(row, e.clientX, e.clientY); });
  ctxEl.addEventListener('click', (e) => {
    const bt = e.target.closest('button'); if (!bt || bt.disabled || !ctxRow) return;
    const row = ctxRow, a = bt.dataset.a; closeCtx();
    if (a === 'reset') resetRow(row); else if (a === 'copy') copyRow(row); else if (a === 'paste') pasteRow(row); else if (a === 'type') row._st.type();
  });
  ctxEl.addEventListener('keydown', (e) => {
    const its = [...ctxEl.querySelectorAll('button:not(:disabled)')], i = its.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (its.length) its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCtx(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!ctxEl.hidden && !ctxEl.contains(e.target)) closeCtx(); }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F3') { e.preventDefault(); const s = $('#psearch'); s.focus(); s.select(); return; }
    if (!hoverRow || !hoverRow.isConnected || typing() || tf || !ctxEl.hidden) return;
    const K = e.key.toLowerCase();
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); resetRow(hoverRow); }
    else if ((e.ctrlKey || e.metaKey) && K === 'c') { e.preventDefault(); e.stopImmediatePropagation(); copyRow(hoverRow); }
    else if ((e.ctrlKey || e.metaKey) && K === 'v') { e.preventDefault(); e.stopImmediatePropagation(); pasteRow(hoverRow); }
  }, true);

  // search the settings by name: matching rows stay, their panels open, everything else hides
  const psearch = $('#psearch');
  function filterPanel(q) {
    q = (q || '').trim().toLowerCase();
    const was = searching; searching = !!q;
    panelEl.classList.toggle('searching', searching);
    const items = panelEl.querySelectorAll('.group .row, .group label.check');
    const subs = panelEl.querySelectorAll('details.sub'), groups = panelEl.querySelectorAll('.group');
    if (!searching) {
      items.forEach((it) => it.classList.remove('sx')); groups.forEach((g) => g.classList.remove('sx')); subs.forEach((d) => d.classList.remove('sx'));
      if (was) {
        subs.forEach((d) => { if (d.dataset.prev !== undefined) { d.open = d.dataset.prev === '1'; delete d.dataset.prev; } });
        groups.forEach((g) => { if (g.dataset.prevClosed !== undefined) { setGroupOpen(g, g.dataset.prevClosed !== '1'); delete g.dataset.prevClosed; } });
      }
      const none = $('#psearch-none'); if (none) none.remove();
      return;
    }
    let hits = 0;
    items.forEach((it) => {
      const lab = it.querySelector('label') || it, txt = (it.matches('label') ? it.textContent : lab.textContent).toLowerCase();
      const ok = txt.includes(q); it.classList.toggle('sx', !ok); if (ok) hits++;
    });
    // a panel whose own name matches shows all of its settings
    const heads = [...subs].map((d) => [d, d.querySelector(':scope > summary')]).concat([...groups].map((g) => [g, g.querySelector(':scope > h2')]));
    heads.forEach(([c, hd]) => { if (hd && hd.textContent.toLowerCase().includes(q)) c.querySelectorAll('.row, label.check').forEach((it) => { if (it.classList.contains('sx')) { it.classList.remove('sx'); hits++; } }); });
    subs.forEach((d) => {
      const any = [...d.querySelectorAll('.row, label.check')].some((it) => !it.classList.contains('sx'));
      d.classList.toggle('sx', !any);
      if (any) { if (d.dataset.prev === undefined) d.dataset.prev = d.open ? '1' : '0'; d.open = true; }
    });
    groups.forEach((g) => {
      const any = [...g.querySelectorAll('.row, label.check')].some((it) => !it.classList.contains('sx'));
      g.classList.toggle('sx', !any);
      if (any && g.classList.contains('closed')) { if (g.dataset.prevClosed === undefined) g.dataset.prevClosed = '1'; setGroupOpen(g, true); }
    });
    let none = $('#psearch-none');
    if (!hits) { if (!none) { none = document.createElement('div'); none.id = 'psearch-none'; none.className = 'psearch-none'; psearch.parentNode.after(none); } none.textContent = 'No setting called "' + q + '".'; }
    else if (none) none.remove();
  }
  psearch.addEventListener('input', () => filterPanel(psearch.value));
  psearch.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { psearch.value = ''; filterPanel(''); psearch.blur(); } });

  // status bar: what the mouse and keys do right now (Blender shows this along the bottom)
  function updStatus() {
    const el = $('#st-hints'); if (!el) return;
    let h;
    if (hoverRow) h = [['Drag', 'change'], ['Click value', 'type'], ['Backspace', 'reset'], ['Ctrl C', 'copy'], ['Ctrl V', 'paste'], ['Right-click', 'more']];
    else if (viewMode() === 'cache') h = [['Space', 'play or pause'], ['Drag timeline', 'scrub'], ['MMB', 'orbit'], ['Shift MMB', 'pan'], ['Wheel', 'zoom'], ['F3', 'search settings']];
    else if (tf) h = [['X Y Z', 'axis (twice: ' + (S.orient === 'local' ? 'global' : 'local') + ')'], ['Shift+axis', 'plane'], ['Ctrl', S.snapOn ? 'no snapping' : 'snap'], ['V', 'snap to points'], ['0–9', 'type a value'], ['LMB/Enter', 'confirm'], ['RMB/Esc', 'cancel']];
    else if (uiMode === 'edit') h = [['1 2 3', 'points, edges, faces'], ['G R S', 'move, rotate, scale'], ['E', 'extrude'], ['A', 'select all'], ['Tab', 'back to objects']];
    else if (selSet.size) h = [['G R S', 'move, rotate, scale'], ['Shift D', 'duplicate'], ['X', 'delete'], ['I', 'keyframe']].concat(selected && selected.kind === 'mesh' ? [['Tab', 'edit shape']] : []).concat([['F', 'focus'], ['Shift A', 'add'], ['Space', S.playing ? 'stop' : 'start']]);
    else h = [['LMB', 'select'], ['Drag', 'box select'], ['MMB', 'orbit'], ['Shift MMB', 'pan'], ['Wheel', 'zoom'], ['Shift A', 'add'], ['F3', 'search settings'], ['Space', S.playing ? 'stop' : 'start']];
    const s = h.map(([k, t]) => '<span class="h"><kbd>' + k + '</kbd>' + t + '</span>').join('');
    if (el._s !== s) { el._s = s; el.innerHTML = s; }
  }

  window.__errLog = window.__errLog || [];
  window.addEventListener('error', (e) => window.__errLog.push({ t: new Date().toISOString(), msg: 'Page: ' + e.message + ' at ' + (e.filename || '').split('/').pop() + ':' + e.lineno }));
  window.addEventListener('unhandledrejection', (e) => window.__errLog.push({ t: new Date().toISOString(), msg: 'Page: ' + (e.reason && e.reason.stack ? e.reason.stack : e.reason) }));
  // shared source for the worker comes from the page's own script
  sharedSrc = document.getElementById('shared').textContent;
  resize(); updateCam();

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
  $('#kf-play').addEventListener('click', (e) => { e.currentTarget.blur(); $('#btn-play').click(); });
  function jumpKey(dir) {
    const ts = []; (selSet.size ? [...selSet] : objs).forEach((o) => o.keys.forEach((k) => ts.push(k.t)));
    ts.sort((a, c) => a - c); const t0 = S.tl.t, eps = 0.5 / FPS_TL;
    const t = dir > 0 ? ts.find((q) => q > t0 + eps) : [...ts].reverse().find((q) => q < t0 - eps);
    if (t === undefined) { flash('No ' + (dir > 0 ? 'later' : 'earlier') + ' key'); return; }
    scrubTo(t, true); renderUI();
  }
  $('#kf-prev').addEventListener('click', (e) => { e.currentTarget.blur(); jumpKey(-1); });
  $('#kf-next').addEventListener('click', (e) => { e.currentTarget.blur(); jumpKey(1); });
  window.addEventListener('keydown', (e) => { if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !typing() && !tf && document.activeElement === document.body && viewMode() === 'live') { e.preventDefault(); jumpKey(e.key === 'ArrowUp' ? 1 : -1); } });

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
    if (cl) cl.textContent = cache ? 'Bake playback' : S.lcPlay ? 'Live cache' : S.playing ? 'Live · ' + Math.round(fpsE) + ' fps' : 'Live · stopped';
    const ss = $('#ol-sim-sub'); if (ss) ss.textContent = (isGpu() ? fmtN(sim ? sim.N : 0) : fmtN(sim ? sim.N : 0)) + ' particles' + (S.engine === 'flip' && nbActive() ? ' · narrow band' : '');
    const vm = $('#vh-mode'); if (vm && document.activeElement !== vm) vm.value = uiMode;
  }
  window.__splash = { setTool, setSnap, setOrient, setColorBy, setPtab, renderOutliner, setHidden, layState, bakeRes, buildDesc, LC, filterPanel, drawCount: () => geo.drawRange.count, gizmo, pickGizmo, snapView, setOrtho, tfLines, snapMark, getCam: () => camera, select, get tfState() { return tf; }, lc: () => ({ frames: LC.frames.length, end: lcEnd(), armed: LC.armed, play: S.lcPlay, t: S.lcT, bytes: LC.bytes, full: LC.full }), lcRestart, stepOnce, runBenchmark, expandLook, rawBuf, getSim: () => sim, cam, b, setFaceCoord, commitBox, FACES, sceneData, applySceneData, S, objs, addKey, resetSim, setDomain, selSet, select, startTf, confirmTf, cancelTf, enterEdit, exitEdit, extrudeFaces, ES, undo, redo, addAt, setSelMode, lastM, get tf() { return tf; }, get uiMode() { return uiMode; }, editPick, toScreen, makeObj, selVerts, selectAllEdit, modalKey, evalTf };
  initGpu().then((g) => {
    S.gpu = g; applyPreset(g ? 'flip' : 'cpu');
    buildLiveUI(); buildBakeUI(); makeSim(); $('#capshow').textContent = fmtN(S.cap);
    loadScene('Wave tank'); applyMode(); setPlaying(false); lcUi(); updStatus();
    requestAnimationFrame(frame);
  });
})();
