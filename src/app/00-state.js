  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const PRESET = {
    gpu: { liveD: 0.06, cap: 60000, iters: 3, capMax: 250000, dMin: 0.03, bk: { d: 0.04, sub: 3, iters: 3, maxN: 400000 }, bkMax: 1500000, bkDMin: 0.02 },
    flip: { liveD: 0.04, cap: 120000, iters: 30, capMax: 4000000, dMin: 0.01, bk: { d: 0.025, sub: 2, iters: 60, maxN: 1000000 }, bkMax: 3000000, bkDMin: 0.012 },
    cpu: { liveD: 0.12, cap: 6000, iters: 2, capMax: 14000, dMin: 0.07, bk: { d: 0.06, sub: 3, iters: 3, maxN: 80000 }, bkMax: 200000, bkDMin: 0.03 }
  };
  const S = {
    playing: false, fastAir: false, sortP: true, p2gWin: false, ballistic: true, settle: false, mg: true, sep: 10, xfer: 'apic', det: { cx: 0.5, cy: 0.5, cz: 0.5, sx: 0.4, sy: 1, sz: 0.4, k: 2, pull: 0.15 }, colMax: 100, dragSpeed: 20, vmaxW: 50, subMin: 1, subMax: 16, scale: 1, tear: 0.5, sprOn: true, sprAmt: 2, sprMin: 2.5, sprLife: 1.2, sprMist: 0.3, sprDrag: 1, mistDrag: 5, sprCap: 600000, streak: 0.02, wwFoamLife: 8, wwRise: 0.4, wwCrest: 1, wwImpact: 0.25, wwSpin: 0.5, wwEdge: 70, wwErode: 0.25, wwLand: 1, wwTrail: 1, wwArea: 2, wwAreaUp: 2, airOn: true, airCouple: 3, airDecay: 0.6, dripOn: true, dripRate: 2, dripDry: 3, sprDetail: 4, gizmo: false, snapV: false, snapOn: false, snapTo: 'vertex', orient: 'global', colorBy: 'speed', nbLook: false, ortho: false, lcOn: true, lcBudget: 2048, lcPlay: false, lcT: 0, g: 9.8, iters: 2, visc: 0.04, cap: 6000, liveD: 0.12, psize: 0.85, vmax: 5,
    frame: 0, drag: 'floor', bg: 'grey', shift: false, rec: false, ms: 0,
    tab: 'live', fills: [], events: [], engine: 'cpu', gpu: null, flip: 0.95,
    dom: { w: 3, h: 2.6, d: 3 }, min: { x: -1.5, y: 0, z: -1.5 }, org: { x: 0, y: 0, z: 0 }, simOrg: { x: 0, y: 0, z: 0 },
    open: { x0: false, x1: false, y0: false, y1: false, z0: false, z1: false },
    wind: { speed: 0, az: 0, up: 0 }, airDrag: 0.3, cellRatio: 2, detail: 0, liteRun: true, pbQ: 'smooth', pbLvl: 0, hideIn: true, surface: false, surfSmooth: 1, surfAniso: true, surfNrf: false, gpuKeepMB: 2048, gust: 1.0, foamSens: 1.0, foam: 0.8, foamTau: 1.2, handles: true,
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
  const NB_FULL = 10;   // a band this deep or more means particles all the way down: no grid-only deep water
  function nbCfg() { return nbActive() ? { on: true, band: S.nbBand >= NB_FULL ? 1e4 : S.nbBand } : null; }
  const rawBuf = new Float32Array(1500000 * 4 + 4);   // the GPU readback lands here first
  let lastGen = -1, lastK = -1, lastCount = 0, lastAlive = 0;
