// WebGPU FLIP / PIC fluid solver on a sparse MAC grid.
// Particles carry the velocity, the grid enforces incompressibility. One step:
//   find which 8x8x8 blocks of the grid are near particles and give them storage, clear, particle to grid (atomic fixed point),
//   classify cells, normalise and add gravity, divergence, red black SOR pressure solve (warm started), project,
//   grid to particle (FLIP blend), advect and collide.
// Only blocks within two cells of a particle exist, so memory and grid work follow the water, not the size of the box.
// Colliders are voxelised into solid cells (cached until they move) and carry their own velocity into the pressure solve.
function flipWGSL() {
  return /* wgsl */ `
struct Params {
  n: u32, nx: u32, ny: u32, nz: u32, ncols: u32, open: u32, F: u32, ncell: u32,
  dt: f32, h: f32, ih: f32, gravity: f32, flip: f32, rest: f32, comp: f32, omega: f32,
  x0: f32, y0: f32, z0: f32, vmax: f32, margin: f32, scale: f32, x1: f32, y1: f32,
  z1: f32, q0: f32, q1: f32, q2: f32, q3: f32, q4: f32, q5: f32, q6: f32,
  q7: f32, q8: f32, q9: f32, q10: f32, q11: f32, q12: f32,
  lcap: u32, tx: u32, ty: u32, tz: u32, scap: u32,
  sheetMin: f32, sprRate: f32, sprMin: f32, sprLife: f32, mistFrac: f32, sprDrag: f32, mistDrag: f32, vs: f32,
  smax: u32, sdOff: u32, sdMax: u32, seed: u32,
  nb: u32, band: f32, ocean: u32, nwave: u32, otime: f32, olevel: f32, olayer: f32, opad: f32,
  oy0: f32, nbInit: u32, nfill: u32, odepth: f32, nfv: u32,
  wwFoamLife: f32, wwRise: f32, wwCrest: f32, wwImpact: f32,
  airOn: u32, airCouple: f32, airDecay: f32, airH: f32,
  aNx: u32, aNy: u32, aNz: u32, ndrip: u32,
  dripRate: f32, dripDry: f32, airBlur: f32, wwPad: f32,
  fills: array<vec4<f32>, 16>,
  waves: array<vec4<f32>, 64>,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
// Face data, three faces per cell (its lower x, y and z faces), two numbers per face. During particle to grid they hold the summed
// velocity and weight (fixed point); from normalising on they hold the new velocity (accV) and the old velocity (accW) as float bits.
@group(0) @binding(3) var<storage, read_write> accV: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> accW: array<atomic<i32>>;
fn gvR(f: u32) -> f32 { return bitcast<f32>(atomicLoad(&accV[f])); }
fn gvW(f: u32, v: f32) { atomicStore(&accV[f], bitcast<i32>(v)); }
fn gv0R(f: u32) -> f32 { return bitcast<f32>(atomicLoad(&accW[f])); }
fn gv0W(f: u32, v: f32) { atomicStore(&accW[f], bitcast<i32>(v)); }
@group(0) @binding(6) var<storage, read_write> cnt: array<atomic<i32>>;
@group(0) @binding(7) var<storage, read_write> ctype: array<u32>;     // low 8 bits cell type, upper bits cached collider index + 1
@group(0) @binding(8) var<storage, read_write> pres: array<f32>;
@group(0) @binding(9) var<storage, read_write> rhs: array<f32>;
@group(0) @binding(10) var<storage, read> cols: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> sdf: array<f32>;
// counters: 0,1 red and black fluid cells, 2 top of the free block stack, 3 blocks to allocate, 4 blocks in use, 5 blocks that did not fit,
// 6 fastest particle speed (float bits; positive floats sort the same as their bits)
@group(0) @binding(12) var<storage, read_write> ctl: array<atomic<u32>>;
@group(0) @binding(13) var<storage, read_write> lst: array<u32>;
@group(0) @binding(14) var<storage, read_write> dargs: array<u32>;
@group(0) @binding(15) var<storage, read_write> disp: array<vec4<f32>>;
@group(0) @binding(16) var<storage, read_write> tmap: array<u32>;       // block of the box -> storage slot, or NONE
@group(0) @binding(17) var<storage, read_write> need: array<atomic<u32>>;
@group(0) @binding(18) var<storage, read_write> slotList: array<u32>;   // slots in use this step
@group(0) @binding(19) var<storage, read_write> slotTile: array<u32>;   // slot -> block of the box
@group(0) @binding(20) var<storage, read_write> fstack: array<u32>;     // free slots
@group(0) @binding(21) var<storage, read_write> newList: array<u32>;    // pairs: block, slot it got (or NONE)
@group(0) @binding(22) var<storage, read_write> sortCnt: array<atomic<u32>>;
@group(0) @binding(23) var<storage, read_write> tpos: array<vec4<f32>>;
@group(0) @binding(24) var<storage, read_write> tvel: array<vec4<f32>>;
@group(0) @binding(25) var<storage, read> gro: array<u32>;
@group(0) @binding(26) var<storage, read_write> pid: array<u32>;    // each particle's fixed id, which the sort carries along
@group(0) @binding(27) var<storage, read_write> tpid: array<u32>;
// spray and mist: their own points, thrown off fast water near the surface; they fly with gravity and air drag and never push the water
@group(0) @binding(28) var<storage, read_write> sPos: array<vec4<f32>>;   // xyz, seconds of life left
@group(0) @binding(29) var<storage, read_write> sVel: array<vec4<f32>>;   // velocity, kind (0 spray, 1 mist, 2 foam, 3 bubble)
@group(0) @binding(30) var<storage, read_write> sctl: array<atomic<u32>>;
@group(0) @binding(31) var<storage, read_write> velG: array<f32>;
// air field: a coarse grid of air velocity that the water, the spray and moving objects drag along; spray and mist drift with it
@group(0) @binding(32) var<storage, read_write> air: array<vec4<f32>>;
@group(0) @binding(33) var<storage, read_write> sAux: array<vec4<f32>>;      // per whitewater point: water velocity there (xyz), how wet (w)
@group(0) @binding(34) var<storage, read_write> airAcc: array<atomic<i32>>;  // per air cell: momentum and weight pushed in this step (fixed point)
@group(0) @binding(35) var<storage, read_write> air2: array<vec4<f32>>;
@group(0) @binding(36) var<storage, read_write> drip: array<vec4<f32>>;
// the live view packed the way cache frames are stored (see packDisp): 16-bit positions across the box, a speed byte and a white-water byte
struct PackU { nW: u32, nS: u32, nD: u32, wFromPos: u32, srcS: u32, srcD: u32, oWp: u32, oWs: u32, oWf: u32, oSp: u32, oSk: u32, oDp: u32, oDs: u32, pad0: u32, pad1: u32, pad2: u32,
  x0: f32, y0: f32, z0: f32, kx: f32, ky: f32, kz: f32, pad3: f32, pad4: f32 };
@group(0) @binding(37) var<storage, read_write> packOut: array<u32>;
@group(0) @binding(38) var<uniform> PK: PackU;      // per drip sample: (local position, collider), (local normal, wetness)   // the grid velocity kept from the last step (narrow band)
${SDF_WGSL}

const DEADY: f32 = -1.0e5;
const NONE: u32 = 0xffffffffu;
fn gid1(g: vec3<u32>) -> u32 { return g.x + g.y * 16776960u; }
fn ntiles() -> u32 { return P.tx * P.ty * P.tz; }
fn tileOf(i: i32, j: i32, k: i32) -> u32 { return u32(i >> 3u) + P.tx * (u32(j >> 3u) + P.ty * u32(k >> 3u)); }
// storage index of cell (i, j, k). Blocks without storage map to slot 0, a spare slot that is cleared every step and never read for real.
fn cellIdx(i: i32, j: i32, k: i32) -> u32 {
  let s = tmap[tileOf(i, j, k)];
  return select(s, 0u, s == NONE) * 512u + u32(i & 7) + 8u * (u32(j & 7) + 8u * u32(k & 7));
}
fn faceIndex(axis: u32, i: i32, j: i32, k: i32) -> u32 {
  let nx = i32(P.nx); let ny = i32(P.ny); let nz = i32(P.nz);
  if (axis == 0u) { return cellIdx(clamp(i, 0, nx), clamp(j, 0, ny - 1), clamp(k, 0, nz - 1)) * 3u; }
  if (axis == 1u) { return cellIdx(clamp(i, 0, nx - 1), clamp(j, 0, ny), clamp(k, 0, nz - 1)) * 3u + 1u; }
  return cellIdx(clamp(i, 0, nx - 1), clamp(j, 0, ny - 1), clamp(k, 0, nz)) * 3u + 2u;
}
fn slotCoord(s: u32, local: u32) -> vec3<i32> {
  let t = slotTile[s]; let tt = t / P.tx;
  return vec3<i32>(i32((t % P.tx) * 8u + (local & 7u)), i32((tt % P.ty) * 8u + ((local >> 3u) & 7u)), i32((tt / P.ty) * 8u + (local >> 6u)));
}
// active cell number t (0 .. blocks in use x 512) -> storage index and position
struct AC { c: u32, p: vec3<i32>, ok: bool };
fn acell(t: u32) -> AC {
  var r: AC;
  r.ok = t < atomicLoad(&ctl[4]) * 512u;
  if (!r.ok) { return r; }
  let s = slotList[t >> 9u]; let local = t & 511u;
  r.c = s * 512u + local; r.p = slotCoord(s, local);
  return r;
}
fn ctypeOf(i: i32, j: i32, k: i32) -> u32 {
  if (i < 0) { return select(2u, 0u, (P.open & 1u) != 0u); }
  if (i >= i32(P.nx)) { return select(2u, 0u, (P.open & 2u) != 0u); }
  if (j < 0) { return select(2u, 0u, (P.open & 4u) != 0u); }
  if (j >= i32(P.ny)) { return select(2u, 0u, (P.open & 8u) != 0u); }
  if (k < 0) { return select(2u, 0u, (P.open & 16u) != 0u); }
  if (k >= i32(P.nz)) { return select(2u, 0u, (P.open & 32u) != 0u); }
  return ctype[cellIdx(i, j, k)] & 0xffu;
}
// cheap test: is p inside the collider's distance grid, widened by one cell? Far from it the distance is certainly above the margin.
fn colNear(k: u32, p: vec3<f32>) -> bool {
  if (P.q10 > 0.5) { return true; }
  let b = cols[k * 8u + 1u];
  let d = p - cols[k * 8u + 5u].xyz;
  let lp = vec3<f32>(dot(cols[k * 8u + 2u].xyz, d), dot(cols[k * 8u + 3u].xyz, d), dot(cols[k * 8u + 4u].xyz, d));
  let g = (lp - b.xyz) / b.w;
  let dims = cols[k * 8u].yzw;
  return all(g > vec3<f32>(-1.0 - P.q0 / b.w)) && all(g < dims + vec3<f32>(P.q0 / b.w));
}
fn colAt(p: vec3<f32>) -> i32 {
  for (var k = 0u; k < P.ncols; k++) { if (colNear(k, p) && sdfEval(k, p).x < P.q0) { return i32(k); } }
  return -1;
}
fn cellCenter(i: i32, j: i32, k: i32) -> vec3<f32> { return vec3<f32>(P.x0 + (f32(i) + 0.5) * P.h, P.y0 + (f32(j) + 0.5) * P.h, P.z0 + (f32(k) + 0.5) * P.h); }
fn colAtCell(i: i32, j: i32, k: i32) -> i32 {
  if (i < 0 || j < 0 || k < 0 || i >= i32(P.nx) || j >= i32(P.ny) || k >= i32(P.nz)) { return -1; }
  return i32((ctype[cellIdx(i, j, k)] >> 8u) & 0xffu) - 1;
}
fn particleCell(p: vec3<f32>) -> vec3<i32> {
  return clamp(vec3<i32>(floor((p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih)), vec3<i32>(0), vec3<i32>(i32(P.nx) - 1, i32(P.ny) - 1, i32(P.nz) - 1));
}
fn hasStorage(c: vec3<i32>) -> bool { return tmap[tileOf(c.x, c.y, c.z)] != NONE; }
// new and old grid velocity at p, in one pass over the 24 faces around it
struct VV { vn: vec3<f32>, vo: vec3<f32> };
fn sampleBoth(p: vec3<f32>) -> VV {
  var r: VV;
  for (var axis = 0u; axis < 3u; axis++) {
    var g = (p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih;
    if (axis == 0u) { g.y -= 0.5; g.z -= 0.5; } else if (axis == 1u) { g.x -= 0.5; g.z -= 0.5; } else { g.x -= 0.5; g.y -= 0.5; }
    let f0 = floor(g); let fr = g - f0; let i0 = vec3<i32>(f0);
    var sn = 0.0; var so = 0.0;
    for (var c = 0u; c < 8u; c++) {
      let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
      let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
      let f = faceIndex(axis, i0.x + dx, i0.y + dy, i0.z + dz);
      sn += w * gvR(f); so += w * gv0R(f);
    }
    r.vn[axis] = sn; r.vo[axis] = so;
  }
  return r;
}

// ---- narrow band and ocean helpers ----
// Narrow band: particles live only in a band of cells under the surface. A depth field (phi, in cells, negative in water) is kept
// per cell in the top 16 bits of ctype; deep water below the band has no particles and moves with the grid velocity, which is kept
// from step to step in velG.
fn colBits(c: u32) -> u32 { return (ctype[c] >> 8u) & 0xffu; }
fn phiOf(c: u32) -> f32 { return 8.0 - f32(ctype[c] >> 16u) / 4096.0; }
fn phiPut(c: u32, v: f32) { let q = u32(clamp(round((8.0 - v) * 4096.0), 0.0, 65535.0)); ctype[c] = (ctype[c] & 0xffffu) | (q << 16u); }
fn inDom(p: vec3<i32>) -> bool { return p.x >= 0 && p.y >= 0 && p.z >= 0 && p.x < i32(P.nx) && p.y < i32(P.ny) && p.z < i32(P.nz); }
fn phiCell(p: vec3<i32>) -> f32 { if (!inDom(p)) { return 8.0; } return phiOf(cellIdx(p.x, p.y, p.z)); }
fn facePos(p: vec3<i32>, axis: u32) -> vec3<f32> {
  return vec3<f32>(P.x0 + (f32(p.x) + select(0.5, 0.0, axis == 0u)) * P.h, P.y0 + (f32(p.y) + select(0.5, 0.0, axis == 1u)) * P.h, P.z0 + (f32(p.z) + select(0.5, 0.0, axis == 2u)) * P.h);
}
// depth at a point, from the cell centres around it; cells inside colliders do not count
fn phiSample(x: vec3<f32>) -> f32 {
  let g = (x - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih - vec3<f32>(0.5);
  let gc = clamp(g, vec3<f32>(0.0), vec3<f32>(f32(P.nx) - 1.001, f32(P.ny) - 1.001, f32(P.nz) - 1.001));
  let f0 = floor(gc); let fr = gc - f0; let i0 = vec3<i32>(f0);
  var s = 0.0; var ws = 0.0;
  for (var c = 0u; c < 8u; c++) {
    let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
    let ci = cellIdx(i0.x + dx, i0.y + dy, i0.z + dz);
    if (colBits(ci) != 0u || w <= 0.0) { continue; }
    s += w * phiOf(ci); ws += w;
  }
  if (ws < 1.0e-4) { return 0.5; }
  return s / ws;
}
// the kept grid velocity at a point (one component, or all three)
fn velGAxis(x: vec3<f32>, axis: u32) -> f32 {
  var g = (x - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih;
  if (axis == 0u) { g.y -= 0.5; g.z -= 0.5; } else if (axis == 1u) { g.x -= 0.5; g.z -= 0.5; } else { g.x -= 0.5; g.y -= 0.5; }
  let f0 = floor(g); let fr = g - f0; let i0 = vec3<i32>(f0);
  var s = 0.0;
  for (var c = 0u; c < 8u; c++) {
    let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
    s += w * velG[faceIndex(axis, i0.x + dx, i0.y + dy, i0.z + dz)];
  }
  return s;
}
fn velGVec(x: vec3<f32>) -> vec3<f32> { return vec3<f32>(velGAxis(x, 0u), velGAxis(x, 1u), velGAxis(x, 2u)); }
// calm water moves less than about a seventh of a cell in a 60th of a second. Narrow band only trims, refills and fills in water that is calm;
// fast water (impacts, plunges, splashes) is left to the particles, exactly as in full FLIP.
fn calmV(v: vec3<f32>) -> bool { return length(v) < 9.0 * P.h; }
// ocean: a sum of linear (Airy) waves. waves[2k] = (kx, kz, amplitude, angular frequency), waves[2k+1] = (phase, wavenumber, 0, 0)
fn oceanEta(xz: vec2<f32>) -> f32 {
  var e = 0.0;
  for (var k = 0u; k < P.nwave; k++) { let A = P.waves[k * 2u]; let B = P.waves[k * 2u + 1u]; e += A.z * cos(A.x * xz.x + A.y * xz.y - A.w * P.otime + B.x); }
  return P.olevel + e;
}
// water velocity under the waves on a floor at depth odepth; the height is stretched so a crest gets the surface value
fn oceanVel(p: vec3<f32>) -> vec3<f32> {
  let D = max(P.odepth, 1.0e-3); let eta = oceanEta(p.xz);
  let ys = clamp((p.y - P.oy0) * D / max(D + eta - P.olevel, 0.1 * D), 0.0, D);
  var v = vec3<f32>(0.0);
  for (var k = 0u; k < P.nwave; k++) {
    let A = P.waves[k * 2u]; let B = P.waves[k * 2u + 1u]; let kk = max(B.y, 1.0e-4);
    let th = A.x * p.x + A.y * p.z - A.w * P.otime + B.x;
    let e1 = exp(kk * (ys - D)); let e2 = exp(-kk * (ys + D)); let dn = max(1.0 - exp(-2.0 * kk * D), 1.0e-4);
    let aw = A.z * A.w; let hc = aw * (e1 + e2) / dn * cos(th) / kk;
    v += vec3<f32>(hc * A.x, aw * (e1 - e2) / dn * sin(th), hc * A.y);
  }
  return v;
}
// 1 at the side walls, 0 at the boundary width in from them. Above 0.5 the ocean is prescribed (a moving wall), below it particles are only nudged.
fn layerW(p: vec3<f32>) -> f32 {
  if (P.ocean == 0u) { return 0.0; }
  let dw = min(min(p.x - P.x0, P.x1 - p.x), min(p.z - P.z0, P.z1 - p.z));
  return clamp(1.0 - dw / max(P.olayer, 1.0e-4), 0.0, 1.0);
}
// signed distance (in cells) to the starting water: boxes, spheres, water meshes and the ocean
fn fillPhi(x: vec3<f32>) -> f32 {
  var d = 1.0e9;
  for (var k = 0u; k < P.nfill; k++) {
    let A = P.fills[k * 2u]; let B = P.fills[k * 2u + 1u];
    if (A.x < 1.5) { let q = max(A.yzw - x, x - B.xyz); d = min(d, length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0)); }
    else { d = min(d, length(x - A.yzw) - B.x); }
  }
  for (var k = P.ncols; k < P.ncols + P.nfv; k++) { d = min(d, sdfEval(k, x).x); }
  if (P.ocean != 0u) { d = min(d, x.y - oceanEta(x.xz)); }
  return d * P.ih;
}
fn markAround(cc: vec3<i32>) {
  let lo = max(cc - vec3<i32>(2), vec3<i32>(0)) >> vec3<u32>(3u);
  let hi = min(cc + vec3<i32>(2), vec3<i32>(i32(P.tx) * 8 - 1, i32(P.ty) * 8 - 1, i32(P.tz) * 8 - 1)) >> vec3<u32>(3u);
  for (var tk = lo.z; tk <= hi.z; tk++) { for (var tj = lo.y; tj <= hi.y; tj++) { for (var ti = lo.x; ti <= hi.x; ti++) {
    let t = u32(ti) + P.tx * (u32(tj) + P.ty * u32(tk));
    if (atomicLoad(&need[t]) == 0u) { atomicStore(&need[t], 1u); }
  } } }
}

// ---- which blocks need storage ----
@compute @workgroup_size(1)
fn tileReset() { atomicStore(&ctl[3], 0u); atomicStore(&ctl[4], 0u); atomicStore(&ctl[5], 0u); atomicStore(&ctl[6], 0u); }
@compute @workgroup_size(256)
fn tileNeedClear(@builtin(global_invocation_id) g: vec3<u32>) { let t = gid1(g); if (t < ntiles()) { atomicStore(&need[t], 0u); } }
// every block within two cells of a particle: enough for the particle's own faces and for every neighbour those faces look at
@compute @workgroup_size(256)
fn tileMark(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let q = pos[i]; if (q.y < DEADY) { return; }
  markAround(particleCell(q.xyz));
}
@compute @workgroup_size(256)
fn tileFree(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); if (t >= ntiles()) { return; }
  let nd = atomicLoad(&need[t]); let s = tmap[t];
  if (nd == 0u && s != NONE) { tmap[t] = NONE; let idx = atomicAdd(&ctl[2], 1u); fstack[idx] = s; }
  else if (nd != 0u && s == NONE) { let n = atomicAdd(&ctl[3], 1u); newList[n * 2u] = t; newList[n * 2u + 1u] = NONE; }
}
fn split(groups: u32, at: u32) { dargs[at] = min(groups, 65535u); dargs[at + 1u] = (groups + 65534u) / 65535u; dargs[at + 2u] = 1u; }
@compute @workgroup_size(1)
fn argsNew() { let n = atomicLoad(&ctl[3]); split((n + 255u) / 256u, 8u); split(n * 2u, 12u); }
@compute @workgroup_size(256)
fn tileAlloc(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = gid1(g); if (k >= atomicLoad(&ctl[3])) { return; }
  let old = atomicSub(&ctl[2], 1u);
  if (old >= 1u && old <= P.scap) {
    let s = fstack[old - 1u]; let t = newList[k * 2u];
    tmap[t] = s; slotTile[s] = t; newList[k * 2u + 1u] = s;
  } else { atomicAdd(&ctl[5], 1u); }
}
@compute @workgroup_size(1)
fn tileFix() { if (atomicLoad(&ctl[2]) > P.scap) { atomicStore(&ctl[2], 0u); } }
// a block that just got storage: no pressure yet, and look up which collider (if any) each cell is inside
@compute @workgroup_size(256)
fn initNew(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); if (t >= atomicLoad(&ctl[3]) * 512u) { return; }
  let s = newList[(t >> 9u) * 2u + 1u]; if (s == NONE) { return; }
  let local = t & 511u; let tl = newList[(t >> 9u) * 2u]; let tt = tl / P.tx;
  let p = vec3<i32>(i32((tl % P.tx) * 8u + (local & 7u)), i32((tt % P.ty) * 8u + ((local >> 3u) & 7u)), i32((tt / P.ty) * 8u + (local >> 6u)));
  let c = s * 512u + local;
  pres[c] = 0.0;
  ctype[c] = u32(colAt(cellCenter(p.x, p.y, p.z)) + 1) << 8u;   // depth bits 0: air
  velG[c * 3u] = 0.0; velG[c * 3u + 1u] = 0.0; velG[c * 3u + 2u] = 0.0;
}
@compute @workgroup_size(256)
fn slotListBuild(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); if (t >= ntiles()) { return; }
  let s = tmap[t]; if (s == NONE) { return; }
  let idx = atomicAdd(&ctl[4], 1u); slotList[idx] = s;
}
@compute @workgroup_size(1)
fn argsSlots() { let sc = atomicLoad(&ctl[4]); split(sc * 2u, 16u); split((sc + 1u) * 2u, 20u); }
@compute @workgroup_size(256)
fn growFree(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); if (t >= gro[1]) { return; }
  let idx = atomicAdd(&ctl[2], 1u); fstack[idx] = gro[0] + t;
}

// ---- optional particle sort ----
// groups particles that are near each other in memory, so neighbouring threads read the same grid cells.
// The key is the 4x4x4 cell block hashed into 65536 buckets (a counting sort). Results do not depend on particle order.
fn sortKey(i: u32) -> u32 {
  let q = pos[i];
  if (q.y < DEADY) { return 0u; }
  let c = vec3<u32>(particleCell(q.xyz)) >> vec3<u32>(2u);
  let h = (c.x * 73856093u) ^ (c.y * 19349663u) ^ (c.z * 83492791u);
  return (h ^ (h >> 13u)) & 65535u;
}
@compute @workgroup_size(256)
fn sortClear(@builtin(global_invocation_id) g: vec3<u32>) { let t = gid1(g); if (t < 65536u) { atomicStore(&sortCnt[t], 0u); } }
@compute @workgroup_size(256)
fn sortHist(@builtin(global_invocation_id) g: vec3<u32>) { let i = gid1(g); if (i >= P.n) { return; } atomicAdd(&sortCnt[sortKey(i)], 1u); }
var<workgroup> sortPart: array<u32, 256>;
@compute @workgroup_size(256)
fn sortScan(@builtin(local_invocation_id) l: vec3<u32>) {
  let t = l.x; let base = t * 256u;
  var s = 0u;
  for (var q = 0u; q < 256u; q++) { s += atomicLoad(&sortCnt[base + q]); }
  sortPart[t] = s;
  workgroupBarrier();
  if (t == 0u) { var run = 0u; for (var q = 0u; q < 256u; q++) { let v = sortPart[q]; sortPart[q] = run; run += v; } }
  workgroupBarrier();
  var run = sortPart[t];
  for (var q = 0u; q < 256u; q++) { let v = atomicLoad(&sortCnt[base + q]); atomicStore(&sortCnt[base + q], run); run += v; }
}
@compute @workgroup_size(256)
fn sortScatter(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let d = atomicAdd(&sortCnt[sortKey(i)], 1u);
  tpos[d] = pos[i]; tvel[d] = vel[i]; tpid[d] = pid[i];
}
@compute @workgroup_size(256)
fn sortCopy(@builtin(global_invocation_id) g: vec3<u32>) { let i = gid1(g); if (i >= P.n) { return; } pos[i] = tpos[i]; vel[i] = tvel[i]; pid[i] = tpid[i]; }
// back into id order for saving, so frame after frame the same slot is the same particle
@compute @workgroup_size(256)
fn unsort(@builtin(global_invocation_id) g: vec3<u32>) { let i = gid1(g); if (i >= P.n) { return; } tpos[pid[i]] = pos[i]; }

// ---- the solver ----
// clears every block in use plus the spare slot 0
@compute @workgroup_size(256)
fn clearSlots(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); let sc = atomicLoad(&ctl[4]);
  if (t >= (sc + 1u) * 512u) { return; }
  let blk = t >> 9u;
  var s = 0u; if (blk < sc) { s = slotList[blk]; }
  let c = s * 512u + (t & 511u);
  atomicStore(&cnt[c], 0);
  for (var a = 0u; a < 3u; a++) { atomicStore(&accV[c * 3u + a], 0); atomicStore(&accW[c * 3u + a], 0); }
  if (s == 0u) { rhs[c] = 8.0; }   // the spare slot reads as air in the narrow band depth passes
}
@compute @workgroup_size(256)
fn p2g(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let p = pos[i].xyz;
  if (pos[i].y < DEADY) { return; }
  let cc = particleCell(p);
  if (!hasStorage(cc)) { return; }   // only when the block pool is full; the pool grows on the next steps
  let v = vel[i].xyz;
  atomicMax(&ctl[6], bitcast<u32>(length(v)));
  for (var axis = 0u; axis < 3u; axis++) {
    var q = (p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih;
    if (axis == 0u) { q.y -= 0.5; q.z -= 0.5; } else if (axis == 1u) { q.x -= 0.5; q.z -= 0.5; } else { q.x -= 0.5; q.y -= 0.5; }
    let f0 = floor(q); let fr = q - f0; let i0 = vec3<i32>(f0);
    var vc = v.x; if (axis == 1u) { vc = v.y; } else if (axis == 2u) { vc = v.z; }
    for (var c = 0u; c < 8u; c++) {
      let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
      let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
      if (w <= 0.0) { continue; }
      let idx = faceIndex(axis, i0.x + dx, i0.y + dy, i0.z + dz);
      atomicAdd(&accV[idx], i32(round(w * vc * P.scale)));
      atomicAdd(&accW[idx], i32(round(w * P.scale)));
    }
  }
  atomicAdd(&cnt[cellIdx(cc.x, cc.y, cc.z)], 1);
}
@compute @workgroup_size(256)
fn solidBuild(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  ctype[a.c] = (ctype[a.c] & 0xffff00ffu) | (u32(colAt(cellCenter(a.p.x, a.p.y, a.p.z)) + 1) << 8u);
}
@compute @workgroup_size(256)
fn classify(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  let c = a.c;
  var ty = 0u;
  let sb = ctype[c] & 0xffffff00u;
  let n = atomicLoad(&cnt[c]);
  let cx = cellCenter(a.p.x, a.p.y, a.p.z);
  if (!inDom(a.p)) { ty = 0u; }   // past the far walls: storage only, never fluid
  else if ((sb & 0xff00u) != 0u) { ty = 2u; }
  else if (P.ocean != 0u && layerW(cx) >= 0.5) { ty = select(0u, 2u, cx.y < oceanEta(cx.xz)); }   // the ocean's boundary: a wall moving with the waves, under their surface
  else if (P.nb != 0u && phiOf(c) < -1.0 && (phiOf(c) < -P.band || calmV(velGVec(cx)))) { ty = 1u; }   // water by depth: deep water has no particles
  else if (n > 0) {
    ty = 1u;
    // sheet tearing: a sparse cell with no solidly full neighbour is a thin sheet or a drop, so it flies free instead of being held together
    if (f32(n) < P.sheetMin) {
      let dth = i32(ceil(0.6 * P.rest)); var dense = false;
      for (var q = 0u; q < 6u; q++) {
        var p = a.p;
        if (q == 0u) { p.x -= 1; } else if (q == 1u) { p.x += 1; } else if (q == 2u) { p.y -= 1; } else if (q == 3u) { p.y += 1; } else if (q == 4u) { p.z -= 1; } else { p.z += 1; }
        if (p.x < 0 || p.y < 0 || p.z < 0 || p.x >= i32(P.nx) || p.y >= i32(P.ny) || p.z >= i32(P.nz)) { continue; }
        if (atomicLoad(&cnt[cellIdx(p.x, p.y, p.z)]) >= dth) { dense = true; }
      }
      if (!dense) { ty = 0u; }
    }
  }
  ctype[c] = ty | sb;
  if (ty != 1u) { pres[c] = 0.0; }
}
fn normBody(f: u32, axis: u32, at: vec3<i32>) {
  var lo = at; let hi = at;
  if (axis == 0u) { lo.x -= 1; } else if (axis == 1u) { lo.y -= 1; } else { lo.z -= 1; }
  let tl = ctypeOf(lo.x, lo.y, lo.z); let th = ctypeOf(hi.x, hi.y, hi.z);
  let ws = atomicLoad(&accW[f]); let vs = atomicLoad(&accV[f]);
  var v = select(0.0, f32(vs) / f32(max(ws, 1)), ws > 0);
  var old = v;
  if (axis == 1u) { v -= P.gravity * P.dt; }
  if (tl == 2u || th == 2u) {
    var sv = 0.0;
    var ci = -1;
    if (tl == 2u) { ci = colAtCell(lo.x, lo.y, lo.z); }
    if (ci < 0 && th == 2u) { ci = colAtCell(hi.x, hi.y, hi.z); }
    let fp = facePos(at, axis);
    if (ci >= 0) {
      let cv = colSurfVel(u32(ci), fp);
      sv = cv.x; if (axis == 1u) { sv = cv.y; } else if (axis == 2u) { sv = cv.z; }
    } else if (P.ocean != 0u && ((tl == 2u && inDom(lo)) || (th == 2u && inDom(hi)))) {
      let ov = oceanVel(fp);
      sv = ov.x; if (axis == 1u) { sv = ov.y; } else if (axis == 2u) { sv = ov.z; }
    }
    v = sv; old = sv;
  }
  gv0W(f, old); gvW(f, v);
}
// each active cell handles its three lower faces (faces past the edge of the box are never read)
@compute @workgroup_size(256)
fn normFaces(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  for (var ax = 0u; ax < 3u; ax++) { normBody(a.c * 3u + ax, ax, a.p); }
}
@compute @workgroup_size(256)
fn divergence(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  let c = a.c;
  if ((ctype[c] & 0xffu) != 1u) { rhs[c] = 0.0; return; }
  let i = a.p.x; let j = a.p.y; let k = a.p.z;
  let div = (gvR(faceIndex(0u, i + 1, j, k)) - gvR(faceIndex(0u, i, j, k)) + gvR(faceIndex(1u, i, j + 1, k)) - gvR(faceIndex(1u, i, j, k)) +
             gvR(faceIndex(2u, i, j, k + 1)) - gvR(faceIndex(2u, i, j, k))) * P.ih;
  // density correction: overfull cells push fluid out, and cells that are surrounded by fluid pull it back in when they are too sparse
  var interior = true;
  if (ctypeOf(i - 1, j, k) == 0u || ctypeOf(i + 1, j, k) == 0u || ctypeOf(i, j - 1, k) == 0u || ctypeOf(i, j + 1, k) == 0u || ctypeOf(i, j, k - 1) == 0u || ctypeOf(i, j, k + 1) == 0u) { interior = false; }
  let dens = f32(atomicLoad(&cnt[c])) / P.rest - 1.0;
  var tgt = P.comp * select(max(dens, 0.0), dens, interior);
  // narrow band: particle counts only steer the surface layer. Below it the band is refilled and trimmed instead, and pushing crowded
  // particles down would only feed them to the trimming (water slowly lost); deep water has no particles to count at all
  if (P.nb != 0u && phiOf(c) < -1.0) { tgt = 0.0; }   // deep water has no particles to count
  rhs[c] = (tgt - div) * P.h * P.h / P.dt;
}
fn relax(c: u32, color: u32) {
  let p = slotCoord(c >> 9u, c & 511u); let i = p.x; let j = p.y; let k = p.z;
  if (u32((i + j + k) & 1) != color) { return; }
  if ((ctype[c] & 0xffu) != 1u) { return; }
  var sum = 0.0; var nns = 0.0;
  for (var a = 0u; a < 6u; a++) {
    var q = vec3<i32>(i, j, k);
    if (a == 0u) { q.x -= 1; } else if (a == 1u) { q.x += 1; } else if (a == 2u) { q.y -= 1; } else if (a == 3u) { q.y += 1; } else if (a == 4u) { q.z -= 1; } else { q.z += 1; }
    let ty = ctypeOf(q.x, q.y, q.z);
    if (ty == 2u) { continue; }
    nns += 1.0;
    if (ty == 1u) { sum += pres[cellIdx(q.x, q.y, q.z)]; }
  }
  if (nns < 0.5) { pres[c] = 0.0; return; }
  let pg = (rhs[c] + sum) / nns;
  pres[c] = pres[c] + P.omega * (pg - pres[c]);
}
// every stride-th particle, packed together, so the live view only has to copy a few hundred thousand of them
@compute @workgroup_size(256)
fn subsample(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); let s = u32(P.q11);
  if (i * s >= P.n) { return; }
  disp[i] = pos[i * s];
}
// fluid cell lists, one per checkerboard colour: only cells that hold water are relaxed
@compute @workgroup_size(1)
fn listClear() { atomicStore(&ctl[0], 0u); atomicStore(&ctl[1], 0u); }
@compute @workgroup_size(256)
fn buildList(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  if ((ctype[a.c] & 0xffu) != 1u) { return; }
  let par = u32((a.p.x + a.p.y + a.p.z) & 1);
  let s = atomicAdd(&ctl[par], 1u);
  if (s < P.lcap) { lst[par * P.lcap + s] = a.c; }
}
@compute @workgroup_size(1)
fn listArgs() { split((min(atomicLoad(&ctl[0]), P.lcap) + 255u) / 256u, 0u); split((min(atomicLoad(&ctl[1]), P.lcap) + 255u) / 256u, 4u); }
@compute @workgroup_size(256)
fn rbRed(@builtin(global_invocation_id) g: vec3<u32>) { let t = gid1(g); if (t >= min(atomicLoad(&ctl[0]), P.lcap)) { return; } relax(lst[t], 0u); }
@compute @workgroup_size(256)
fn rbBlack(@builtin(global_invocation_id) g: vec3<u32>) { let t = gid1(g); if (t >= min(atomicLoad(&ctl[1]), P.lcap)) { return; } relax(lst[P.lcap + t], 1u); }
fn projBody(f: u32, axis: u32, at: vec3<i32>) {
  var lo = at; let hi = at;
  if (axis == 0u) { lo.x -= 1; } else if (axis == 1u) { lo.y -= 1; } else { lo.z -= 1; }
  let tl = ctypeOf(lo.x, lo.y, lo.z); let th = ctypeOf(hi.x, hi.y, hi.z);
  if (tl == 2u || th == 2u) { return; }
  if (tl != 1u && th != 1u) { return; }
  var pl = 0.0; var ph = 0.0;
  if (tl == 1u) { pl = pres[cellIdx(lo.x, lo.y, lo.z)]; }
  if (th == 1u) { ph = pres[cellIdx(hi.x, hi.y, hi.z)]; }
  gvW(f, gvR(f) - P.dt * P.ih * (ph - pl));
}
@compute @workgroup_size(256)
fn project(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  for (var ax = 0u; ax < 3u; ax++) { projBody(a.c * 3u + ax, ax, a.p); }
}
fn hash1(n0: u32) -> f32 {
  var x = n0; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return f32(x) * 2.3283064e-10;
}
// ---- whitewater (Houdini style): spray, mist, foam and bubbles in one pool of points that never push the water ----
// kind 0 spray, 1 mist, 2 foam, 3 bubble. Each step a point is classified by how deep in water it sits: spray that lands turns to foam,
// foam rides the surface and fades, foam pushed under turns to bubbles, bubbles rise and turn to foam at the surface.
// how much water is at a cell, 0 to 1: particles over the rest count; deep narrow-band water (it has no particles) counts as full
fn wetCell(c: vec3<i32>) -> f32 {
  if (!inDom(c) || !hasStorage(c)) { return 0.0; }
  let ci = cellIdx(c.x, c.y, c.z);
  if (P.nb != 0u && (ctype[ci] & 0xffu) == 1u && phiOf(ci) < -1.0) { return 1.0; }
  return min(f32(atomicLoad(&cnt[ci])) / P.rest, 1.0);
}
fn wetAt(p: vec3<f32>) -> f32 {
  let g = (p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih - vec3<f32>(0.5);
  let f0 = floor(g); let fr = g - f0; let i0 = vec3<i32>(f0);
  var s = 0.0;
  for (var c = 0u; c < 8u; c++) {
    let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
    if (w > 0.0) { s += w * wetCell(i0 + vec3<i32>(dx, dy, dz)); }
  }
  return s;
}
// air grid: cells of P.airH from the box's low corner, values at the cell centres
fn airIdx(c: vec3<i32>) -> u32 {
  let q = clamp(c, vec3<i32>(0), vec3<i32>(i32(P.aNx) - 1, i32(P.aNy) - 1, i32(P.aNz) - 1));
  return u32(q.x) + P.aNx * (u32(q.y) + P.aNy * u32(q.z));
}
fn airCell(p: vec3<f32>) -> vec3<i32> { return vec3<i32>(floor((p - vec3<f32>(P.x0, P.y0, P.z0)) / P.airH)); }
fn airAt(p: vec3<f32>) -> vec3<f32> {
  let g = (p - vec3<f32>(P.x0, P.y0, P.z0)) / P.airH - vec3<f32>(0.5);
  let f0 = floor(g); let fr = g - f0; let i0 = vec3<i32>(f0);
  var s = vec3<f32>(0.0);
  for (var c = 0u; c < 8u; c++) {
    let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
    s += w * air[airIdx(i0 + vec3<i32>(dx, dy, dz))].xyz;
  }
  return s;
}
fn airPush(p: vec3<f32>, v: vec3<f32>, w: f32) {
  let c = airIdx(airCell(p)) * 4u;
  atomicAdd(&airAcc[c], i32(v.x * w * 256.0)); atomicAdd(&airAcc[c + 1u], i32(v.y * w * 256.0)); atomicAdd(&airAcc[c + 2u], i32(v.z * w * 256.0));
  atomicAdd(&airAcc[c + 3u], i32(w * 256.0));
}
@compute @workgroup_size(256)
fn airClear(@builtin(global_invocation_id) g: vec3<u32>) {
  let c = gid1(g); if (c >= P.aNx * P.aNy * P.aNz) { return; }
  for (var k = 0u; k < 4u; k++) { atomicStore(&airAcc[c * 4u + k], 0); }
}
// water near the surface drags the air (water deep inside a body never touches it)
@compute @workgroup_size(256)
fn airSplatW(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let p = pos[i].xyz; if (pos[i].y < DEADY) { return; }
  let c = particleCell(p);
  if (hasStorage(c) && f32(atomicLoad(&cnt[cellIdx(c.x, c.y, c.z)])) > 0.85 * P.rest) { return; }
  airPush(p, vel[i].xyz, 1.0);
}
// flying spray drags it too, so mist trails behind a splash
@compute @workgroup_size(256)
fn airSplatS(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = gid1(g); if (j >= P.smax) { return; }
  let sp = sPos[j]; if (sp.w <= 0.0 || sVel[j].w > 1.5) { return; }
  airPush(sp.xyz, sVel[j].xyz, 0.25);
}
// each air cell: spreads a little to its neighbours, is pulled towards what pushed it, moves with an object it is inside, and settles back to the wind
@compute @workgroup_size(256)
fn airUpdate(@builtin(global_invocation_id) g: vec3<u32>) {
  let c = gid1(g); if (c >= P.aNx * P.aNy * P.aNz) { return; }
  let ci = vec3<i32>(i32(c % P.aNx), i32((c / P.aNx) % P.aNy), i32(c / (P.aNx * P.aNy)));
  var a = air[c].xyz;
  let nb = (air[airIdx(ci + vec3<i32>(1, 0, 0))].xyz + air[airIdx(ci - vec3<i32>(1, 0, 0))].xyz + air[airIdx(ci + vec3<i32>(0, 1, 0))].xyz +
            air[airIdx(ci - vec3<i32>(0, 1, 0))].xyz + air[airIdx(ci + vec3<i32>(0, 0, 1))].xyz + air[airIdx(ci - vec3<i32>(0, 0, 1))].xyz) / 6.0;
  a = mix(a, nb, P.airBlur);
  let w = f32(atomicLoad(&airAcc[c * 4u + 3u])) / 256.0;
  if (w > 0.0) {
    let vt = vec3<f32>(f32(atomicLoad(&airAcc[c * 4u])), f32(atomicLoad(&airAcc[c * 4u + 1u])), f32(atomicLoad(&airAcc[c * 4u + 2u]))) / (w * 256.0);
    a = mix(a, vt, 1.0 - exp(-P.airCouple * min(w, 8.0) * P.dt));
  }
  let x = vec3<f32>(P.x0, P.y0, P.z0) + (vec3<f32>(ci) + vec3<f32>(0.5)) * P.airH;
  for (var k = 0u; k < P.ncols; k++) {
    if (colNear(k, x) && sdfEval(k, x).x < 0.6 * P.airH) { a = colSurfVel(k, x); break; }
  }
  a = mix(a, vec3<f32>(P.q1, P.q2, P.q3), 1.0 - exp(-P.airDecay * P.dt));
  air2[c] = vec4<f32>(a, 0.0);
}
@compute @workgroup_size(256)
fn airCopy(@builtin(global_invocation_id) g: vec3<u32>) { let c = gid1(g); if (c >= P.aNx * P.aNy * P.aNz) { return; } air[c] = air2[c]; }
// how wet each whitewater point is and the water's velocity there (a separate pass keeps every kernel within 8 storage buffers)
@compute @workgroup_size(256)
fn wwSample(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = gid1(g); if (j >= P.smax) { return; }
  let sp = sPos[j]; if (sp.w <= 0.0) { return; }
  let p = sp.xyz; var vf = vec3<f32>(0.0);
  if (hasStorage(particleCell(p))) { vf = sampleBoth(p).vn; }
  sAux[j] = vec4<f32>(vf, wetAt(p));
}
// every water particle near the surface can throw off whitewater: fast exposed water (crests, sheets, splashes) and churning white water (impacts,
// breaking). Points made inside the water start as bubbles; the rest as spray or mist, and the next steps sort them by depth.
@compute @workgroup_size(256)
fn sprayEmit(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n || P.smax == 0u || P.sprRate <= 0.0) { return; }
  let q = pos[i]; if (q.y < DEADY) { return; }
  if (P.ocean != 0u && layerW(q.xyz) > 0.0) { return; }
  let v = vel[i].xyz; let foam = vel[i].w; let spd = length(v);
  let fast = clamp((spd * P.vs - P.sprMin) / (2.0 * P.sprMin), 0.0, 1.0);
  let bc = vec3<i32>(floor((q.xyz - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih - vec3<f32>(0.5)));
  var rho = 0.0;
  for (var dz = 0; dz <= 1; dz++) { for (var dy = 0; dy <= 1; dy++) { for (var dx = 0; dx <= 1; dx++) { rho += wetCell(bc + vec3<i32>(dx, dy, dz)); } } }
  rho = rho / 8.0;
  let crest = (1.0 - smoothstep(0.3, 0.75, rho)) * fast * (0.3 + 0.7 * foam);
  let churn = (1.0 - smoothstep(0.8, 1.0, rho)) * clamp((foam - 0.55) / 0.45, 0.0, 1.0) * smoothstep(0.5, 1.5, spd * P.vs);   // moving water only: settling at the start is not churn
  let e = (P.wwCrest * crest + P.wwImpact * churn) * smoothstep(0.1, 0.5, P.q8);   // none while the starting water settles
  if (e <= 0.0) { return; }
  let h0 = i * 747796405u + P.seed * 2891336453u;
  let k = min(u32(floor(P.sprRate * e * P.dt + hash1(h0))), 4u);
  for (var m = 0u; m < k; m++) {
    let hh = h0 ^ ((m + 1u) * 0x9E3779B9u);
    let z = hash1(hh + 1u) * 2.0 - 1.0; let a = hash1(hh + 2u) * 6.2831853; let s = sqrt(max(0.0, 1.0 - z * z));
    let dir = vec3<f32>(s * cos(a), s * sin(a), z);
    let under = rho > 0.7 && hash1(hh + 7u) < 0.7;
    let mist = !under && hash1(hh + 3u) < P.mistFrac * fast;
    var nv = v * (0.9 + 0.2 * hash1(hh + 4u)) + dir * spd * select(0.06, 0.2, mist);   // mostly the water's own velocity: a wide random spread looks like a sparkler
    var life = P.sprLife * (0.6 + 0.8 * hash1(hh + 5u)) * select(1.0, 1.6, mist);
    var kind = select(0.0, 1.0, mist);
    if (under) { nv = v + dir * spd * 0.05; life = P.wwFoamLife * (0.6 + 0.8 * hash1(hh + 5u)); kind = 3.0; }
    let slot = atomicAdd(&sctl[0], 1u) % P.smax;
    if (sPos[slot].w > 0.0) { continue; }   // never replace a living point: when the pool is full, new whitewater waits for room
    sPos[slot] = vec4<f32>(q.xyz + nv * P.dt + dir * P.h * 0.3 * hash1(hh + 6u), life);
    sVel[slot] = vec4<f32>(nv, kind);
  }
}
// moves every whitewater point by its kind: spray and mist fly with gravity and drag towards the air; foam follows the water's surface;
// bubbles are carried by the water and rise. They are gone when their time is up, when they hit an object or leave the box.
@compute @workgroup_size(256)
fn sprayStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = gid1(g); if (j >= P.smax) { return; }
  let sp = sPos[j]; if (sp.w <= 0.0) { return; }
  var v = sVel[j].xyz; let kw = sVel[j].w; var kind = u32(kw + 0.5);
  // the fraction part of the kind is how long the point has been this kind (0.4 = WWHOLD seconds or more). A point keeps its kind at least
  // that long, so it never flickers between kinds (and sizes) from one step to the next where the water is thin or broken up.
  var tk = (kw - f32(kind)) / 0.4 * WWHOLD; let settled = tk >= WWHOLD * 0.999; let k0 = kind;
  let aux = sAux[j]; let wet = aux.w; let vf = aux.xyz;
  var life = sp.w;
  let h0 = j * 2654435761u + P.seed * 974711u;
  if (kind == 0u && v.y < vf.y && wet > 0.55 && tk > 0.05) { kind = 2u; life = P.wwFoamLife * (0.6 + 0.8 * hash1(h0)); v = vf; }   // spray landing on water turns to foam
  else if (kind == 1u && wet > 0.55) { life = 0.0; }                                                                   // mist falling into water is gone
  else if (kind == 2u && wet > 0.97 && settled) { kind = 3u; }                                                         // foam pushed under: bubbles
  else if (kind == 2u && wet < 0.04 && settled) { kind = 0u; life = min(life, P.sprLife); }                            // foam that lost the surface falls as spray
  else if (kind == 3u && wet < 0.6 && settled) { kind = 2u; life = max(life, 0.5 * P.wwFoamLife); }                   // a bubble reaching the surface: foam
  if (kind != k0) { tk = 0.0; } else { tk = min(tk + P.dt, WWHOLD); }
  let p = sp.xyz;
  if (kind <= 1u) {
    let mist = kind == 1u;
    var gust = vec3<f32>(0.0);
    if (P.q7 > 0.0) {
      let gp = p * 0.55 * P.vs; let tt = P.q8 * 0.6;
      gust = vec3<f32>(vnz(gp + vec3<f32>(tt, 0.0, 0.0)), vnz(gp + vec3<f32>(17.3, tt, 4.1)), vnz(gp + vec3<f32>(5.7, 9.2, tt))) * 2.0 - vec3<f32>(1.0);
    }
    var base = vec3<f32>(P.q1, P.q2, P.q3); if (P.airOn != 0u) { base = airAt(p); }
    let airv = base + gust * P.q7 * select(1.0, 2.5, mist);
    v.y -= P.gravity * P.dt;
    v = v + (airv - v) * (1.0 - exp(-select(P.sprDrag, P.mistDrag, mist) * P.dt));
    life -= P.dt;
  } else if (kind == 2u) {
    let vy = vf.y + clamp((wet - 0.5) * 4.0, -1.0, 1.0) * P.h * 4.0;   // held at the surface: pushed up when under, pulled down when above
    v = mix(v, vec3<f32>(vf.x, vy, vf.z), 1.0 - exp(-10.0 * P.dt));
    life -= P.dt;
  } else {
    v = mix(v, vf + vec3<f32>(0.0, P.wwRise, 0.0), 1.0 - exp(-6.0 * P.dt));
    life -= 0.3 * P.dt;
  }
  let np = p + v * P.dt;
  if (np.x < P.x0 || np.x > P.x1 || np.y < P.y0 || np.y > P.y1 || np.z < P.z0 || np.z > P.z1) { life = 0.0; }
  else if (P.ncols > 0u && colAt(np) >= 0) { life = 0.0; }
  else if (P.ocean != 0u && kind >= 2u && layerW(np) > 0.6) { life = 0.0; }
  sPos[j] = vec4<f32>(np, life); sVel[j] = vec4<f32>(v, f32(kind) + 0.4 * tk / WWHOLD);
}
const WWHOLD: f32 = 0.2;
// packed for drawing: top bit marks whitewater, the next two bits the kind (00 spray, 10 mist, 01 foam, 11 bubble), 8 bits of speed in quarter
// units per second, then for spray and mist the direction (octahedral, 20 bits), for foam and bubbles how much of their life is left (10 bits)
fn packSpray(v: vec3<f32>, kind: u32, lifeFrac: f32) -> u32 {
  let s = length(v);
  var code = 0x80000000u | (min(u32(s * 4.0), 255u) << 21u);
  if (kind == 1u) { code = code | 0x40000000u; } else if (kind == 2u) { code = code | 0x20000000u; } else if (kind == 3u) { code = code | 0x60000000u; }
  if (kind >= 2u) { return code | u32(clamp(lifeFrac, 0.0, 1.0) * 1023.0); }
  var n = vec3<f32>(0.0, 1.0, 0.0); if (s > 1e-6) { n = v / s; }
  var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { p = (vec2<f32>(1.0) - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0)); }
  let u = u32(clamp(round((p.x * 0.5 + 0.5) * 1023.0), 0.0, 1023.0)); let w = u32(clamp(round((p.y * 0.5 + 0.5) * 1023.0), 0.0, 1023.0));
  return code | (w << 10u) | u;
}
// whitewater slots are handed out in order (a ring), so until the ring wraps only the first sctl[0] can be alive: work over just those
@compute @workgroup_size(1)
fn wwArgs() { split((min(atomicLoad(&sctl[0]), P.smax) + 255u) / 256u, 28u); }
// an even sample of the whitewater slots for the live view, written after the water points
@compute @workgroup_size(256)
// The sample takes every stride-th slot of those handed out so far (the same slots from frame to frame, so a point stays shown all its life);
// the living ones are packed together, counted in sctl[2] (cleared by dispBegin).
fn sprayDisp(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = gid1(g); if (k >= P.sdMax) { return; }
  let used = min(atomicLoad(&sctl[0]), P.smax); let stride = max(1u, (used + P.sdMax - 1u) / P.sdMax);
  let j = k * stride; if (j >= used || sPos[j].w <= 0.0) { return; }
  let o = P.sdOff + atomicAdd(&sctl[2], 1u); if (o >= arrayLength(&disp)) { return; }
  disp[o] = vec4<f32>(sPos[j].xyz, bitcast<f32>(packSpray(sVel[j].xyz, u32(sVel[j].w + 0.5), sPos[j].w / max(P.wwFoamLife, 0.01))));
}
@compute @workgroup_size(1)
fn dispBegin() { atomicStore(&sctl[2], 0u); }
// The live view as a cache frame: every thread packs four points of one part (water, whitewater or deep water). Positions are 16 bits
// across the box (three per point, so four points fill six words), water gets a speed byte (16ths, 255 = gone) and a white-water byte,
// whitewater its 32-bit code (0 = none), deep water a speed byte. Word 0 and 1 hold how many whitewater and deep points there are.
fn q16(p: vec3<f32>) -> vec3<u32> { return vec3<u32>(clamp(round((p - vec3<f32>(PK.x0, PK.y0, PK.z0)) * vec3<f32>(PK.kx, PK.ky, PK.kz)), vec3<f32>(0.0), vec3<f32>(65535.0))); }
fn put6(o: u32, q: array<vec3<u32>, 4>) {
  packOut[o] = q[0].x | (q[0].y << 16u); packOut[o + 1u] = q[0].z | (q[1].x << 16u); packOut[o + 2u] = q[1].y | (q[1].z << 16u);
  packOut[o + 3u] = q[2].x | (q[2].y << 16u); packOut[o + 4u] = q[2].z | (q[3].x << 16u); packOut[o + 5u] = q[3].y | (q[3].z << 16u);
}
@compute @workgroup_size(256)
fn packDisp(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g);
  let gW = (PK.nW + 3u) / 4u; let gS = (PK.nS + 3u) / 4u; let gD = (PK.nD + 3u) / 4u;
  let nS = min(atomicLoad(&sctl[2]), PK.nS); let nD = min(atomicLoad(&ctl[14]), PK.nD);
  if (t == 0u) { packOut[0] = nS; packOut[1] = nD; packOut[2] = 0u; packOut[3] = 0u; }
  var q: array<vec3<u32>, 4>; var b0 = 0u; var b1 = 0u;
  if (t < gW) {
    for (var m = 0u; m < 4u; m++) {
      let i = t * 4u + m; var v = vec4<f32>(0.0, -1.0e6, 0.0, 0.0);
      if (i < PK.nW) { if (PK.wFromPos != 0u) { v = pos[i]; } else { v = disp[i]; } }
      var s = 255u; var f = 0u; q[m] = vec3<u32>(0u);
      if (v.y > DEADY) { q[m] = q16(v.xyz); let lv = floor(v.w / 64.0); s = u32(clamp((v.w - lv * 64.0) * 16.0, 0.0, 191.0)); f = u32(clamp(lv, 0.0, 15.0)) * 17u; }
      b0 = b0 | (s << (8u * m)); b1 = b1 | (f << (8u * m));
    }
    put6(PK.oWp + t * 6u, q); packOut[PK.oWs + t] = b0; packOut[PK.oWf + t] = b1; return;
  }
  let ts = t - gW;
  if (ts < gS) {
    for (var m = 0u; m < 4u; m++) {
      let k = ts * 4u + m; var code = 0u; q[m] = vec3<u32>(0u);
      if (k < nS) { let v = disp[PK.srcS + k]; if (v.y > DEADY) { q[m] = q16(v.xyz); code = bitcast<u32>(v.w); } }
      packOut[PK.oSk + k] = code;
    }
    put6(PK.oSp + ts * 6u, q); return;
  }
  let td = ts - gS;
  if (td < gD) {
    for (var m = 0u; m < 4u; m++) {
      let k = td * 4u + m; var s = 255u; q[m] = vec3<u32>(0u);
      if (k < nD) { let v = disp[PK.srcD + k]; if (v.y > DEADY) { q[m] = q16(v.xyz); s = u32(clamp((v.w - 4096.0) * 16.0, 0.0, 191.0)); } }
      b0 = b0 | (s << (8u * m));
    }
    put6(PK.oDp + td * 6u, q); packOut[PK.oDs + td] = b0;
  }
}
// wet objects drip: points over each collider's surface stay wet while they are in water and dry over P.dripDry seconds once out;
// while drying they let go of drops (more from surfaces facing down), which fly as spray with the object's own velocity
@compute @workgroup_size(256)
fn dripStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = gid1(g); if (s >= P.ndrip) { return; }
  let a = drip[s * 2u]; let b = drip[s * 2u + 1u];
  let k = u32(a.w); if (k >= P.ncols) { return; }
  let r0 = cols[k * 8u + 2u].xyz; let r1 = cols[k * 8u + 3u].xyz; let r2 = cols[k * 8u + 4u].xyz;
  let wp = cols[k * 8u + 5u].xyz + r0 * a.x + r1 * a.y + r2 * a.z;
  let wn = normalize(r0 * b.x + r1 * b.y + r2 * b.z);
  let probe = wp + wn * P.h * 0.75;
  let here = wetAt(probe);
  if (here > 0.4) { drip[s * 2u + 1u].w = 1.0; return; }
  let wetness = max(0.0, b.w - P.dt / max(P.dripDry, 0.05));
  drip[s * 2u + 1u].w = wetness;
  if (wetness <= 0.0 || here > 0.1 || P.smax == 0u || P.dripRate <= 0.0) { return; }
  let down = clamp(-wn.y, 0.0, 1.0);
  let rate = P.dripRate * wetness * wetness * (0.15 + 0.85 * down);
  let h0 = s * 747796405u + P.seed * 2891336453u + 17u;
  if (hash1(h0) >= rate * P.dt) { return; }
  let slot = atomicAdd(&sctl[0], 1u) % P.smax;
  if (sPos[slot].w > 0.0) { return; }
  sPos[slot] = vec4<f32>(probe, P.sprLife * 2.0);
  sVel[slot] = vec4<f32>(colSurfVel(k, wp) + wn * P.h * 2.0 * hash1(h0 + 1u), 0.0);
}
// narrow band, look only: a point at the centre of deep water cells (water on the grid with no particles), for the live view and bakes,
// written after the spray points (offset in P.opad). Above DEEPMAX deep cells an even, fixed sample is kept, sized from last frame's count.
const DEEPMAX: u32 = 200000u;
@compute @workgroup_size(256)
fn deepClear(@builtin(global_invocation_id) g: vec3<u32>) { let k = gid1(g); if (k >= DEEPMAX) { return; } let o = u32(P.opad) + k; if (o < arrayLength(&disp)) { disp[o] = vec4<f32>(0.0, -1.0e6, 0.0, 0.0); } }
@compute @workgroup_size(256)
fn deepPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  if (!inDom(a.p) || (ctype[a.c] & 0xffu) != 1u || atomicLoad(&cnt[a.c]) > 0) { return; }
  atomicAdd(&ctl[11], 1u);
  let prev = atomicLoad(&ctl[12]);
  if (prev > DEEPMAX && hash1(a.c * 2654435761u + 7u) * f32(prev) >= f32(DEEPMAX)) { return; }
  let k = atomicAdd(&ctl[13], 1u); if (k >= DEEPMAX) { return; }
  let o = u32(P.opad) + k; if (o >= arrayLength(&disp)) { return; }
  let x = cellCenter(a.p.x, a.p.y, a.p.z);
  disp[o] = vec4<f32>(x, 4096.0 + min(length(velGVec(x)), 63.0));
}
@compute @workgroup_size(1)
fn deepFin() { atomicStore(&ctl[14], min(atomicLoad(&ctl[13]), DEEPMAX)); atomicStore(&ctl[12], atomicLoad(&ctl[11])); atomicStore(&ctl[11], 0u); atomicStore(&ctl[13], 0u); }
fn collideP(pin: vec3<f32>) -> vec3<f32> {
  var p = pin;
  let m = P.margin;
  for (var k = 0u; k < P.ncols; k++) {
    if (!colNear(k, p)) { continue; }
    let e = sdfEval(k, p);
    if (e.x < P.q0) { p += e.yzw * (P.q0 - e.x); }
  }
  let big = 1.0e9;
  let lo = vec3<f32>(select(P.x0 + m, -big, (P.open & 1u) != 0u), select(P.y0 + m, -big, (P.open & 4u) != 0u), select(P.z0 + m, -big, (P.open & 16u) != 0u));
  let hi = vec3<f32>(select(P.x1 - m, big, (P.open & 2u) != 0u), select(P.y1 - m, big, (P.open & 8u) != 0u), select(P.z1 - m, big, (P.open & 32u) != 0u));
  return clamp(p, lo, hi);
}
fn hsh3(p: vec3<f32>) -> f32 {
  var q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3)); q = q * 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
fn vnz(x: vec3<f32>) -> f32 {
  let i = floor(x); let fr = fract(x); let u = fr * fr * (3.0 - 2.0 * fr);
  let a = mix(mix(hsh3(i), hsh3(i + vec3<f32>(1.0, 0.0, 0.0)), u.x), mix(hsh3(i + vec3<f32>(0.0, 1.0, 0.0)), hsh3(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y);
  let b = mix(mix(hsh3(i + vec3<f32>(0.0, 0.0, 1.0)), hsh3(i + vec3<f32>(1.0, 0.0, 1.0)), u.x), mix(hsh3(i + vec3<f32>(0.0, 1.0, 1.0)), hsh3(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}
@compute @workgroup_size(256)
fn g2p(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  if (pos[i].y < DEADY) { return; }
  let p = pos[i].xyz;
  let v0 = vel[i].xyz;
  let fcell = particleCell(p);
  var vn = v0 - vec3<f32>(0.0, P.gravity * P.dt, 0.0); var vo = v0;   // falls freely if its block had no room this step
  if (hasStorage(fcell)) { let s2 = sampleBoth(p); vn = s2.vn; vo = s2.vo; }
  var v = mix(vn, v0 + (vn - vo), P.flip);
  if (P.ocean != 0u) { let lw = layerW(p); if (lw > 0.0) { let s = clamp(lw * 2.0, 0.0, 1.0); v = mix(v, oceanVel(p), s * s * (1.0 - exp(-8.0 * P.dt))); } }   // near the ocean's boundary, ease into the waves
  // local density of water around the particle: tiny when it is alone or in a small group, about 1 inside a big body of water
  // 2x2x2 block of cells nearest the particle
  let bc = vec3<i32>(floor((p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih - vec3<f32>(0.5)));
  var csum = 8.0 * P.rest;
  let fast = P.q12 > 0.5;
  if (P.q9 < 0.5 && fast) { csum = 8.0 * f32(atomicLoad(&cnt[cellIdx(fcell.x, fcell.y, fcell.z)])); }
  else if (P.q9 < 0.5) {
  csum = 0.0;
  for (var dz = 0; dz <= 1; dz++) { for (var dy = 0; dy <= 1; dy++) { for (var dx = 0; dx <= 1; dx++) {
    let cc = clamp(bc + vec3<i32>(dx, dy, dz), vec3<i32>(0), vec3<i32>(i32(P.nx) - 1, i32(P.ny) - 1, i32(P.nz) - 1));
    csum += f32(atomicLoad(&cnt[cellIdx(cc.x, cc.y, cc.z)]));
  } } }
  }
  let rho = csum / (8.0 * P.rest);
  let air = 1.0 - smoothstep(0.008, 0.1, rho);       // 1 = spray in open air
  let shield = smoothstep(0.1, 0.65, rho);          // 1 = buried in a clump
  let exposure = 1.0 - 0.97 * shield;
  let spd0 = length(v);
  // white water: fast spray in the air, hard impacts, and churning the grid cannot hold. Sensitivity is q6.
  let sens = max(P.q6, 0.05);
  let pacc = length(vn - vo) / P.dt;
  let settle = smoothstep(0.1, 0.5, P.q8);   // the first moments after a start are the fill settling, not churning
  let impact = clamp((pacc / sens - 15.0) / 80.0, 0.0, 1.0) * settle;
  let turb = clamp((length(v0 - vo) / sens - 0.35) / 1.5, 0.0, 1.0) * settle;
  let spray = air * (0.25 + 0.75 * clamp(spd0 / 4.0, 0.0, 1.0));
  // airborne droplets stay white, surface foam fades over q5 seconds, foam buried deep in the water goes quickly
  let tau = max(P.q5, 0.05) * mix(1.0, 0.35, smoothstep(0.7, 1.0, rho)) * mix(1.0, 2.5, air);
  var foam = vel[i].w * exp(-P.dt / tau);
  foam = max(foam, max(spray * 0.9, max(impact, turb * 0.8)));
  if (P.ocean != 0u) { foam *= 1.0 - clamp(layerW(p) * 2.0, 0.0, 1.0); }   // easing into the waves at the boundary is not churning
  // air: wind plus gusts of turbulence. Single drops and small groups are dragged hard, a big clump hardly feels it.
  var gust = vec3<f32>(0.0);
  if (P.q7 > 0.0 && P.q4 > 0.0 && (!fast || shield < 0.9)) {
    let gp = p * 0.55; let tt = P.q8 * 0.6;
    gust = vec3<f32>(vnz(gp + vec3<f32>(tt, 0.0, 0.0)), vnz(gp + vec3<f32>(17.3, tt, 4.1)), vnz(gp + vec3<f32>(5.7, 9.2, tt))) * 2.0 - vec3<f32>(1.0);
  }
  let kd = P.q4 * (0.04 + 1.5 * exposure * exposure);
  let airv = vec3<f32>(P.q1, P.q2, P.q3) + gust * P.q7;
  v = v + (airv - v) * (1.0 - exp(-kd * P.dt));
  let sp = length(v);
  if (sp > P.vmax) { v = v * (P.vmax / sp); }
  let pt = p + v * P.dt;
  let pc = collideP(pt);
  let dsp = pc - pt;
  if (dot(dsp, dsp) > 1.0e-12) {
    let nrm = normalize(dsp); let vd = dot(v, nrm);
    if (vd < 0.0) { v = v - vd * nrm; }
  }
  let o = P.open;
  if (o != 0u && (((o & 1u) != 0u && pc.x < P.x0) || ((o & 2u) != 0u && pc.x > P.x1) || ((o & 4u) != 0u && pc.y < P.y0) ||
      ((o & 8u) != 0u && pc.y > P.y1) || ((o & 16u) != 0u && pc.z < P.z0) || ((o & 32u) != 0u && pc.z > P.z1))) {
    pos[i] = vec4<f32>(0.0, -1.0e6, 0.0, 0.0); vel[i] = vec4<f32>(0.0);
    return;
  }
  pos[i] = vec4<f32>(pc, min(length(v), 63.0) + 64.0 * floor(foam * 15.0 + 0.5));
  vel[i] = vec4<f32>(v, foam);
}
// ---- narrow band kernels ----
// blocks that hold water by depth (not just particles) keep their storage
@compute @workgroup_size(256)
fn tileMarkPhi(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  if (!inDom(a.p) || phiOf(a.c) >= 0.5) { return; }
  markAround(a.p);
}
// on a restart: every block the starting water reaches
@compute @workgroup_size(256)
fn tileMarkFill(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); if (t >= ntiles()) { return; }
  let tt = t / P.tx;
  let tc = vec3<f32>(f32(t % P.tx), f32(tt % P.ty), f32(tt / P.ty)) * 8.0 + vec3<f32>(4.0);
  if (fillPhi(vec3<f32>(P.x0, P.y0, P.z0) + tc * P.h) < 9.0) { atomicStore(&need[t], 1u); }
}
// depth from the starting water (1: restart, 2: water added, keeping what is there), and the starting velocity
@compute @workgroup_size(256)
fn phiInitAll(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  var ph = clamp(fillPhi(cellCenter(a.p.x, a.p.y, a.p.z)), -7.9, 7.9);
  if (ph < 0.0) { ph = min(ph, -1.5); }
  if (!inDom(a.p)) { ph = 8.0; }   // blocks reach one cell past the far walls; those cells are never water   // every cell of the starting water counts as water; the depth passes then measure it from the real surface
  if (P.nbInit == 2u) { ph = min(ph, phiOf(a.c)); }
  phiPut(a.c, ph);
  if (P.nbInit == 1u) {
    for (var ax = 0u; ax < 3u; ax++) {
      let fp = facePos(a.p, ax); var v = 0.0;
      if (P.ocean != 0u && fp.y < oceanEta(fp.xz)) { let ov = oceanVel(fp); v = select(select(ov.z, ov.y, ax == 1u), ov.x, ax == 0u); }
      velG[a.c * 3u + ax] = v;
    }
  }
}
// carry the depth along with the grid velocity, then decide which cells are water: cells with particles, and cells more than a
// cell deep by the carried depth (the deep water has no particles). In the ocean's boundary the ocean surface decides.
@compute @workgroup_size(256)
fn nbPhi(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  let c = a.c;
  if (!inDom(a.p)) { rhs[c] = 8.0; return; }
  if (colBits(c) != 0u) { rhs[c] = 0.5; return; }
  let x = cellCenter(a.p.x, a.p.y, a.p.z);
  let phA = phiSample(x - P.dt * velGVec(x));
  var inside = atomicLoad(&cnt[c]) > 0 || phA < -1.0;
  if (P.ocean != 0u && layerW(x) >= 0.5) { inside = x.y < oceanEta(x.xz); }
  rhs[c] = select(clamp(phA, 0.5, 7.9), clamp(phA, -7.9, -0.5), inside);
}
// depth below the surface in cells (surface cells -0.5, the next layer -1.5, ...), one cell further per pass
fn jacNb(p: vec3<i32>, cur: f32, fromRhs: bool) -> f32 {
  if (!inDom(p)) { return 8.0; }
  if (cur >= 0.0) { return cur; }
  var m = -8.0;
  for (var q = 0u; q < 6u; q++) {
    var n = p;
    if (q == 0u) { n.x -= 1; } else if (q == 1u) { n.x += 1; } else if (q == 2u) { n.y -= 1; } else if (q == 3u) { n.y += 1; } else if (q == 4u) { n.z -= 1; } else { n.z += 1; }
    if (!inDom(n)) { continue; }
    let cq = cellIdx(n.x, n.y, n.z);
    if (colBits(cq) != 0u) { continue; }
    m = max(m, select(phiOf(cq), rhs[cq], fromRhs));
  }
  return clamp(m - 1.0, -7.9, -0.5);
}
@compute @workgroup_size(256)
fn nbJacA(@builtin(global_invocation_id) g: vec3<u32>) { let a = acell(gid1(g)); if (!a.ok) { return; } phiPut(a.c, jacNb(a.p, rhs[a.c], true)); }
@compute @workgroup_size(256)
fn nbJacB(@builtin(global_invocation_id) g: vec3<u32>) { let a = acell(gid1(g)); if (!a.ok) { return; } rhs[a.c] = jacNb(a.p, phiOf(a.c), false); }
// faces in the water that got no particle velocity (and every deep face) take the kept grid velocity, carried along (semi-Lagrangian)
@compute @workgroup_size(256)
fn nbVel(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok || !inDom(a.p)) { return; }
  if ((ctype[a.c] & 0xffu) != 1u) { return; }
  for (var ax = 0u; ax < 3u; ax++) {
    var lo = a.p;
    if (ax == 0u) { lo.x -= 1; } else if (ax == 1u) { lo.y -= 1; } else { lo.z -= 1; }
    if (!inDom(lo)) { continue; }
    if ((ctype[cellIdx(lo.x, lo.y, lo.z)] & 0xffu) != 1u) { continue; }
    let f = a.c * 3u + ax;
    if (atomicLoad(&accW[f]) > 0) { continue; }   // particles there: their velocity wins
    let fp = facePos(a.p, ax);
    let vc = velGAxis(fp - P.dt * velGVec(fp), ax);
    atomicStore(&accV[f], i32(round(vc * P.scale))); atomicStore(&accW[f], i32(P.scale));
  }
}
// keep this step's grid velocity for the next one
@compute @workgroup_size(256)
fn saveVel(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  for (var ax = 0u; ax < 3u; ax++) { velG[a.c * 3u + ax] = gvR(a.c * 3u + ax); }
}
// particles deeper than the band (and any that drift into the ocean's boundary) are removed; their slots get reused
@compute @workgroup_size(256)
fn nbKill(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let q = pos[i]; if (q.y < DEADY) { return; }
  let lw = layerW(q.xyz);
  var kill = lw >= 0.5 || (lw > 0.25 && q.y > oceanEta(q.xz) + 0.5 * P.h);   // inside the ocean boundary, or above the ocean surface in its inner half
  // below the band, but only once it is slow: fast water (an impact, a plunge) keeps its particles and so its momentum
  if (!kill && P.nb != 0u && calmV(vel[i].xyz)) { let cc = particleCell(q.xyz); if (hasStorage(cc) && phiOf(cellIdx(cc.x, cc.y, cc.z)) < -P.band) { kill = true; } }
  if (kill) { pos[i] = vec4<f32>(0.0, -1.0e6, 0.0, 0.0); vel[i] = vec4<f32>(0.0); }
}
@compute @workgroup_size(1)
fn nbReset() { atomicStore(&ctl[7], 0u); atomicStore(&ctl[8], 0u); atomicStore(&ctl[9], 0u); atomicStore(&ctl[10], 0u); }
// free particle slots
@compute @workgroup_size(256)
fn nbDead(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  if (pos[i].y < DEADY) { let k = atomicAdd(&ctl[8], 1u); if (k < P.lcap) { lst[k] = i; } }
}
// water cells inside the band (below the surface layer) that have too few particles
@compute @workgroup_size(256)
fn nbDeficit(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  let c = a.c;
  if (!inDom(a.p) || colBits(c) != 0u) { return; }
  let cx = cellCenter(a.p.x, a.p.y, a.p.z); let lw = layerW(cx); let ph = phiOf(c);
  if (lw > 0.25 && lw < 0.5) {   // the inner half of the ocean boundary holds the water at the ocean surface: always full below it
    if (cx.y > oceanEta(cx.xz) - 0.25 * P.h || ph < -P.band) { return; }
  } else {
    if ((ctype[c] & 0xffu) != 1u || ph > -1.0 || ph < -P.band) { return; }
    if (!calmV(velGVec(cx))) { return; }   // fast water thinning out is spray and foam, not missing water
  }
  let n = u32(max(atomicLoad(&cnt[c]), 0));
  if (f32(n) >= 0.55 * P.rest) { return; }
  let need = min(u32(round(0.85 * P.rest)) - n, 64u);
  let k = atomicAdd(&ctl[9], 1u); if (k >= P.lcap / 2u) { return; }
  lst[P.lcap + k * 2u] = u32(a.p.x) | (u32(a.p.y) << 16u);
  lst[P.lcap + k * 2u + 1u] = u32(a.p.z) | (need << 16u);
}
@compute @workgroup_size(1)
fn nbArgs() { split((min(atomicLoad(&ctl[9]), P.lcap / 2u) + 255u) / 256u, 24u); }
// fill those cells from the free slots, at random spots, moving with the grid
@compute @workgroup_size(256)
fn nbSpawn(@builtin(global_invocation_id) g: vec3<u32>) {
  let e = gid1(g); if (e >= min(atomicLoad(&ctl[9]), P.lcap / 2u)) { return; }
  let a0 = lst[P.lcap + e * 2u]; let a1 = lst[P.lcap + e * 2u + 1u];
  let cp = vec3<f32>(f32(a0 & 0xffffu), f32(a0 >> 16u), f32(a1 & 0xffffu)); let need = a1 >> 16u;
  let base = atomicAdd(&ctl[10], need); let avail = min(atomicLoad(&ctl[8]), P.lcap);
  for (var m = 0u; m < need; m++) {
    let k = base + m; if (k >= avail) { break; }
    let i = lst[k];
    let hh = (e * 9781u + m * 6271u + 17u) ^ (P.seed * 2654435761u);
    let x = vec3<f32>(P.x0, P.y0, P.z0) + (cp + vec3<f32>(hash1(hh + 1u), hash1(hh + 2u), hash1(hh + 3u))) * P.h;
    var v = velGVec(x);
    if (layerW(x) > 0.25) { v = oceanVel(x); }
    pos[i] = vec4<f32>(x, min(length(v), 63.0)); vel[i] = vec4<f32>(v, 0.0);
  }
}
`;
}

