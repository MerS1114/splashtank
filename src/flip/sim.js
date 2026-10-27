// WebGPU FLIP / PIC fluid solver on a sparse MAC grid.
// Particles carry the velocity, the grid enforces incompressibility. One step:
//   find which 8x8x8 blocks of the grid are near particles and give them storage, clear, particle to grid (atomic fixed point),
//   classify cells, normalise and add gravity, divergence, red black SOR pressure solve (warm started), project,
//   grid to particle (FLIP blend), advect and collide.
// Only blocks within two cells of a particle exist, so memory and grid work follow the water, not the size of the box.
// Colliders are voxelised into solid cells (cached until they move) and carry their own velocity into the pressure solve.
// The shader is put together from the src/flip/wgsl-*.js parts (WGSL does not care about the order of declarations).
// sg: the GPU offers subgroups, so the subgroup list kernels (wgsl-subgroups.js) are added; 'enable' must open the module
function flipWGSL(sg) { return (sg ? 'enable subgroups;\n' : '') + FLIP_WGSL_CORE + FLIP_WGSL_BLOCKS + FLIP_WGSL_SOLVER + FLIP_WGSL_WHITEWATER + FLIP_WGSL_NARROWBAND + FLIP_WGSL_MG + (sg ? FLIP_WGSL_SUBGROUPS : ''); }

const FLIP_SLOT = { cells: 512 };   // one block of the sparse grid: 8 x 8 x 8 cells
const FLIP_PARAMS_BYTES = 1760;      // the solver's uniform block: settings, whitewater, air and drips (words 68-83), starting-water shapes (84), ocean waves (148), more whitewater (404), whitewater area (408)
const FLIP_DEEPMAX = 200000;
// the whitewater area: the tank widened k times about its centre and raised to up times its height (floor kept); never smaller than the tank
function wwAreaBox(b, a) {
  const k = Math.max(1, (a && a.k) || 1), up = Math.max(1, (a && a.up) || 1), cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const hx = (b.x1 - b.x0) / 2 * k, hz = (b.z1 - b.z0) / 2 * k;
  return { x0: cx - hx, x1: cx + hx, y0: b.y0, y1: b.y0 + (b.y1 - b.y0) * up, z0: cz - hz, z1: cz + hz };
}          // deep water points drawn at most (narrow band, look only); matches DEEPMAX in the shader
// The bindings each kernel uses (makeGroups says which buffer each number is). Keep every kernel within 8 storage buffers.
const FLIP_L = {
  tileReset: [12], tileNeedClear: [0, 17], tileMark: [0, 1, 2, 17], tileMarkPhi: [0, 7, 12, 17, 18, 19], tileMarkFill: [0, 10, 11, 17], phiInitAll: [0, 7, 10, 11, 12, 18, 19, 31], tileFree: [0, 12, 16, 17, 20, 21], argsNew: [12, 14], tileAlloc: [0, 12, 16, 19, 20, 21], tileFix: [0, 12],
  initNew: [0, 7, 8, 10, 11, 12, 21, 31, 39], slotListBuild: [0, 12, 16, 18], argsSlots: [12, 14], growFree: [12, 20, 25],
  sortClear: [22], sortHist: [0, 1, 22], sortScan: [22], sortScatter: [0, 1, 2, 22, 23, 24, 26, 27], sortCopy: [0, 1, 2, 23, 24, 26, 27], unsort: [0, 1, 23, 26],
  clearSlots: [3, 5, 6, 9, 12, 18], p2g: [0, 1, 2, 3, 5, 6, 12, 16], p2gWin: [0, 1, 2, 3, 5, 6, 12, 16], solidBuild: [0, 7, 10, 11, 12, 18, 19], classify: [0, 6, 7, 8, 12, 16, 18, 19, 31], sprayEmit: [0, 1, 2, 6, 7, 16, 28, 29, 30], spinEmit: [0, 1, 2, 3, 6, 16, 28, 29, 30], wwAdvect: [0, 1, 2], sprayStep: [0, 10, 11, 28, 29, 30, 32, 33], sprayDisp: [0, 15, 28, 29, 30], sprayDispSG: [0, 15, 28, 29, 30], dispBegin: [30], packDisp: [1, 12, 15, 30, 37, 38], wwSample: [0, 3, 6, 7, 16, 28, 29, 33], wwArgs: [0, 14, 30],
  airClear: [0, 34], airSplatW: [0, 1, 2, 6, 16, 34], airSplatS: [0, 28, 29, 34], airUpdate: [0, 10, 11, 32, 34, 35], airCopy: [0, 32, 35], dripStep: [0, 6, 7, 10, 16, 28, 29, 30, 36],
  normFaces: [0, 3, 5, 7, 10, 12, 16, 18, 19], divergence: [0, 3, 6, 7, 9, 12, 16, 18, 19],
  listClear: [12], settleMark: [0, 7, 8, 9, 12, 16, 18, 19, 39], buildList: [0, 7, 12, 13, 18, 19, 39], buildListSG: [0, 7, 12, 13, 18, 19, 39], listArgs: [0, 12, 14], rbRed: [0, 7, 8, 9, 12, 13, 16, 19], rbBlack: [0, 7, 8, 9, 12, 13, 16, 19],
  project: [0, 3, 7, 8, 12, 16, 18, 19], subsample: [0, 1, 15], g2p: [0, 1, 2, 3, 5, 6, 10, 11, 16], ballistic: [0, 1, 2, 6, 10, 11, 16], g2pWin: [0, 1, 2, 3, 5, 6, 10, 11, 16],
  nbPhi: [0, 6, 7, 9, 12, 16, 18, 19, 31], nbJacA: [0, 7, 9, 12, 16, 18, 19], nbJacB: [0, 7, 9, 12, 16, 18, 19], nbVel: [0, 3, 5, 7, 12, 16, 18, 19, 31],
  saveVel: [0, 3, 12, 18, 19, 31], nbKill: [0, 1, 2, 7, 16], nbReset: [12], nbDead: [0, 1, 12, 13], nbDeficit: [0, 6, 7, 12, 13, 16, 18, 19, 31], nbArgs: [0, 12, 14],
  nbSpawn: [0, 1, 2, 12, 13, 16, 31], deepClear: [0, 15], deepPick: [0, 6, 7, 12, 15, 16, 18, 19, 31], deepFin: [12], ...FLIP_MG_L };