const FLIP_SLOT = { cells: 512 };   // one block of the sparse grid: 8 x 8 x 8 cells
const FLIP_PARAMS_BYTES = 1632;      // the solver's uniform block: settings, whitewater, air and drips (words 68-83), starting-water shapes (84), ocean waves (148)
const FLIP_DEEPMAX = 200000;          // deep water points drawn at most (narrow band, look only); matches DEEPMAX in the shader
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
    this.bCols = mk(32 * 128); this.bSortCnt = mk(65536 * 4); this.bTpos = mk(16); this.bTvel = mk(16); this.sortTick = 0; this.solidDirty = true; this.cfPrev = null;
    this.bCtl = device.createBuffer({ size: 64, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
    this.bGro = mk(16);
    this.dispMax = 300000; this.stride = 1;
    this.bDisp = mk(Math.min(this.MAXN, this.dispMax + 1) * 16 + 16);
    this.bPack = mk(16); this.bPackU = device.createBuffer({ size: 96, usage: U.UNIFORM | U.COPY_DST }); this.packWords = 4;
    this.bArgs = device.createBuffer({ size: 128, usage: U.STORAGE | U.INDIRECT | U.COPY_DST });
    this.sdfCap = 16; this.sdfSig = null; this.bSdf = mk(64);
    this.bParams = device.createBuffer({ size: FLIP_PARAMS_BYTES, usage: U.UNIFORM | U.COPY_DST });
    this.bStat = device.createBuffer({ size: 32, usage: U.MAP_READ | U.COPY_DST }); this.statBusy = false; this.stats = null;
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
    const mod = device.createShaderModule({ code: flipWGSL() });
    const L = {
      tileReset: [12], tileNeedClear: [0, 17], tileMark: [0, 1, 17], tileMarkPhi: [0, 7, 12, 17, 18, 19], tileMarkFill: [0, 10, 11, 17], phiInitAll: [0, 7, 10, 11, 12, 18, 19, 31], tileFree: [0, 12, 16, 17, 20, 21], argsNew: [12, 14], tileAlloc: [0, 12, 16, 19, 20, 21], tileFix: [0, 12],
      initNew: [0, 7, 8, 10, 11, 12, 21, 31], slotListBuild: [0, 12, 16, 18], argsSlots: [12, 14], growFree: [12, 20, 25],
      sortClear: [22], sortHist: [0, 1, 22], sortScan: [22], sortScatter: [0, 1, 2, 22, 23, 24, 26, 27], sortCopy: [0, 1, 2, 23, 24, 26, 27], unsort: [0, 1, 23, 26],
      clearSlots: [3, 5, 6, 9, 12, 18], p2g: [0, 1, 2, 3, 5, 6, 12, 16], solidBuild: [0, 7, 10, 11, 12, 18, 19], classify: [0, 6, 7, 8, 12, 16, 18, 19, 31], sprayEmit: [0, 1, 2, 6, 7, 16, 28, 29, 30], sprayStep: [0, 10, 11, 28, 29, 32, 33], sprayDisp: [0, 15, 28, 29, 30], dispBegin: [30], packDisp: [1, 12, 15, 30, 37, 38], wwSample: [0, 3, 5, 6, 7, 16, 28, 33], wwArgs: [0, 14, 30],
      airClear: [0, 34], airSplatW: [0, 1, 2, 6, 16, 34], airSplatS: [0, 28, 29, 34], airUpdate: [0, 10, 11, 32, 34, 35], airCopy: [0, 32, 35], dripStep: [0, 6, 7, 10, 16, 28, 29, 30, 36],
      normFaces: [0, 3, 5, 7, 10, 12, 16, 18, 19], divergence: [0, 3, 6, 7, 9, 12, 16, 18, 19],
      listClear: [12], buildList: [0, 7, 12, 13, 18, 19], listArgs: [0, 12, 14], rbRed: [0, 7, 8, 9, 12, 13, 16, 19], rbBlack: [0, 7, 8, 9, 12, 13, 16, 19],
      project: [0, 3, 7, 8, 12, 16, 18, 19], subsample: [0, 1, 15], g2p: [0, 1, 2, 3, 5, 6, 10, 11, 16],
      nbPhi: [0, 6, 7, 9, 12, 16, 18, 19, 31], nbJacA: [0, 7, 9, 12, 16, 18, 19], nbJacB: [0, 7, 9, 12, 16, 18, 19], nbVel: [0, 3, 5, 7, 12, 16, 18, 19, 31],
      saveVel: [0, 3, 12, 18, 19, 31], nbKill: [0, 1, 2, 7, 16], nbReset: [12], nbDead: [0, 1, 12, 13], nbDeficit: [0, 6, 7, 12, 13, 16, 18, 19, 31], nbArgs: [0, 12, 14],
      nbSpawn: [0, 1, 2, 12, 13, 16, 31], deepClear: [0, 15], deepPick: [0, 6, 7, 12, 15, 16, 18, 19, 31], deepFin: [12] };
    this.L = L; this.pipes = {};
    for (const name in L) this.pipes[name] = { pipeline: device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: name } }) };
    this.dispAlloc();   // also makes the bind groups
  }
  // per-block storage: cell count, type, pressure, rhs (4 bytes each per cell), two numbers for each of the three faces, plus slot bookkeeping
  makeSlotBuffers(n) {
    const mk = this.mk, C = 512;
    this.bCnt = mk(n * C * 4); this.bType = mk(n * C * 4); this.bPres = mk(n * C * 4); this.bRhs = mk(n * C * 4);
    this.bAcc = mk(n * C * 12); this.bAccW = mk(n * C * 12); this.bVelG = mk(this.velGOn ? n * C * 12 : 16);   // kept velocity: only once narrow band is used
    this.bSlotList = mk(n * 4); this.bSlotTile = mk(n * 4); this.bStack = mk(n * 4);
    // fluid cell lists: without narrow band a water cell holds at least one particle; with it, deep water cells hold none, so the lists go by cells
    this.lcap = this.velGOn ? n * C : Math.min(n * C, this.MAXN); this.bList = mk(this.lcap * 8);
  }
  // the first narrow band step: room for the kept grid velocity and longer cell lists
  enableNB() {
    if (this.velGOn) return;
    this.velGOn = true;
    this.bVelG.destroy(); this.bVelG = this.mk(this.scap * 512 * 12);
    this.bList.destroy(); this.lcap = this.scap * 512; this.bList = this.mk(this.lcap * 8);
    this.makeGroups();
  }
  slotBufs() { return ['bCnt', 'bType', 'bPres', 'bRhs', 'bAcc', 'bAccW', 'bVelG', 'bSlotList', 'bSlotTile', 'bStack']; }
  makeGroups() {
    const bufs = { 0: this.bParams, 1: this.bPos, 2: this.bVel, 3: this.bAcc, 5: this.bAccW, 6: this.bCnt, 7: this.bType, 8: this.bPres, 9: this.bRhs, 10: this.bCols, 11: this.bSdf,
      12: this.bCtl, 13: this.bList, 14: this.bArgs, 15: this.bDisp, 16: this.bTmap, 17: this.bNeed, 18: this.bSlotList, 19: this.bSlotTile, 20: this.bStack, 21: this.bNew,
      22: this.bSortCnt, 23: this.bTpos, 24: this.bTvel, 25: this.bGro, 26: this.bPid, 27: this.bTpid, 28: this.bSPos, 29: this.bSVel, 30: this.bSctl, 31: this.bVelG,
      32: this.bAir, 33: this.bSAux, 34: this.bAirAcc, 35: this.bAir2, 36: this.bDrip, 37: this.bPack, 38: this.bPackU };
    for (const name in this.L) { const p = this.pipes[name]; p.bg = this.dev.createBindGroup({ layout: p.pipeline.getBindGroupLayout(0), entries: this.L[name].map((k) => ({ binding: k, resource: { buffer: bufs[k] } })) }); }
  }
  // more blocks: copy the old ones over unchanged and put the new slots on the free stack
  grow(n) {
    n = Math.min(this.scapMax, Math.max(n, this.scap + 1)); if (n <= this.scap) return false;
    const old = this.scap, keep = {}, per = { bCnt: 2048, bType: 2048, bPres: 2048, bRhs: 2048, bAcc: 6144, bAccW: 6144, bVelG: 6144, bSlotList: 4, bSlotTile: 4, bStack: 4 };
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
    enc.copyBufferToBuffer(this.bCtl, 0, this.bStat, 0, 32); this.statBusy = true;
    const done = () => this.dev.queue.onSubmittedWorkDone().then(() => this.bStat.mapAsync(GPUMapMode.READ)).then(() => {
      const a = new Uint32Array(this.bStat.getMappedRange().slice(0)); this.bStat.unmap();
      this.stats = { sc: a[4], ovf: a[5], fluid: a[0] + a[1], vmax: new Float32Array(a.buffer)[6], seen: false }; this.ovfTotal = (this.ovfTotal || 0) + a[5]; this.peak = Math.max(this.peak || 0, a[4]); this.statBusy = false;
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
    this.flushRun();
    const N = this.N; if (N === 0) return;
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
    const F = [dt, h, 1 / h, o.g, o.flip === undefined ? 0.95 : o.flip, this.rest, o.comp === undefined ? 6 : o.comp, o.omega || this.omega(),
      b.x0, b.y0, b.z0, o.vmax || 14, 0.3 * this.d, 65536, b.x1, b.y1, b.z1, 0.3 * h,
      (o.wind && o.wind[0]) || 0, (o.wind && o.wind[1]) || 0, (o.wind && o.wind[2]) || 0, o.drag || 0, o.foamTau || 1.2, o.foamSens || 1, o.gust || 0, this.tm || 0, this.opt.noFoam ? 1 : 0, this.opt.noCull ? 1 : 0, this.stride, this.opt.fastAir ? 1 : 0];
    if (!this.only) this.tm = (this.tm || 0) + dt;
    for (let k = 0; k < F.length; k++) f32[8 + k] = F[k];
    const B = 8 + F.length; u32[B] = this.lcap; u32[B + 1] = this.tx; u32[B + 2] = this.ty; u32[B + 3] = this.tz; u32[B + 4] = this.scap;
    const sp = o.spr || null, on = !!sp && this.sprayCap > 0;
    f32[B + 5] = o.tear || 0; f32[B + 6] = on ? sp.rate : 0; f32[B + 7] = on ? Math.max(0.05, sp.min) : 1; f32[B + 8] = on ? sp.life : 1; f32[B + 9] = on ? sp.mist : 0;
    f32[B + 10] = on ? sp.drag : 1; f32[B + 11] = on ? sp.mdrag : 4; f32[B + 12] = o.vs || 1;
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
    f32[80] = dr ? dr.rate : 0; f32[81] = dr ? dr.dry : 1; f32[82] = airo ? (airo.blur === undefined ? 0.35 : airo.blur) : 0; f32[83] = 0;
    this.airOnStep = !!(airo && ad); this.dripOnStep = !!(dr && this.ndrip > 0);
    this.dev.queue.writeBuffer(this.bParams, 0, this.pu);
    const iters = Math.max(1, (this.opt.iters || o.iters) | 0);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (const st of this.stages(N, iters)) st.fn(pass);
    pass.end();
    this.readStats(enc);
    this.dev.queue.submit([enc.finish()]);
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
      if ((this.sortTick++) % Math.max(1, this.opt.sortEvery | 0) !== 0) return;
      this.sortedEver = true;
      dispatch(ps, 'sortClear', 65536); dispatch(ps, 'sortHist', N);
      const p = this.pipes.sortScan; ps.setPipeline(p.pipeline); ps.setBindGroup(0, p.bg); ps.dispatchWorkgroups(1);
      dispatch(ps, 'sortScatter', N); dispatch(ps, 'sortCopy', N);
    } };
    return [
      ...(this.opt.sort ? [sortStage] : []),
      tiles,
      { name: 'clear', fn: (ps) => indirect(ps, 'clearSlots', 80) },
      { name: 'p2g', fn: (ps) => dispatch(ps, 'p2g', N) },
      ...(nb ? [{ name: 'narrow band', fn: (ps) => {
        indirect(ps, 'nbPhi', 64); indirect(ps, 'nbJacA', 64); indirect(ps, 'nbJacB', 64); indirect(ps, 'nbJacA', 64);
      } }] : []),
      { name: 'classify', fn: (ps) => {
        if (this.solidDirty) { indirect(ps, 'solidBuild', 64); this.solidDirty = false; }
        indirect(ps, 'classify', 64);
        dispatch(ps, 'listClear', 1); indirect(ps, 'buildList', 64); dispatch(ps, 'listArgs', 1);
        if (nb) indirect(ps, 'nbVel', 64);
      } },
      { name: 'normFaces', fn: (ps) => indirect(ps, 'normFaces', 64) },
      { name: 'divergence', fn: (ps) => indirect(ps, 'divergence', 64) },
      { name: 'pressure', fn: (ps) => {
        for (let it = 0; it < iters; it++) for (const [nm, off] of [['rbRed', 0], ['rbBlack', 16]]) indirect(ps, nm, off);
      } },
      { name: 'project', fn: (ps) => { indirect(ps, 'project', 64); if (nb) indirect(ps, 'saveVel', 64); } },
      { name: 'g2p', fn: (ps) => dispatch(ps, 'g2p', N) },
      ...(this.sprayCap > 0 ? [{ name: 'spray', fn: (ps) => {
        if (this.airOnStep) {   // air field first, so the whitewater moves with this step's air
          const na = this.airDims.n;
          dispatch(ps, 'wwArgs', 1);
          dispatch(ps, 'airClear', na); dispatch(ps, 'airSplatW', N); indirect(ps, 'airSplatS', 112); dispatch(ps, 'airUpdate', na); dispatch(ps, 'airCopy', na);
        }
        dispatch(ps, 'wwArgs', 1); indirect(ps, 'wwSample', 112); indirect(ps, 'sprayStep', 112);
        if (this.sprOnStep) dispatch(ps, 'sprayEmit', N);
        if (this.dripOnStep) dispatch(ps, 'dripStep', this.ndrip);
      } }] : []),
      ...(nb ? [{ name: 'reseed', fn: (ps) => {
        dispatch(ps, 'nbKill', N); dispatch(ps, 'nbReset', 1); dispatch(ps, 'nbDead', N); indirect(ps, 'nbDeficit', 64); dispatch(ps, 'nbArgs', 1); indirect(ps, 'nbSpawn', 96);
      } }] : [])
    ];
  }
  // benchmark helper: run one real step, but submit every stage separately and wait for it, returning milliseconds per stage
  async stepTimed(dt, o) {
    const N = this.N; if (N === 0) return null;
    this.maybeGrow();
    const iters = Math.max(1, (this.opt.iters || o.iters) | 0);
    const prev = this.stages; this.stages = () => [];
    FlipSim.prototype.step.call(this, dt, o);   // uploads parameters and collider data, runs nothing
    this.stages = prev;
    const stages = this.stages(N, iters);
    const out = {};
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
    const b = this.b, u = new ArrayBuffer(96), u32 = new Uint32Array(u), f32 = new Float32Array(u);
    u32.set([L.nW, L.nS, L.nD, fromPos ? 1 : 0, nW, deep ? Math.round(this.pf32[62]) : 0, L.oWp, L.oWs, L.oWf, L.oSp, L.oSk, L.oDp, L.oDs, 0, 0, 0]);
    f32.set([b.x0, b.y0, b.z0, 65535 / (b.x1 - b.x0), 65535 / (b.y1 - b.y0), 65535 / (b.z1 - b.z0), 0, 0], 16);
    this.dev.queue.writeBuffer(this.bPackU, 0, u);
    const run = (ps, name, items) => { const p = this.pipes[name], g = Math.ceil(items / 256); ps.setPipeline(p.pipeline); ps.setBindGroup(0, p.bg); ps.dispatchWorkgroups(Math.max(1, Math.min(g, 65535)), Math.max(1, Math.ceil(g / 65535))); };
    const ps = enc.beginComputePass();
    if (!fromPos) run(ps, 'subsample', nW);
    if (spr) { run(ps, 'dispBegin', 1); run(ps, 'sprayDisp', this.sprDispMax); }
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
    [this.bPos, this.bVel, this.bPid, this.bTpid, this.bSPos, this.bSVel, this.bSctl, this.sstage, this.bTmap, this.bNeed, this.bNew, this.bCols, this.bSortCnt, this.bTpos, this.bTvel, this.bSdf, this.bParams, this.stage, this.bList, this.bCtl, this.bGro, this.bArgs, this.bDisp, this.bStat, this.dstage, this.sctlStage, this.bSAux, this.bAir, this.bAir2, this.bAirAcc, this.bDrip, this.bPack, this.bPackU]
      .concat(this.slotBufs().map((k) => this[k])).forEach((x) => { try { x && x.destroy(); } catch (e) { /* ignore */ } });
    (this.rs || []).forEach((q) => q.buf.destroy());
  }
}
['setCap', 'clear', 'add', 'flushRun', 'track', 'fillBox', 'fillSphere'].forEach((m) => { FlipSim.prototype[m] = GpuSim.prototype[m]; });
// The live view: packed on the GPU (dispPack) and read back with up to three copies in flight, so stepping never waits for them.
// The newest finished copy becomes this.outFrame, a frame in the cache format that the drawing uploads as it is and the live cache keeps.
FlipSim.prototype.pump = function () {
  if (!this.needRead) return;
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
  if (nS) fr.sp = { n: nS, pos: new Uint16Array(ab, off[2], nS * 3), pk: new Uint32Array(ab, off[0], nS), alive: nS };
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

// the same 32-bit packing as the shader: top bit, two bits of kind (00 spray, 10 mist, 01 foam, 11 bubble), 8 bits of speed in quarter units
// per second, then the direction (spray, mist) or how much life is left (foam, bubbles)
function packSprayJS(vx, vy, vz, kind, lifeFrac) {
  kind = kind === true ? 1 : (kind | 0);
  const s = Math.hypot(vx, vy, vz);
  let code = (0x80000000 | (Math.min(Math.floor(s * 4), 255) << 21)) >>> 0;
  code = (code | [0, 0x40000000, 0x20000000, 0x60000000][kind & 3]) >>> 0;
  if (kind >= 2) return (code | Math.round(Math.max(0, Math.min(1, lifeFrac || 0)) * 1023)) >>> 0;
  let nx = 0, ny = 1, nz = 0; if (s > 1e-6) { nx = vx / s; ny = vy / s; nz = vz / s; }
  const l = Math.abs(nx) + Math.abs(ny) + Math.abs(nz); let px = nx / l, py = ny / l;
  if (nz < 0) { const qx = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1), qy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1); px = qx; py = qy; }
  const u = Math.max(0, Math.min(1023, Math.round((px * 0.5 + 0.5) * 1023))), w = Math.max(0, Math.min(1023, Math.round((py * 0.5 + 0.5) * 1023)));
  return (code | (w << 10) | u) >>> 0;
}
// drip samples on a collider, from its distance grid: grid points near the surface, moved onto it along the gradient, about one per solver
// cell of surface (at most 6000). 8 floats each: local position, collider number, local normal, wetness (starts dry).
const DRIP_CACHE = new Map();
function dripSamples(sdf, h, k) {
  const key = sdf.id + '|' + h.toFixed(5);
  let base = DRIP_CACHE.get(key);
  if (!base) {
    const [nx, ny, nz] = sdf.dims, c = sdf.cell, d = sdf.data, o = sdf.origin, pts = [];
    const at = (i, j, q) => d[Math.min(nx - 1, Math.max(0, i)) + nx * (Math.min(ny - 1, Math.max(0, j)) + ny * Math.min(nz - 1, Math.max(0, q)))];
    for (let q = 1; q < nz - 1; q++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const v = d[i + nx * (j + ny * q)]; if (Math.abs(v) > 0.6 * c) continue;
      let gx = at(i + 1, j, q) - at(i - 1, j, q), gy = at(i, j + 1, q) - at(i, j - 1, q), gz = at(i, j, q + 1) - at(i, j, q - 1);
      const gl = Math.hypot(gx, gy, gz); if (gl < 1e-9) continue; gx /= gl; gy /= gl; gz /= gl;
      pts.push(o[0] + i * c - gx * v, o[1] + j * c - gy * v, o[2] + q * c - gz * v, gx, gy, gz);
    }
    const nsurf = pts.length / 6, want = Math.max(100, Math.min(6000, Math.round(nsurf * c * c / (h * h))));
    const step = Math.max(1, nsurf / want), out = [];
    let sd = 7 + (sdf.id | 0); const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (let t = rnd() * step; t < nsurf; t += step) { const i = Math.floor(t) * 6; out.push(pts[i], pts[i + 1], pts[i + 2], 0, pts[i + 3], pts[i + 4], pts[i + 5], 0); }
    base = new Float32Array(out); DRIP_CACHE.set(key, base);
    if (DRIP_CACHE.size > 32) DRIP_CACHE.delete(DRIP_CACHE.keys().next().value);
  }
  const a = base.slice(); for (let i = 3; i < a.length; i += 8) a[i] = k;
  return a;
}
// live whitewater slots for a cache frame: an even sample of at most about cap points, positions across the box like the water. The sample goes
// by slot number, so a point that stays alive stays in the sample from frame to frame (sampling by count would pick different points each frame).
function packSprayFrame(sd, b, cap, foamLife) {
  foamLife = foamLife || 3;
  let alive = 0; for (let j = 0; j < sd.n; j++) if (sd.p[j * 4 + 3] > 0) alive++;
  const step = Math.max(1, Math.ceil(alive / cap));
  let m = 0; for (let j = 0; j < sd.n; j += step) if (sd.p[j * 4 + 3] > 0) m++;
  const pos = new Uint16Array(m * 3), pk = new Uint32Array(m);
  const kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0);
  let k = 0;
  for (let j = 0; j < sd.n && k < m; j += step) {
    if (!(sd.p[j * 4 + 3] > 0)) continue;
    pos[k * 3] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4] - b.x0) * kx))); pos[k * 3 + 1] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4 + 1] - b.y0) * ky)));
    pos[k * 3 + 2] = Math.max(0, Math.min(65535, Math.round((sd.p[j * 4 + 2] - b.z0) * kz)));
    pk[k] = packSprayJS(sd.v[j * 4], sd.v[j * 4 + 1], sd.v[j * 4 + 2], Math.round(sd.v[j * 4 + 3]), sd.p[j * 4 + 3] / foamLife); k++;
  }
  return { n: k, pos, pk, alive };
}
// Per-frame measurements for the bake report: where the water is, how fast, how much left or went bad.
function bakeDiag(dst, n, b, vcap) {
  const H = 16, hist = new Array(H).fill(0), hy = (b.y1 - b.y0) / H, cap = Math.min(vcap || 14, 63) * 0.98, e = 1e-3;
  let alive = 0, bad = 0, out = 0, capped = 0, foamy = 0, sx = 0, sy = 0, sz = 0, ss = 0, smax = 0, fl = 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = dst[i * 4], y = dst[i * 4 + 1], z = dst[i * 4 + 2], w = dst[i * 4 + 3];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w))) { bad++; continue; }
    if (y < -1e5) continue;
    alive++;
    const lv = Math.floor(w / 64), sp = w - lv * 64;
    sx += x; sy += y; sz += z; ss += sp; if (sp > smax) smax = sp; fl += lv; if (lv >= 8) foamy++;
    if (sp >= cap) capped++;
    if (x < b.x0 - e || x > b.x1 + e || y < b.y0 - e || y > b.y1 + e || z < b.z0 - e || z > b.z1 + e) out++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    hist[Math.max(0, Math.min(H - 1, Math.floor((y - b.y0) / hy)))]++;
  }
  const a = Math.max(alive, 1);
  return { alive, gone: n - alive - bad, nonFinite: bad, outsideBox: out, atWaterSpeedLimit: capped, meanSpeed: ss / a, maxSpeed: smax, meanFoam: fl / a / 15, foamyPoints: foamy,
    center: [sx / a, sy / a, sz / a], bbox: alive ? [x0, y0, z0, x1, y1, z1] : null, heightHist: hist };
}
// Same contract as runBakeGpu. Substeps adapt to the fastest particle of the last frame so fast splashes get small steps and calm frames get few.
async function runBakeFlipGpu(desc, gpu, onFrame, isCancelled) {
  const sim = new FlipSim(gpu.dev, { d: desc.d, maxN: desc.maxN, size: desc.size, open: desc.open, ratio: desc.cellRatio });
  sim.recycle = false; sim.cap = desc.maxN; sim.opt.fastAir = !!desc.fastAir; sim.opt.sort = !!desc.sortP;
  if (desc.spr && desc.sprayCap) sim.setSprayCap(desc.sprayCap);
  if (desc.nbLook) sim.setDeepLook(true);
  const runner = new SceneRunner(sim);
  const oc = desc.ocean && desc.ocean.on ? desc.ocean : null, nbc = desc.nb && (desc.nb.on || oc) ? desc.nb : null;
  if (nbc || oc) nbSeed(sim, desc.fills, nbc || { on: true, band: 3 }, oc, 0, desc.g, 1);
  else for (const f of desc.fills) {
    if (f.t === 'box') sim.fillBox(f.x0, f.x1, f.y0, f.y1, f.z0, f.z1);
    else if (f.t === 'vol') fillVolume(sim, f);
    else sim.fillSphere(f.x, f.y, f.z, f.r, 0, f.vy || 0, 0);
  }
  const dst = new Float32Array(desc.maxN * 4);
  const fps = desc.fps, F = desc.frames, dtF = 1 / fps, minSub = desc.substeps, cfl = desc.cfl || 1.5, maxSub = Math.max(minSub, desc.maxSub || 16);
  const ev = desc.events.slice().sort((a, b) => a.t - b.t); let ei = 0;
  const t0 = Date.now();
  const sampleAll = (t) => desc.objs.map((o) => sampleObjState(o, t));
  let vmax = 2;
  for (const o of sampleAll(0)) if (o.kind === 'emitter') vmax = Math.max(vmax, o.speed || 0);
  if (sim.N > 0) await sim.prime({ g: desc.g, iters: desc.iters, cols: [] });   // size the block pool for the starting water
  let n = await sim.readbackInto(dst);
  onFrame(packFrameBuf(dst, n, sim.b, sampleAll(0)), { f: 0, F, n, elapsed: 0, full: false, diag: Object.assign(bakeDiag(dst, n, sim.b, desc.vmaxW), { sub: 0, blockPool: sim.scap }) });
  let ok = true;
  for (let f = 1; f <= F; f++) {
    const objV = objSpeed(sampleAll((f - 1) * dtF), sampleAll(f * dtF), dtF, desc.colMax);   // objects' own motion during this frame is known ahead
    const sub = Math.max(minSub, Math.min(maxSub, Math.ceil(dtF * Math.max(vmax, objV) / (cfl * sim.h)))), dt = dtF / sub, tf0 = performance.now(), ovf0 = sim.ovfTotal || 0;
    for (let s = 0; s < sub; s++) {
      const t = (f - 1) * dtF + (s + 1) * dt;
      while (ei < ev.length && ev[ei].t <= t) { const e = ev[ei++]; sim.fillSphere(e.x, e.y, e.z, e.r, 0, -1, 0); }
      runner.step(dt, sampleAll(t), { g: desc.g, iters: desc.iters, flip: desc.flip, comp: desc.comp, wind: desc.wind, drag: desc.drag, foamTau: desc.foamTau, gust: desc.gust, foamSens: desc.foamSens, colMax: desc.colMax, vmax: desc.vmaxW, scale: desc.scale || 1, vs: desc.scale || 1, tear: desc.tear || 0, spr: desc.spr || null,
        nb: nbc, ocean: oc, time: t, air: desc.air || null, drip: desc.drip || null });
    }
    n = await sim.readbackInto(dst);
    let mv = 0; for (let i = 0; i < n; i++) { const w = dst[i * 4 + 3] % 64; if (w > mv) mv = w; }
    if (sim.stats && sim.stats.vmax > mv) mv = sim.stats.vmax;
    for (const o of sampleAll(f * dtF)) if (o.kind === 'emitter' && o.on) mv = Math.max(mv, o.speed || 0);
    vmax = Math.max(1, mv);
    const st = sim.stats || {};
    const diag = Object.assign(bakeDiag(dst, n, sim.b, desc.vmaxW), { sub, objectSpeed: objV, fastestParticle: st.vmax, fluidCells: st.fluid, blocksUsed: st.sc, blockPool: sim.scap,
      blocksNoRoom: (sim.ovfTotal || 0) - ovf0, ms: performance.now() - tf0 });
    const frame = packFrameBuf(dst, n, sim.b, sampleAll(f * dtF));
    if (sim.sprayCap) { const sd = await sim.readSpray(); if (sd) { frame.sp = packSprayFrame(sd, sim.b, 200000, (desc.spr && desc.spr.ww && desc.spr.ww.foamLife) || 3); diag.sprayPoints = frame.sp.alive; } }
    if (desc.nbLook) { const dd = await sim.readDeep(); if (dd && dd.n) { frame.dp = packDeep(dd.p, dd.n, sim.b); diag.deepPoints = dd.n; } }
    onFrame(frame, { f, F, n, elapsed: (Date.now() - t0) / 1000, full: sim.N >= sim.cap, sub, diag });
    if (isCancelled()) { ok = false; break; }
    await new Promise((r) => setTimeout(r, 0));
  }
  sim.destroy();
  return ok;
}