// The ~85 compute pipelines, made once per device and shared by every FlipSim (a new one is made on each scene load and spacing change).
// createComputePipelineAsync lets the driver compile them in parallel; done one after another on first use they stalled the first step
// for many seconds on some GPUs (D3D shader compiles). pipes is set once all of them are ready.
const FLIP_PIPES = new WeakMap();
const WWSTAGES = new Set(['blocks', 'clear', 'p2g', 'classify', 'normFaces', 'air', 'ww sample', 'ww move', 'ww emit']);
function flipPipes(device) {
  let sh = FLIP_PIPES.get(device); if (sh) return sh;
  const sg = !!(device.features && device.features.has('subgroups'));
  sh = { pipes: null, ms: 0, sg }; FLIP_PIPES.set(device, sh);
  const t0 = performance.now(), mod = device.createShaderModule({ code: flipWGSL(sg) }), names = Object.keys(FLIP_L).filter((n) => sg || !n.endsWith('SG'));
  const one = (name) => {
    const desc = { layout: 'auto', compute: { module: mod, entryPoint: name } };
    if (!device.createComputePipelineAsync) return Promise.resolve(device.createComputePipeline(desc));
    return device.createComputePipelineAsync(desc).catch((e) => { console.error('FLIP pipeline ' + name + ': ' + e.message); return device.createComputePipeline(desc); });
  };
  sh.promise = Promise.all(names.map(one)).then((list) => {
    const p = {}; names.forEach((n, k) => { p[n] = list[k]; });
    sh.pipes = p; sh.ms = performance.now() - t0; return p;
  });
  return sh;
}
class FlipSim {
  constructor(device, opt) {
    const d = (this.d = opt.d), ratio = (this.ratio = Math.max(1.4, Math.min(4, opt.ratio || 2))), h = (this.h = ratio * d);
    this.rest = ratio * ratio * ratio; this.opt = { noFoam: false, noCull: false, noSolidCache: false, fastAir: false, sort: false, sortEvery: 16, iters: 0 };
    const sz = opt.size || [3, 2.6, 3];
    this.nx = Math.max(4, Math.round(sz[0] / h)); this.ny = Math.max(4, Math.round(sz[1] / h)); this.nz = Math.max(4, Math.round(sz[2] / h));
    const W = this.nx * h, H = this.ny * h, D = this.nz * h;
    this.b = { x0: -W / 2, x1: W / 2, y0: 0, y1: H, z0: -D / 2, z1: D / 2 };
    this.size = [W, H, D];
    this.open = opt.open | 0;
    this.dev = device; this.MAXN = opt.maxN; this.cap = opt.maxN; this.N = 0; this.ring = 0; this.recycle = true;
    this.busy = false; this.needRead = true; this.lastMs = 0; this.outN = 0; this.out = opt.out || null;
    this.ncell = this.nx * this.ny * this.nz;
    // blocks cover one extra cell on the high side of each axis, so the faces on the far walls have an owner cell
    this.tx = Math.ceil((this.nx + 1) / 8); this.ty = Math.ceil((this.ny + 1) / 8); this.tz = Math.ceil((this.nz + 1) / 8);
    this.ntiles = this.tx * this.ty * this.tz;
    this.restitution = 0;
    const maxBuf = device.limits.maxStorageBufferBindingSize || (1 << 27);
    this.scapMax = Math.max(2, Math.min(this.ntiles + 1, Math.floor(maxBuf / (512 * 3 * 4))));
    this.scap = Math.max(2, Math.min(this.scapMax, opt.slots || Math.max(64, Math.ceil(this.MAXN / 1024))));
    const M = this.MAXN, U = GPUBufferUsage;
    const mk = (size) => device.createBuffer({ size: Math.max(size, 16), usage: U.STORAGE | U.COPY_SRC | U.COPY_DST });
    this.mk = mk;
    this.bPos = mk(M * 16); this.bVel = mk(M * 16);
    this.bPid = mk(M * 4); this.bTpid = mk(16); this.sortedEver = false;
    this.sprayCap = 0; this.sprDispMax = 0; this.bSPos = mk(16); this.bSVel = mk(16); this.bSctl = mk(16); this.bSAux = mk(16); this.seed = 0;
    this.airDims = null; this.bAir = mk(16); this.bAir2 = mk(16); this.bAirAcc = mk(16);   // air field, made when first used
    this.bDrip = mk(32); this.ndrip = 0; this.dripSig = '';                                   // drip samples on the colliders
    { const ids = new Uint32Array(M); for (let k = 0; k < M; k++) ids[k] = k; device.queue.writeBuffer(this.bPid, 0, ids); }   // slot k starts as particle k
    this.bTmap = mk(this.ntiles * 4); this.bNeed = mk(this.ntiles * 4); this.bNew = mk(this.ntiles * 8);
    this.makeSlotBuffers(this.scap);
    this.bMg = mk(16); this.mgSize = 0;
    this.bCols = mk(32 * 128); this.bSortCnt = mk(65536 * 4); this.bTpos = mk(16); this.bTvel = mk(16); this.sortTick = 0; this.solidDirty = true; this.cfPrev = null;
    this.bCtl = device.createBuffer({ size: 64, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
    this.bGro = mk(16);
    this.dispMax = 300000; this.stride = 1;
    this.bDisp = mk(Math.min(this.MAXN, this.dispMax + 1) * 16 + 16);
    this.bPack = mk(16); this.bPackU = device.createBuffer({ size: 128, usage: U.UNIFORM | U.COPY_DST }); this.packWords = 4;
    this.bArgs = device.createBuffer({ size: 192, usage: U.STORAGE | U.INDIRECT | U.COPY_DST });
    this.sdfCap = 16; this.sdfSig = null; this.bSdf = mk(64);
    this.bParams = device.createBuffer({ size: FLIP_PARAMS_BYTES, usage: U.UNIFORM | U.COPY_DST });
    this.bStat = device.createBuffer({ size: 64, usage: U.MAP_READ | U.COPY_DST }); this.statBusy = false; this.stats = null;
    this.stage = null;   // made on first use (bakes and the benchmark); the live view uses its own small ring
    this.ringCap = Math.min(this.MAXN, this.dispMax + 1);
    this.pS = new Float32Array(M * 4); this.vS = new Float32Array(M * 4);
    this.runStart = 0; this.runLen = 0;
    this.pu = new ArrayBuffer(FLIP_PARAMS_BYTES); this.pu32 = new Uint32Array(this.pu); this.pf32 = new Float32Array(this.pu);
    this.nbInit = 0; this.nbFills = []; this.nbFillVols = []; this.nbCfg = null; this.oceanCfg = null; this.oceanKey = ''; this.oceanW = null;
    this.cf = new Float32Array(32 * 32);
    // empty block map, every slot but the spare slot 0 on the free stack
    device.queue.writeBuffer(this.bTmap, 0, new Uint32Array(this.ntiles).fill(0xffffffff));
    const st = new Uint32Array(this.scap - 1); for (let k = 0; k < st.length; k++) st[k] = this.scap - 1 - k;
    device.queue.writeBuffer(this.bStack, 0, st);
    device.queue.writeBuffer(this.bCtl, 0, new Uint32Array([0, 0, this.scap - 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    // the pipelines are shared by every FlipSim on this device and compiled once, in parallel; until they are ready the sim does not step
    if (device.features && device.features.has('timestamp-query')) {   // GPU time of a step, one reading in flight (gpuMs: median of the last 31)
      this.tsq = device.createQuerySet({ type: 'timestamp', count: 64 });
      this.tsRes = device.createBuffer({ size: 512, usage: U.QUERY_RESOLVE | U.COPY_SRC });
      this.tsRead = device.createBuffer({ size: 512, usage: U.MAP_READ | U.COPY_DST }); this.tsBusy = false;
    }
    this.L = FLIP_L; this.pipes = {}; this.ready = false;
    const sh = flipPipes(device); this.sg = sh.sg;
    this.dispAlloc();   // makes the bind groups once the pipelines are there
    if (sh.pipes) this.usePipes(sh.pipes);
    this.whenReady = sh.promise.then((p) => { if (!this.dead && !this.ready) this.usePipes(p); return this; });
  }
  sgOn() { return this.sg && this.opt.subgroups !== false && !!this.pipes.buildListSG; }
  usePipes(p) {
    for (const name in this.L) if (p[name]) this.pipes[name] = { pipeline: p[name] };
    this.ready = true; this.makeGroups();
  }
  // per-block storage: cell count, type, pressure, rhs (4 bytes each per cell), two numbers for each of the three faces, plus slot bookkeeping
  makeSlotBuffers(n) {
    const mk = this.mk, C = 512;
    this.bCnt = mk(n * C * 4); this.bType = mk(n * C * 4); this.bPres = mk(n * C * 4); this.bRhs = mk(n * C * 4); this.bCalm = mk(n * C * 4);
    this.bAcc = mk(n * C * 12); this.bAccW = mk(n * C * 12); this.bVelG = mk(this.velGOn ? n * C * 12 : 16);   // kept velocity: only once narrow band is used
    this.bSlotList = mk(n * 4); this.bSlotTile = mk(n * 4); this.bStack = mk(n * 4);
    // fluid cell lists: without narrow band a water cell holds at least one particle; with it, deep water cells hold none, so the lists go by cells
    this.lcap = this.velGOn ? n * C : Math.min(n * C, this.MAXN); this.bList = mk(this.lcap * 8);
  }
  // multigrid's levels (wgsl-multigrid.js): MGS floats a slot for levels 1-3, then the dense levels over the box, halving until about 4
  // a side. Made on first use and again when the block pool grows. Returns the coarsest level.
  mgPlan() {
    let d = [this.tx, this.ty, this.tz], off = this.scap * 220; const dense = [];
    while (Math.max(...d) > 4 && dense.length < FLIP_MG_LEVELS - 3) { d = d.map((v) => Math.ceil(v / 2)); dense.push([d[0], d[1], d[2], off]); off += 3 * d[0] * d[1] * d[2]; }
    if (off !== this.mgSize) { this.bMg.destroy(); this.bMg = this.mk(off * 4); this.mgSize = off; this.makeGroups(); }
    this.mgDense = dense; return 3 + dense.length;
  }
  // the first narrow band step: room for the kept grid velocity and longer cell lists
  enableNB() {
    if (this.velGOn) return;
    this.velGOn = true;
    this.bVelG.destroy(); this.bVelG = this.mk(this.scap * 512 * 12);
    this.bList.destroy(); this.lcap = this.scap * 512; this.bList = this.mk(this.lcap * 8);
    this.makeGroups();
  }
  slotBufs() { return ['bCnt', 'bType', 'bPres', 'bRhs', 'bCalm', 'bAcc', 'bAccW', 'bVelG', 'bSlotList', 'bSlotTile', 'bStack']; }
  makeGroups() {
    if (!this.ready) return;
    const bufs = { 0: this.bParams, 1: this.bPos, 2: this.bVel, 3: this.bAcc, 5: this.bAccW, 6: this.bCnt, 7: this.bType, 8: this.bPres, 9: this.bRhs, 10: this.bCols, 11: this.bSdf,
      12: this.bCtl, 13: this.bList, 14: this.bArgs, 15: this.bDisp, 16: this.bTmap, 17: this.bNeed, 18: this.bSlotList, 19: this.bSlotTile, 20: this.bStack, 21: this.bNew,
      22: this.bSortCnt, 23: this.bTpos, 24: this.bTvel, 25: this.bGro, 26: this.bPid, 27: this.bTpid, 28: this.bSPos, 29: this.bSVel, 30: this.bSctl, 31: this.bVelG,
      32: this.bAir, 33: this.bSAux, 34: this.bAirAcc, 35: this.bAir2, 36: this.bDrip, 37: this.bPack, 38: this.bPackU, 39: this.bCalm, 40: this.bMg };
    for (const name in this.L) { const p = this.pipes[name]; if (!p) continue; p.bg = this.dev.createBindGroup({ layout: p.pipeline.getBindGroupLayout(0), entries: this.L[name].map((k) => ({ binding: k, resource: { buffer: bufs[k] } })) }); }
  }
  // more blocks: copy the old ones over unchanged and put the new slots on the free stack
  grow(n) {
    n = Math.min(this.scapMax, Math.max(n, this.scap + 1)); if (n <= this.scap) return false;
    const old = this.scap, keep = {}, per = { bCnt: 2048, bType: 2048, bPres: 2048, bRhs: 2048, bCalm: 2048, bAcc: 6144, bAccW: 6144, bVelG: 6144, bSlotList: 4, bSlotTile: 4, bStack: 4 };
    for (const k of this.slotBufs()) keep[k] = this[k];
    const oldList = this.bList;
    this.makeSlotBuffers(n); this.scap = n;
    this.dev.queue.writeBuffer(this.bGro, 0, new Uint32Array([old, n - old, 0, 0]));
    this.makeGroups();
    const enc = this.dev.createCommandEncoder();
    for (const k of this.slotBufs()) if (k !== 'bVelG' || this.velGOn) enc.copyBufferToBuffer(keep[k], 0, this[k], 0, old * per[k]);
    const ps = enc.beginComputePass(); const p = this.pipes.growFree; ps.setPipeline(p.pipeline); ps.setBindGroup(0, p.bg); const g = Math.ceil((n - old) / 256); ps.dispatchWorkgroups(Math.min(g, 65535), Math.ceil(g / 65535)); ps.end();
    this.dev.queue.submit([enc.finish()]);
    for (const k of this.slotBufs()) keep[k].destroy(); oldList.destroy();
    this.grew = (this.grew || 0) + 1;
    return true;
  }
  // grow before a step when the last finished step used most of the blocks, or some did not fit
  maybeGrow() {
    const s = this.stats; if (!s || s.seen) return;
    s.seen = true;
    const want = s.sc + s.ovf;
    if (s.ovf > 0 || want > 0.8 * this.scap) this.grow(Math.max(Math.ceil(this.scap * 1.5), Math.ceil(want * 1.4) + 8));
  }
  readStats(enc) {
    if (this.statBusy) return;
    enc.copyBufferToBuffer(this.bCtl, 0, this.bStat, 0, 64); this.statBusy = true;
    const done = () => this.dev.queue.onSubmittedWorkDone().then(() => this.bStat.mapAsync(GPUMapMode.READ)).then(() => {
      const a = new Uint32Array(this.bStat.getMappedRange().slice(0)); this.bStat.unmap();
      this.stats = { sc: a[4], ovf: a[5], fluid: a[0] + a[1] + a[15], settled: a[15], vmax: new Float32Array(a.buffer)[6], seen: false }; this.ovfTotal = (this.ovfTotal || 0) + a[5]; this.peak = Math.max(this.peak || 0, a[4]); this.statBusy = false;
    }).catch(() => { this.statBusy = false; });
    this.statPromise = new Promise((r) => setTimeout(r, 0)).then(done);
  }
  // run just the block allocation until everything fits; used before a bake so the first frames do not have to wait for the pool to grow
  async prime(o) {
    for (let k = 0; k < 8; k++) {
      if (this.statBusy) await this.statPromise;
      this.only = 'tiles'; this.step(1 / 60, o); this.only = null;
      await this.statPromise; this.stats.seen = true;
      if (this.stats.ovf === 0 && this.stats.sc <= 0.8 * this.scap) return;
      this.grow(Math.max(Math.ceil(this.scap * 1.5), Math.ceil((this.stats.sc + this.stats.ovf) * 1.4) + 8));
    }
  }
  step(dt, o) {
    this.lastDt = dt;
    this.flushRun();
    const N = this.N; if (N === 0 || !this.ready) return;
    if (!this.only) this.maybeGrow();
    const u32 = this.pu32, f32 = this.pf32, h = this.h, b = this.b;
    this.stride = Math.max(1, Math.ceil(N / this.dispMax)); this.lastN = N;
    const nbc = o.nb !== undefined ? o.nb : this.nbCfg, oc = (o.ocean && o.ocean.on) ? o.ocean : (o.ocean === undefined && this.oceanCfg && this.oceanCfg.on ? this.oceanCfg : null);
    const nbOn = !!(nbc && nbc.on) || !!oc; this.nbOn = nbOn;
    if (nbOn) this.enableNB();
    const init = nbOn && this.nbInit ? this.nbInit : 0; this.initStep = init;
    const fv = init ? this.nbFillVols : [];
    const ntot = packColliders(this, fv.length ? o.cols.concat(fv) : o.cols), nc = Math.min(o.cols.length, ntot), nfv = ntot - nc;
    {   // the per-cell collider lookup only changes when a collider moves, so rebuild it just then
      const cp = this.cfPrev, n32 = nc * 32; let same = cp && cp.n === nc && this.sdfSig === cp.sig && !this.opt.noSolidCache;
      if (same) for (let q = 0; q < n32; q++) if (cp.a[q] !== this.cf[q]) { same = false; break; }
      if (!same) { this.solidDirty = true; this.cfPrev = { n: nc, sig: this.sdfSig, a: this.cf.slice(0, n32) }; }
    }
    u32[0] = N; u32[1] = this.nx; u32[2] = this.ny; u32[3] = this.nz; u32[4] = nc; u32[5] = this.open; u32[6] = 0; u32[7] = this.ncell;
    const F = [dt, h, 1 / h, o.g, o.flip === undefined ? 0.95 : o.flip, this.rest, o.comp === undefined ? 6 : o.comp, this.opt.mg ? 1.4 : (o.omega || this.omega()),
      b.x0, b.y0, b.z0, o.vmax || 14, 0.3 * this.d, 65536, b.x1, b.y1, b.z1, 0.3 * h,
      (o.wind && o.wind[0]) || 0, (o.wind && o.wind[1]) || 0, (o.wind && o.wind[2]) || 0, o.drag || 0, o.foamTau || 1.2, o.foamSens || 1, o.gust || 0, this.tm || 0, this.opt.noFoam ? 1 : 0, this.opt.noCull ? 1 : 0, this.stride, this.opt.fastAir ? 1 : 0];
    if (!this.only) this.tm = (this.tm || 0) + dt;
    for (let k = 0; k < F.length; k++) f32[8 + k] = F[k];
    const B = 8 + F.length; u32[B] = this.lcap; u32[B + 1] = this.tx; u32[B + 2] = this.ty; u32[B + 3] = this.tz; u32[B + 4] = this.scap;
    const sp = o.spr || null, on = !!sp && this.sprayCap > 0;
    f32[B + 5] = o.tear || 0; f32[B + 6] = on ? sp.rate : 0; f32[B + 7] = on ? Math.max(0.05, sp.min) : 1; f32[B + 8] = on ? sp.life : 1; f32[B + 9] = on ? sp.mist : 0;
    f32[B + 10] = on ? sp.drag : 1; f32[B + 11] = on ? sp.mdrag : 4; f32[B + 12] = o.vs || 1; if (!this.only) this.vs = o.vs || 1;
    u32[B + 13] = this.sprayCap; u32[B + 14] = this.stride <= 1 ? N : Math.ceil(N / this.stride); u32[B + 15] = this.sprDispMax;
    if (!this.only) this.seed = (this.seed + 1) >>> 0; u32[B + 16] = this.seed;
    this.sprOnStep = on;
    // narrow band and ocean (words 55 on, then the starting-water shapes and the wave list)
    u32[55] = nbOn ? 1 : 0; f32[56] = Math.max(2, (nbc && nbc.band) || 3); u32[57] = oc ? 1 : 0;
    let nw = 0;
    if (oc) {
      const key = JSON.stringify(oc) + '|' + o.g;
      if (key !== this.oceanKey) { this.oceanKey = key; this.oceanW = oceanWaves(oc, o.g, oc.level - b.y0); }
      nw = this.oceanW.n; f32.set(this.oceanW.w, 148);
    }
    u32[58] = nw; f32[59] = o.time || 0; f32[60] = oc ? oc.level : 0; f32[61] = oc ? oc.layer : 0; f32[62] = nbOn && this.deepOn ? u32[B + 14] + this.sprDispMax : 0;
    f32[63] = b.y0; u32[64] = init; const fl = init ? this.nbFills.slice(0, 8) : []; u32[65] = fl.length; f32[66] = oc ? Math.max(oc.level - b.y0, 1e-3) : 1; u32[67] = nfv;
    fl.forEach((f, k) => { const q = 84 + k * 8; if (f.t === 'box') f32.set([1, f.x0, f.y0, f.z0, f.x1, f.y1, f.z1, 0], q); else f32.set([2, f.x, f.y, f.z, f.r, 0, 0, 0], q); });
    if (init && !this.only) { this.nbInit = 0; this.nbFills = []; this.nbFillVols = []; }
    // whitewater, air field and drips (words 68-83)
    const ww = (sp && sp.ww) || {}, airo = on && o.air && o.air.on ? o.air : null, dr = on && o.drip && o.drip.on ? o.drip : null;
    if (airo) this.airAlloc();
    const ad = this.airDims;
    f32[68] = ww.foamLife || 3; f32[69] = ww.rise || 0.3; f32[70] = ww.crest === undefined ? 1 : ww.crest; f32[71] = ww.impact === undefined ? 0.5 : ww.impact;
    u32[72] = airo && ad ? 1 : 0; f32[73] = airo ? airo.couple : 0; f32[74] = airo ? airo.decay : 0; f32[75] = ad ? ad.h : 1;
    u32[76] = ad ? ad.nx : 1; u32[77] = ad ? ad.ny : 1; u32[78] = ad ? ad.nz : 1;
    if (dr) this.dripUpdate(o.cols.slice(0, nc)); u32[79] = dr ? this.ndrip : 0;
    f32[80] = dr ? dr.rate : 0; f32[81] = dr ? dr.dry : 1; f32[82] = airo ? (airo.blur === undefined ? 0.35 : airo.blur) : 0;
    this.ab = wwAreaBox(b, ww.area); f32.set([this.ab.x0, this.ab.y0, this.ab.z0, 0, this.ab.x1, this.ab.y1, this.ab.z1, 0], 408);
    f32[83] = ww.spin === undefined ? 0.5 : ww.spin; f32[404] = Math.cos((ww.edge === undefined ? 70 : ww.edge) * Math.PI / 180); f32[405] = ww.erode === undefined ? 0.25 : ww.erode;
    f32[406] = ww.land === undefined ? 1 : ww.land; f32[407] = ww.trail === undefined ? 1 : ww.trail;
    f32[416] = this.opt.ballistic && !this.wwOnly ? 1 : 0; f32[417] = this.opt.settle ? (this.opt.settleTol || 0.001) : 0;
    if (this.opt.mg && !this.wwOnly) { this.mgTop = this.mgPlan(); this.mgDense.forEach((q, k) => u32.set(q, 424 + 4 * k)); f32[420] = this.opt.mgW || 1; }
    this.airOnStep = !!(airo && ad); this.dripOnStep = !!(dr && this.ndrip > 0);
    this.dev.queue.writeBuffer(this.bParams, 0, this.pu);
    const iters = Math.max(1, (this.opt.iters || o.iters) | 0);
    const enc = this.dev.createCommandEncoder(), ts = this.tsq && !this.tsBusy && !this.only;
    const pass = enc.beginComputePass(ts ? { timestampWrites: { querySet: this.tsq, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : undefined);
    for (const st of this.stages(N, iters)) st.fn(pass);
    pass.end();
    if (ts) { enc.resolveQuerySet(this.tsq, 0, 2, this.tsRes, 0); enc.copyBufferToBuffer(this.tsRes, 0, this.tsRead, 0, 16); }
    this.readStats(enc);
    this.dev.queue.submit([enc.finish()]);
    if (ts) {
      this.tsBusy = true;
      this.tsRead.mapAsync(GPUMapMode.READ, 0, 16).then(() => {
        const a = new BigUint64Array(this.tsRead.getMappedRange(0, 16)), ms = Number(a[1] - a[0]) / 1e6; this.tsRead.unmap(); this.tsBusy = false;
        if (ms > 0 && ms < 1e4) { const r = this.gpuSteps || (this.gpuSteps = []); r.push(ms); if (r.length > 31) r.shift(); const s = r.slice().sort((x, y) => x - y); this.gpuMs = s[s.length >> 1]; }
      }).catch(() => { this.tsBusy = false; });
    }
    if (!this.only) { this.needRead = true; this.track(); }
    return nc;
  }
  // SOR over-relaxation: a little higher on bigger grids converges faster, capped to stay stable
  omega() { return Math.min(1.9, 2 / (1 + Math.sin(Math.PI / Math.max(this.nx, this.ny, this.nz)))); }
  // the solver split into named stages, so a benchmark can time each of them on its own
  stages(N, iters) {
    const dispatch = (pass, name, items) => {
      const p = this.pipes[name], groups = Math.ceil(items / 256);
      pass.setPipeline(p.pipeline); pass.setBindGroup(0, p.bg);
      pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
    };
    const indirect = (ps, name, off) => { const p = this.pipes[name]; ps.setPipeline(p.pipeline); ps.setBindGroup(0, p.bg); ps.dispatchWorkgroupsIndirect(this.bArgs, off); };
    const nb = this.nbOn, init = this.initStep;
    const tiles = { name: 'blocks', fn: (ps) => {
      dispatch(ps, 'tileNeedClear', this.ntiles); dispatch(ps, 'tileMark', N);
      if (nb && init !== 1) indirect(ps, 'tileMarkPhi', 64);   // last step's blocks that hold water by depth (before the counters reset)
      if (init) dispatch(ps, 'tileMarkFill', this.ntiles);
      dispatch(ps, 'tileReset', 1);
      dispatch(ps, 'tileFree', this.ntiles); dispatch(ps, 'argsNew', 1); indirect(ps, 'tileAlloc', 32); dispatch(ps, 'tileFix', 1);
      indirect(ps, 'initNew', 48); dispatch(ps, 'slotListBuild', this.ntiles); dispatch(ps, 'argsSlots', 1);
      if (init) indirect(ps, 'phiInitAll', 64);
    } };
    if (this.only === 'tiles') return [tiles];
    if (this.opt.sort && this.bTpos.size < this.MAXN * 16) {   // the sort needs a second copy of the particles
      this.bTpos.destroy(); this.bTvel.destroy(); this.bTpid.destroy();
      this.bTpos = this.mk(this.MAXN * 16); this.bTvel = this.mk(this.MAXN * 16); this.bTpid = this.mk(this.MAXN * 4);
      this.makeGroups();
    }
    const sortStage = { name: 'sort', fn: (ps) => {
      // sort when the particles may have left their blocks: the fastest water has crossed about two cells since the last sort (read
      // back a step or two late, so it is an estimate), at least every 64 steps and at most every 4; a fixed sortEvery when sortAuto is off
      this.sortTick++;
      if (this.opt.sortAuto === false) { if ((this.sortTick - 1) % Math.max(1, this.opt.sortEvery | 0) !== 0) return; }
      else {
        this.sortMoved = (this.sortMoved || 0) + ((this.stats && this.stats.vmax) || 0) * (this.lastDt || 0) / this.h;
        if (this.sortedEver && !(this.sortTick >= 64 || (this.sortTick >= 4 && this.sortMoved >= 2))) return;
        this.sortTick = 0; this.sortMoved = 0; this.sortsDone = (this.sortsDone || 0) + 1;
      }
      this.sortedEver = true;
      dispatch(ps, 'sortClear', 65536); dispatch(ps, 'sortHist', N);
      const p = this.pipes.sortScan; ps.setPipeline(p.pipeline); ps.setBindGroup(0, p.bg); ps.dispatchWorkgroups(1);
      dispatch(ps, 'sortScatter', N); dispatch(ps, 'sortCopy', N);
    } };
    const all = [
      ...(this.opt.sort ? [sortStage] : []),
      tiles,
      { name: 'clear', fn: (ps) => indirect(ps, 'clearSlots', 80) },
      { name: 'p2g', fn: (ps) => dispatch(ps, this.opt.p2gWin ? 'p2gWin' : 'p2g', N) },
      ...(nb ? [{ name: 'narrow band', fn: (ps) => {
        indirect(ps, 'nbPhi', 64); indirect(ps, 'nbJacA', 64); indirect(ps, 'nbJacB', 64); indirect(ps, 'nbJacA', 64);
      } }] : []),
      { name: 'classify', fn: (ps) => {
        if (this.solidDirty) { indirect(ps, 'solidBuild', 64); this.solidDirty = false; }
        indirect(ps, 'classify', 64);
        if (nb) indirect(ps, 'nbVel', 64);
      } },
      { name: 'normFaces', fn: (ps) => indirect(ps, 'normFaces', 64) },
      // the pressure lists are built after the divergence, so settled cells (settled in wgsl-solver.js) can be left out of them
      { name: 'divergence', fn: (ps) => {
        indirect(ps, 'divergence', 64);
        indirect(ps, 'settleMark', 64);   // also when off, so the counters start again from 0 when it is turned back on
        dispatch(ps, 'listClear', 1); indirect(ps, this.sgOn() ? 'buildListSG' : 'buildList', 64); dispatch(ps, 'listArgs', 1);
      } },
      { name: 'pressure', fn: (ps) => {
        const sweep = (n) => { for (let it = 0; it < n; it++) for (const [nm, off] of [['rbRed', 0], ['rbBlack', 16]]) indirect(ps, nm, off); };
        if (!this.opt.mg || !this.mgTop) { sweep(iters); return; }
        // multigrid (wgsl-multigrid.js): V-cycles, about one per 10 of the iterations asked for, each with four sweeps of the solver's cells
        // before (over-relaxed 1.4: on a deep lake at 0.04, three cycles left 1/45 of the error 30 sweeps at 1.9 left, for less work); levels 1-3 are dispatched over the blocks in use, the dense levels over their whole grid
        const top = this.mgTop, dz = this.mgDense;
        const lv = (nm, l) => (l <= 3 ? indirect(ps, nm, [0, 128, 144, 160][l]) : dispatch(ps, nm, dz[l - 4][0] * dz[l - 4][1] * dz[l - 4][2]));
        const smooth = (l, n) => { for (let k = 0; k < n; k++) { lv('mgS' + l + 'a', l); lv('mgS' + l + 'b', l); } };
        dispatch(ps, 'mgArgs', 1);
        for (let c = 0, nc = Math.max(1, Math.round(iters / 10)); c < nc; c++) {
          sweep(this.opt.mgPre || 4);
          for (let l = 1; l <= top; l++) { lv('mgDown' + l, l); smooth(l, l === top ? 16 : 2); }
          for (let l = top - 1; l >= 1; l--) { lv('mgUp' + l, l); smooth(l, 2); }
          indirect(ps, 'mgUp0', 64);
        }
        sweep(2);
      } },
      { name: 'project', fn: (ps) => { indirect(ps, 'project', 64); if (nb) indirect(ps, 'saveVel', 64); } },
      { name: 'g2p', fn: (ps) => dispatch(ps, this.opt.p2gWin ? 'g2pWin' : 'g2p', N) },
      ...(this.opt.ballistic ? [{ name: 'ballistic', fn: (ps) => dispatch(ps, 'ballistic', N) }] : []),
      // opt.noFoam (benchmark row C) also leaves out the whitewater stages, so the row shows what whitewater costs
      ...(this.sprayCap > 0 && this.airOnStep && !this.opt.noFoam ? [{ name: 'air', fn: (ps) => {   // air field first, so the whitewater moves with this step's air
        const na = this.airDims.n;
        dispatch(ps, 'wwArgs', 1);
        dispatch(ps, 'airClear', na); dispatch(ps, 'airSplatW', N); indirect(ps, 'airSplatS', 112); dispatch(ps, 'airUpdate', na); dispatch(ps, 'airCopy', na);
      } }] : []),
      // whitewater in three timed parts: sampling the water at each point, moving the points, and making new ones from the water
      ...(this.sprayCap > 0 && !this.opt.noFoam ? [
        { name: 'ww sample', fn: (ps) => { dispatch(ps, 'wwArgs', 1); indirect(ps, 'wwSample', 112); } },
        { name: 'ww move', fn: (ps) => { indirect(ps, 'sprayStep', 112); } },
        { name: 'ww emit', fn: (ps) => {
          if (this.sprOnStep) { dispatch(ps, 'sprayEmit', N); if (this.pf32[83] > 0) dispatch(ps, 'spinEmit', N); }
          if (this.dripOnStep) dispatch(ps, 'dripStep', this.ndrip);
        } }] : []),
      ...(nb ? [{ name: 'reseed', fn: (ps) => {
        dispatch(ps, 'nbKill', N); dispatch(ps, 'nbReset', 1); dispatch(ps, 'nbDead', N); indirect(ps, 'nbDeficit', 64); dispatch(ps, 'nbArgs', 1); indirect(ps, 'nbSpawn', 96);
      } }] : [])
    ];
    // whitewater pass over a bake (runWhitewaterPass): the baked particles only build the grid (no pressure solve, no moving them by the
    // grid), the whitewater stages run, then the particles move on along their velocity towards the next baked frame
    if (this.wwOnly) return all.filter((st) => WWSTAGES.has(st.name)).concat([{ name: 'advect', fn: (ps) => dispatch(ps, 'wwAdvect', N) }]);
    return all;
  }
  // benchmark helper: run one real step stage by stage, returning milliseconds per stage. With timestamp queries every stage is timed
  // on the GPU in one submission (out.gpu = true); without, each stage is submitted and waited for alone, which adds a fixed cost to each.
  async stepTimed(dt, o) {
    await this.whenReady;
    const N = this.N; if (N === 0) return null;
    this.maybeGrow();
    const iters = Math.max(1, (this.opt.iters || o.iters) | 0);
    const prev = this.stages; this.stages = () => [];
    FlipSim.prototype.step.call(this, dt, o);   // uploads parameters and collider data, runs nothing
    this.stages = prev;
    const stages = this.stages(N, iters);
    const out = {};
    if (this.tsq && stages.length <= 32) {
      while (this.tsBusy) await new Promise((r) => setTimeout(r, 1));
      this.tsBusy = true;
      const enc = this.dev.createCommandEncoder();
      stages.forEach((st, k) => { const ps = enc.beginComputePass({ timestampWrites: { querySet: this.tsq, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 } }); st.fn(ps); ps.end(); });
      enc.resolveQuerySet(this.tsq, 0, 2 * stages.length, this.tsRes, 0); enc.copyBufferToBuffer(this.tsRes, 0, this.tsRead, 0, 16 * stages.length);
      this.dev.queue.submit([enc.finish()]);
      try {
        await this.tsRead.mapAsync(GPUMapMode.READ, 0, 16 * stages.length);
        const a = new BigUint64Array(this.tsRead.getMappedRange(0, 16 * stages.length));
        stages.forEach((st, k) => { out[st.name] = Math.max(0, Number(a[2 * k + 1] - a[2 * k])) / 1e6; });
        this.tsRead.unmap();
      } finally { this.tsBusy = false; }
      out.gpu = true; this.needRead = true;
      return out;
    }
    for (const st of stages) {
      const t0 = performance.now();
      const enc = this.dev.createCommandEncoder(), ps = enc.beginComputePass(); st.fn(ps); ps.end();
      this.dev.queue.submit([enc.finish()]);
      await this.dev.queue.onSubmittedWorkDone();
      out[st.name] = performance.now() - t0;
    }
    this.needRead = true;
    return out;
  }
  // room for n spray points (0 turns spray off). The live view shows an even sample of up to 200k of them after the water points.
  setSprayCap(n) {
    n = Math.max(0, Math.min(n | 0, Math.floor((this.dev.limits.maxStorageBufferBindingSize || (1 << 27)) / 16)));
    if (n === this.sprayCap) return;
    [this.bSPos, this.bSVel, this.bSAux].forEach((x) => x.destroy());
    this.sprayCap = n; this.sprDispMax = Math.min(n, 200000);
    this.bSPos = this.mk(Math.max(n, 1) * 16); this.bSVel = this.mk(Math.max(n, 1) * 16); this.bSAux = this.mk(Math.max(n, 1) * 16);
    this.bSctl.destroy(); this.bSctl = this.mk((16 + n) * 4);   // counters, then the free list of dead whitewater slots (wwAlloc)
    if (this.sstage) { this.sstage.destroy(); this.sstage = null; }
    this.dispAlloc();
  }
  // the air field's grid: cells a few solver cells wide, at most about 260 thousand of them
  airAlloc() {
    if (this.airDims) return;
    const r = Math.max(2, Math.ceil(Math.cbrt(this.ncell / 260000))), h = this.h * r;
    const nx = Math.ceil(this.nx / r) + 1, ny = Math.ceil(this.ny / r) + 1, nz = Math.ceil(this.nz / r) + 1, n = nx * ny * nz;
    [this.bAir, this.bAir2, this.bAirAcc].forEach((x) => x.destroy());
    this.bAir = this.mk(n * 16); this.bAir2 = this.mk(n * 16); this.bAirAcc = this.mk(n * 16);
    this.airDims = { nx, ny, nz, n, h };
    this.makeGroups();
  }
  // drip samples: points over each collider's surface, taken from its distance grid, rebuilt when the set of colliders changes
  dripUpdate(cols) {
    const sig = cols.map((c) => (c.sdf ? c.sdf.id : 'x')).join(',');
    if (sig === this.dripSig) return;
    this.dripSig = sig;
    const parts = []; let n = 0;
    cols.forEach((c, k) => { if (!c.sdf) return; const a = dripSamples(c.sdf, this.h, k); parts.push(a); n += a.length / 8; });
    const all = new Float32Array(Math.max(n, 1) * 8); let o = 0; parts.forEach((a) => { all.set(a, o); o += a.length; });
    if (this.bDrip.size < all.byteLength) { this.bDrip.destroy(); this.bDrip = this.mk(all.byteLength); this.makeGroups(); }
    this.dev.queue.writeBuffer(this.bDrip, 0, all);
    this.ndrip = n;
  }
  // the live view's gather buffer: water sample, then spray, then (narrow band, look only) the deep water points
  dispAlloc() {
    const dm = this.deepOn ? FLIP_DEEPMAX : 0;
    this.bDisp.destroy(); this.bDisp = this.mk((Math.min(this.MAXN, this.dispMax + 1) + this.sprDispMax + dm) * 16 + 16);
    this.ringCap = Math.min(this.MAXN, this.dispMax + 1) + this.sprDispMax + dm;
    const big = this.packLayout(Math.min(this.MAXN, this.dispMax + 1), this.sprDispMax, dm);   // the packed live view at its largest
    this.bPack.destroy(); this.bPack = this.mk(big.words * 4); this.packWords = big.words;
    (this.rs || []).forEach((q) => { try { q.buf.destroy(); } catch (e) { /* ignore */ } }); this.rs = null;
    this.makeGroups();
  }
  // where each part of the packed live view goes, in 32-bit words (see packDisp): a 4-word header, then the water's positions, speed bytes and
  // white-water bytes, the whitewater's positions and codes, the deep water's positions and speed bytes. Every part is a whole number of words.
  packLayout(nW, nS, nD) {
    const gW = Math.ceil(nW / 4), gS = Math.ceil(nS / 4), gD = Math.ceil(nD / 4), L = { nW, nS, nD, groups: gW + gS + gD, oWp: 4 };
    L.oWs = L.oWp + gW * 6; L.oWf = L.oWs + gW; L.oSp = L.oWf + gW; L.oSk = L.oSp + gS * 6; L.oDp = L.oSk + gS * 4; L.oDs = L.oDp + gD * 6; L.words = L.oDs + gD;
    return L;
  }
  // gather the live view (a sample of the water, the whitewater, the deep water) and pack it on the GPU into bPack; returns the layout
  dispPack(enc) {
    const spr = this.sprDispMax > 0 && this.lastN, deep = this.deepOn && this.nbOn && this.velGOn && this.lastN;
    const fromPos = !spr && !deep && (this.stride <= 1 || !this.lastN);
    const nW = fromPos ? Math.min(this.N, this.dispMax + 1, this.MAXN) : Math.ceil(this.lastN / this.stride);
    this.dispWaterN = nW;
    const L = this.packLayout(nW, spr ? this.sprDispMax : 0, deep ? FLIP_DEEPMAX : 0);
    const b = this.b, ab = this.ab || b, u = new ArrayBuffer(128), u32 = new Uint32Array(u), f32 = new Float32Array(u);
    f32.set([ab.x0, ab.y0, ab.z0, 65535 / (ab.x1 - ab.x0), 65535 / (ab.y1 - ab.y0), 65535 / (ab.z1 - ab.z0), 0, 0], 24); L.sb = Object.assign({}, ab);
    u32.set([L.nW, L.nS, L.nD, fromPos ? 1 : 0, nW, deep ? Math.round(this.pf32[62]) : 0, L.oWp, L.oWs, L.oWf, L.oSp, L.oSk, L.oDp, L.oDs, 0, 0, 0]);
    f32.set([b.x0, b.y0, b.z0, 65535 / (b.x1 - b.x0), 65535 / (b.y1 - b.y0), 65535 / (b.z1 - b.z0), this.vs || 1, 0], 16);
    this.dev.queue.writeBuffer(this.bPackU, 0, u);
    const run = (ps, name, items) => { const p = this.pipes[name], g = Math.ceil(items / 256); ps.setPipeline(p.pipeline); ps.setBindGroup(0, p.bg); ps.dispatchWorkgroups(Math.max(1, Math.min(g, 65535)), Math.max(1, Math.ceil(g / 65535))); };
    const ps = enc.beginComputePass();
    if (!fromPos) run(ps, 'subsample', nW);
    if (spr) { run(ps, 'dispBegin', 1); run(ps, this.sgOn() ? 'sprayDispSG' : 'sprayDisp', this.sprayCap); }
    if (deep) {
      const c = this.pipes.deepClear, g3 = Math.ceil(FLIP_DEEPMAX / 256); ps.setPipeline(c.pipeline); ps.setBindGroup(0, c.bg); ps.dispatchWorkgroups(Math.min(g3, 65535), Math.ceil(g3 / 65535));
      const q = this.pipes.deepPick; ps.setPipeline(q.pipeline); ps.setBindGroup(0, q.bg); ps.dispatchWorkgroupsIndirect(this.bArgs, 64);
      const f = this.pipes.deepFin; ps.setPipeline(f.pipeline); ps.setBindGroup(0, f.bg); ps.dispatchWorkgroups(1);
    }
    if (L.groups) run(ps, 'packDisp', L.groups * 1); else run(ps, 'packDisp', 1);
    ps.end();
    return L;
  }
  // narrow band look only: draw the deep water (cells with no particles) as points too
  setDeepLook(on) { on = !!on; if (on === !!this.deepOn) return; this.deepOn = on; this.dispAlloc(); }
  // narrow band look only, for bakes: the deep water points of the last step (x, y, z, 4096 + speed), compacted
  async readDeep() {
    if (!this.deepOn || !this.nbOn || !this.velGOn || !this.lastN) return null;
    const off = Math.round(this.pf32[62]) * 16, bytes = FLIP_DEEPMAX * 16;
    if (off + bytes > this.bDisp.size) return null;
    if (!this.dstage) this.dstage = this.dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.dev.createCommandEncoder(), ps = enc.beginComputePass();
    const c = this.pipes.deepClear, g3 = Math.ceil(FLIP_DEEPMAX / 256); ps.setPipeline(c.pipeline); ps.setBindGroup(0, c.bg); ps.dispatchWorkgroups(Math.min(g3, 65535), Math.ceil(g3 / 65535));
    const q = this.pipes.deepPick; ps.setPipeline(q.pipeline); ps.setBindGroup(0, q.bg); ps.dispatchWorkgroupsIndirect(this.bArgs, 64);
    const f = this.pipes.deepFin; ps.setPipeline(f.pipeline); ps.setBindGroup(0, f.bg); ps.dispatchWorkgroups(1);
    ps.end(); enc.copyBufferToBuffer(this.bDisp, off, this.dstage, 0, bytes); this.dev.queue.submit([enc.finish()]);
    await this.dstage.mapAsync(GPUMapMode.READ);
    const a = new Float32Array(this.dstage.getMappedRange().slice(0)); this.dstage.unmap();
    const n = compactLive(a, FLIP_DEEPMAX); return { n, p: a.subarray(0, n * 4) };
  }
  // all spray slots, for bakes: positions with life in w, velocities with kind in w
  async readSpray() {
    if (!this.sprayCap) return null;
    // how many slots have been handed out: until the ring wraps, the rest have never been used
    if (!this.sctlStage) this.sctlStage = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    { const e0 = this.dev.createCommandEncoder(); e0.copyBufferToBuffer(this.bSctl, 0, this.sctlStage, 0, 16); this.dev.queue.submit([e0.finish()]); }
    await this.sctlStage.mapAsync(GPUMapMode.READ); const used = new Uint32Array(this.sctlStage.getMappedRange().slice(0))[0]; this.sctlStage.unmap();
    const n = Math.max(1, Math.min(this.sprayCap, used));
    if (!this.sstage || this.sstage.size < n * 32) { if (this.sstage) this.sstage.destroy(); this.sstage = this.dev.createBuffer({ size: Math.min(this.sprayCap, Math.max(n * 2, 65536)) * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); }
    const enc = this.dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.bSPos, 0, this.sstage, 0, n * 16); enc.copyBufferToBuffer(this.bSVel, 0, this.sstage, n * 16, n * 16);
    this.dev.queue.submit([enc.finish()]);
    await this.sstage.mapAsync(GPUMapMode.READ, 0, n * 32);
    const a = new Float32Array(this.sstage.getMappedRange(0, n * 32).slice(0)); this.sstage.unmap();
    return { n, p: a.subarray(0, n * 4), v: a.subarray(n * 4, n * 8) };
  }
  // bakes read particles back in their original order, so playback can blend each one between frames
  readbackInto(dst) {
    if (!this.sortedEver) return GpuSim.prototype.readbackInto.call(this, dst);
    this.flushRun();
    const n = this.N, bytes = Math.max(n, 1) * 16;
    if (!this.stage) this.stage = this.dev.createBuffer({ size: Math.max(this.MAXN * 16, 16), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.pu32[0] = n; this.dev.queue.writeBuffer(this.bParams, 0, this.pu, 0, 4);
    const enc = this.dev.createCommandEncoder(), ps = enc.beginComputePass(), p = this.pipes.unsort, g = Math.ceil(n / 256);
    ps.setPipeline(p.pipeline); ps.setBindGroup(0, p.bg); ps.dispatchWorkgroups(Math.min(g, 65535), Math.ceil(g / 65535)); ps.end();
    enc.copyBufferToBuffer(this.bTpos, 0, this.stage, 0, bytes);
    this.dev.queue.submit([enc.finish()]);
    this.needRead = false;
    return this.stage.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
      if (n > 0) dst.set(new Float32Array(this.stage.getMappedRange(0, bytes)).subarray(0, n * 4));
      this.stage.unmap();
      return n;
    });
  }
  // debugging: one column of cells (type, depth, particle count, kept vertical velocity) at grid (i, k)
  async dbgColumn(i, k) {
    const rd = async (buf, bytes) => { const st = this.dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const enc = this.dev.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, st, 0, bytes); this.dev.queue.submit([enc.finish()]); await st.mapAsync(GPUMapMode.READ); const a = st.getMappedRange().slice(0); st.unmap(); st.destroy(); return a; };
    const tmap = new Uint32Array(await rd(this.bTmap, this.ntiles * 4)), bytes = this.scap * 512 * 4;
    const ty = new Uint32Array(await rd(this.bType, bytes)), cn = new Int32Array(await rd(this.bCnt, bytes)), vg = new Float32Array(await rd(this.bVelG, bytes * 3)), pr = new Float32Array(await rd(this.bPres, bytes));
    const out = [];
    for (let j = 0; j < this.ny; j++) {
      const t = (i >> 3) + this.tx * ((j >> 3) + this.ty * (k >> 3)), s = tmap[t];
      if (s === 0xffffffff) { out.push({ j, none: true }); continue; }
      const c = s * 512 + (i & 7) + 8 * ((j & 7) + 8 * (k & 7));
      out.push({ j, ty: ty[c] & 255, col: (ty[c] >> 8) & 255, phi: +(8 - (ty[c] >>> 16) / 4096).toFixed(2), n: cn[c], vy: +vg[c * 3 + 1].toFixed(3), p: +pr[c].toFixed(4) });
    }
    return out;
  }
  async dbgRow(j, k) {
    const rd = async (buf, bytes) => { const st = this.dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const enc = this.dev.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, st, 0, bytes); this.dev.queue.submit([enc.finish()]); await st.mapAsync(GPUMapMode.READ); const a = st.getMappedRange().slice(0); st.unmap(); st.destroy(); return a; };
    const tmap = new Uint32Array(await rd(this.bTmap, this.ntiles * 4)), bytes = this.scap * 512 * 4;
    const ty = new Uint32Array(await rd(this.bType, bytes)), cn = new Int32Array(await rd(this.bCnt, bytes)), vg = new Float32Array(await rd(this.bVelG, bytes * 3));
    const out = [];
    for (let i = 0; i < this.nx; i++) {
      const t = (i >> 3) + this.tx * ((j >> 3) + this.ty * (k >> 3)), s = tmap[t];
      if (s === 0xffffffff) { out.push('-'); continue; }
      const c = s * 512 + (i & 7) + 8 * ((j & 7) + 8 * (k & 7));
      out.push((ty[c] & 255) + '/' + (+(8 - (ty[c] >>> 16) / 4096).toFixed(1)) + '/' + cn[c] + '/' + vg[c * 3].toFixed(3) + '/' + vg[c * 3 + 1].toFixed(3));
    }
    return out;
  }
  // testing the pressure solve: how far the pressure is from solving it exactly, over every water cell after the last step (root mean
  // square of the residual, against that of the right-hand side, so 0 is exact and 1 is as bad as no pressure at all)
  async presResidual() {
    const rd = async (buf, bytes) => { const st = this.dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const enc = this.dev.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, st, 0, bytes); this.dev.queue.submit([enc.finish()]); await st.mapAsync(GPUMapMode.READ); const a = st.getMappedRange().slice(0); st.unmap(); st.destroy(); return a; };
    const tmap = new Uint32Array(await rd(this.bTmap, this.ntiles * 4)), bytes = this.scap * 512 * 4;
    const ty = new Uint32Array(await rd(this.bType, bytes)), pr = new Float32Array(await rd(this.bPres, bytes)), rh = new Float32Array(await rd(this.bRhs, bytes));
    const open = this.open, nx = this.nx, ny = this.ny, nz = this.nz;
    const idx = (i, j, k) => { const s = tmap[(i >> 3) + this.tx * ((j >> 3) + this.ty * (k >> 3))]; return s === 0xffffffff ? -1 : s * 512 + (i & 7) + 8 * ((j & 7) + 8 * (k & 7)); };
    const tyOf = (i, j, k) => {
      if (i < 0) return open & 1 ? 0 : 2; if (i >= nx) return open & 2 ? 0 : 2; if (j < 0) return open & 4 ? 0 : 2; if (j >= ny) return open & 8 ? 0 : 2; if (k < 0) return open & 16 ? 0 : 2; if (k >= nz) return open & 32 ? 0 : 2;
      const c = idx(i, j, k); return c < 0 ? 0 : ty[c] & 255;
    };
    let r2 = 0, b2 = 0, n = 0;
    for (let t = 0; t < this.ntiles; t++) {
      const s = tmap[t]; if (s === 0xffffffff) continue;
      const bi = (t % this.tx) * 8, tt = Math.floor(t / this.tx), bj = (tt % this.ty) * 8, bk = Math.floor(tt / this.ty) * 8;
      for (let l = 0; l < 512; l++) {
        const c = s * 512 + l; if ((ty[c] & 255) !== 1) continue;
        const i = bi + (l & 7), j = bj + ((l >> 3) & 7), k = bk + (l >> 6); if (i >= nx || j >= ny || k >= nz) continue;
        let sum = 0, nns = 0;
        for (const [a, b2_, c2] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]) { const q = tyOf(i + a, j + b2_, k + c2); if (q === 2) continue; nns++; if (q === 1) sum += pr[idx(i + a, j + b2_, k + c2)]; }
        const r = rh[c] - (nns * pr[c] - sum); r2 += r * r; b2 += rh[c] * rh[c]; n++;
      }
    }
    return { cells: n, rel: Math.sqrt(r2 / Math.max(b2, 1e-30)) };
  }
  // number of cells that hold water, read back from the fluid list counters
  async activeCells() {
    const st = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.dev.createCommandEncoder(); enc.copyBufferToBuffer(this.bCtl, 0, st, 0, 32); this.dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ); const a = new Uint32Array(st.getMappedRange().slice(0)); st.unmap(); st.destroy();
    this.blocksUsed = a[4];
    return a[0] + a[1];
  }
  // GPU memory now held: particles plus the block pool
  memBytes() {
    const M = this.MAXN, slots = this.scap * 512 * (16 + 24 + (this.velGOn ? 12 : 0)) + this.scap * 12 + this.lcap * 8;
    return M * 36 + (this.bTpos.size > 16 ? M * 36 : 0) + this.ntiles * 16 + slots + this.ringCap * 16 * 4 + this.sprayCap * 32;
  }
  destroy() {
    this.dead = true;
    [this.tsq, this.tsRes, this.tsRead].forEach((x) => { try { x && x.destroy(); } catch (e) { /* ignore */ } });
    [this.bPos, this.bVel, this.bPid, this.bTpid, this.bSPos, this.bSVel, this.bSctl, this.sstage, this.bTmap, this.bNeed, this.bNew, this.bCols, this.bSortCnt, this.bTpos, this.bTvel, this.bSdf, this.bParams, this.stage, this.bList, this.bCtl, this.bGro, this.bArgs, this.bDisp, this.bStat, this.dstage, this.sctlStage, this.bSAux, this.bAir, this.bAir2, this.bAirAcc, this.bDrip, this.bPack, this.bPackU]
      .concat(this.slotBufs().map((k) => this[k])).forEach((x) => { try { x && x.destroy(); } catch (e) { /* ignore */ } });
    (this.rs || []).forEach((q) => q.buf.destroy());
  }
}
['setCap', 'clear', 'add', 'flushRun', 'track', 'fillBox', 'fillSphere'].forEach((m) => { FlipSim.prototype[m] = GpuSim.prototype[m]; });
// The live view: packed on the GPU (dispPack) and read back with up to three copies in flight, so stepping never waits for them.
// The newest finished copy becomes this.outFrame, a frame in the cache format that the drawing uploads as it is and the live cache keeps.
FlipSim.prototype.pump = function () {
  if (!this.needRead || !this.ready) return;
  if (!this.rs) this.rs = [0, 1, 2].map(() => ({ buf: this.dev.createBuffer({ size: Math.max(this.packWords * 4, 16), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }));
  const s = this.rs.find((q) => !q.busy); if (!s) return;
  this.flushRun();
  const enc = this.dev.createCommandEncoder();
  const L = this.dispPack(enc), bytes = Math.min(L.words * 4, s.buf.size), seq = this.rseq = (this.rseq || 0) + 1, b = Object.assign({}, this.b);
  enc.copyBufferToBuffer(this.bPack, 0, s.buf, 0, bytes);
  this.dev.queue.submit([enc.finish()]);
  this.needRead = false; s.busy = true;
  s.buf.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
    if (!this.dead && seq > (this.outSeqDone || 0)) {
      const t0 = performance.now();
      this.outFrame = unpackLive(s.buf.getMappedRange(0, bytes), L, b); this.outN = L.nW; this.outSeqDone = seq; this.gen = (this.gen || 0) + 1;
      this.unpackMs = performance.now() - t0;
    }
    s.buf.unmap(); s.busy = false;
  }).catch(() => { s.busy = false; });
};
// the packed live view (see packLayout) as a frame: one copy into a buffer just big enough for what is there
function unpackLive(range, L, b) {
  const hdr = new Uint32Array(range, 0, 4), nW = L.nW, nS = Math.min(hdr[0], L.nS), nD = Math.min(hdr[1], L.nD);
  const sz = [nS * 4, nW * 6, nS * 6, nD * 6, nW, nW, nD], off = []; let o = 0;
  for (const z of sz) { off.push(o); o += Math.ceil(z / 4) * 4; }
  const ab = new ArrayBuffer(Math.max(o, 4)), src = new Uint8Array(range);
  const cp = (k, from) => { if (sz[k]) new Uint8Array(ab, off[k], sz[k]).set(src.subarray(from, from + sz[k])); };
  cp(0, L.oSk * 4); cp(1, L.oWp * 4); cp(2, L.oSp * 4); cp(3, L.oDp * 4); cp(4, L.oWs * 4); cp(5, L.oWf * 4); cp(6, L.oDs * 4);
  const fr = { n: nW, pos: new Uint16Array(ab, off[1], nW * 3), spd: new Uint8Array(ab, off[4], nW), fm: new Uint8Array(ab, off[5], nW), b, bytes: ab.byteLength };
  if (nS) { fr.sp = { n: nS, pos: new Uint16Array(ab, off[2], nS * 3), pk: new Uint32Array(ab, off[0], nS), alive: nS }; fr.sb = L.sb; }   // whitewater across the whitewater area
  if (nD) fr.dp = { n: nD, pos: new Uint16Array(ab, off[3], nD * 3), spd: new Uint8Array(ab, off[6], nD) };
  return fr;
}
// a restart puts every particle id back to its slot number, so the ids stay a clean 0..N-1
FlipSim.prototype.clear = function () {
  GpuSim.prototype.clear.call(this); this.outFrame = null;
  this.tm = 0;   // time since the start: gusts replay the same after a reset, and the first moments count as settling
  this.nbInit = 1; this.nbFills = []; this.nbFillVols = [];   // narrow band: the depth field starts again from the starting water (or air)
  if (this.sprayCap) { const enc = this.dev.createCommandEncoder(); enc.clearBuffer(this.bSPos); enc.clearBuffer(this.bSctl); this.dev.queue.submit([enc.finish()]); }
  if (this.airDims) { const enc = this.dev.createCommandEncoder(); enc.clearBuffer(this.bAir); this.dev.queue.submit([enc.finish()]); }
  this.dripSig = '';   // drip samples come back dry
  if (this.sortedEver) { const M = this.MAXN, ids = new Uint32Array(M); for (let k = 0; k < M; k++) ids[k] = k; this.dev.queue.writeBuffer(this.bPid, 0, ids); this.sortedEver = false; }
};

