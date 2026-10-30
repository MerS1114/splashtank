// The parameter block (Params), every binding, and the helpers the kernels share: cells, blocks, colliders, sampling, narrow band and ocean.
// Started from the web page's shader (src/flip/wgsl-*.js, 2026-10-29); now the desktop program's own source.

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
  dripRate: f32, dripDry: f32, airBlur: f32, wwSpin: f32,
  fills: array<vec4<f32>, 16>,
  waves: array<vec4<f32>, 64>,
  wwEdge: f32, wwErode: f32, wwLand: f32, wwTrail: f32,   // words 404-407: cosine of the leading-edge angle, foam spreading fade, foam from landing water, mist trails
  wwA0: vec4<f32>, wwA1: vec4<f32>,                       // words 408-415: the whitewater area (lowest and highest corner), at least the tank
  ext0: vec4<f32>,                                         // words 416-419: x fast drops fly free (ballistic), y settled-water tolerance in cells per step (0 off), z particle separation (share of the crowding undone per step, 0 off), w spare
  ext1: vec4<f32>,                                         // words 420-423: x multigrid correction weight, y APIC transfer (1 on), z w spare
  mgD: array<vec4<u32>, 4>,                                // words 424-439: multigrid's dense levels 4-7: size x, y, z and where they start in mg
  ext2: vec4<f32>,                                         // words 440-443: air turbulence: x size of the largest eddies (solver units), y octaves, z how fast it changes (/s), w swirl kept (vorticity confinement)
  ext3: vec4<f32>,                                         // words 444-447: x real air flow (1: carried along, incompressible), y water feels the air field (1), z drag on water (/s), w pressure sweeps
};
// a particle flying free of the grid (ballistic) keeps its white-water level in vel.w plus 2
const BALLISTIC: f32 = 1.5;
fn isBallistic(i: u32) -> bool { return vel[i].w >= BALLISTIC; }
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
@group(0) @binding(33) var<storage, read_write> sAux: array<vec4<f32>>;      // per whitewater point: water velocity there (xyz), how wet + 4 x (surface spreading in half steps per second) (w)
@group(0) @binding(34) var<storage, read_write> airAcc: array<atomic<i32>>;  // per air cell: momentum and weight pushed in this step (fixed point)
@group(0) @binding(35) var<storage, read_write> air2: array<vec4<f32>>;
@group(0) @binding(36) var<storage, read_write> drip: array<vec4<f32>>;
// the live view packed the way cache frames are stored (see packDisp): 16-bit positions across the box, a speed byte and a white-water byte
struct PackU { nW: u32, nS: u32, nD: u32, wFromPos: u32, srcS: u32, srcD: u32, oWp: u32, oWs: u32, oWf: u32, oSp: u32, oSk: u32, oDp: u32, oDs: u32, pad0: u32, pad1: u32, pad2: u32,
  x0: f32, y0: f32, z0: f32, kx: f32, ky: f32, kz: f32, vs: f32, pad4: f32,
  sx0: f32, sy0: f32, sz0: f32, skx: f32, sky: f32, skz: f32, pad5: f32, pad6: f32 };   // whitewater positions are across the whitewater area   // vs: metres per scene unit (speed bytes in 16ths of m/s)
@group(0) @binding(37) var<storage, read_write> packOut: array<u32>;
@group(0) @binding(39) var<storage, read_write> calm: array<u32>;   // per cell: steps in a row its pressure has needed no change (settleMark)
@group(0) @binding(40) var<storage, read_write> mg: array<f32>;   // multigrid levels (wgsl-multigrid.js)
@group(0) @binding(41) var<storage, read_write> dpres: array<f32>;   // per cell: the separation potential (sepRelax), whose gradient moves particles apart
@group(0) @binding(42) var<storage, read_write> aff: array<vec4<f32>>;
@group(0) @binding(44) var<storage, read_write> taff: array<vec4<f32>>;
@group(0) @binding(45) var<storage, read_write> fmax: array<atomic<u32>>;
// the water's surface from the particles (surfSplat, surfPhi): per cell the summed weights and weighted offsets of the particles around its
// centre (4 numbers, fixed point), and the distance from its centre to the surface in cells (negative in water)
@group(0) @binding(46) var<storage, read_write> sacc: array<atomic<i32>>;
@group(0) @binding(47) var<storage, read_write> sphi: array<f32>;   // the fastest particle at the end of a frame (speedMax)   // the sort's second copy of the APIC rows   // APIC: per particle three rows (x, y, z velocity), each how that velocity changes across space
@group(0) @binding(38) var<uniform> PK: PackU;      // per drip sample: (local position, collider), (local normal, wetness)   // the grid velocity kept from the last step (narrow band)

fn colSize(k: u32) -> f32 { let s = cols[k * 8u + 5u].w; return select(1.0, s, s > 0.0); }
fn sdfEval(k: u32, p: vec3<f32>) -> vec4<f32> {
  let a = cols[k * 8u]; let b = cols[k * 8u + 1u];
  let r0 = cols[k * 8u + 2u].xyz; let r1 = cols[k * 8u + 3u].xyz; let r2 = cols[k * 8u + 4u].xyz;
  let d = p - cols[k * 8u + 5u].xyz;
  let lp = vec3<f32>(dot(r0, d), dot(r1, d), dot(r2, d));
  let g = (lp - b.xyz) / b.w;
  let dims = a.yzw;
  let gc = clamp(g, vec3<f32>(0.0), dims - vec3<f32>(1.0001));
  let fl = floor(gc); let f = gc - fl;
  let nx = u32(a.y); let ny = u32(a.z);
  let base = u32(a.x) + u32(fl.x) + nx * (u32(fl.y) + ny * u32(fl.z));
  let s = nx * ny;
  let v000 = sdf[base]; let v100 = sdf[base + 1u]; let v010 = sdf[base + nx]; let v110 = sdf[base + nx + 1u];
  let v001 = sdf[base + s]; let v101 = sdf[base + s + 1u]; let v011 = sdf[base + s + nx]; let v111 = sdf[base + s + nx + 1u];
  let c00 = mix(v000, v100, f.x); let c10 = mix(v010, v110, f.x); let c01 = mix(v001, v101, f.x); let c11 = mix(v011, v111, f.x);
  let c0 = mix(c00, c10, f.y); let c1 = mix(c01, c11, f.y);
  var phi = mix(c0, c1, f.z);
  let out = g - gc;
  var gl: vec3<f32>;
  if (dot(out, out) > 0.0) {
    let l = length(out); phi += l * b.w; gl = out / l;
  } else {
    gl = vec3<f32>(mix(mix(v100 - v000, v110 - v010, f.y), mix(v101 - v001, v111 - v011, f.y), f.z), mix(c10 - c00, c11 - c01, f.z), c1 - c0);
    let l = length(gl); gl = gl / max(l, 1e-9);
  }
  let wn = r0 * gl.x + r1 * gl.y + r2 * gl.z;
  return vec4<f32>(phi * colSize(k), wn / max(length(wn), 1e-9));
}
// world velocity of the collider's surface at p
// (a growing shape adds, per own axis i, column i of R times the rate of size i times the point's unscaled coordinate i:
// with row i = column i / size i that is row i (row i . d) size i rate i, and w holds size i rate i)
fn colSurfVel(k: u32, p: vec3<f32>) -> vec3<f32> {
  let c = cols[k * 8u + 5u].xyz; let d = p - c;
  let r0 = cols[k * 8u + 2u]; let r1 = cols[k * 8u + 3u]; let r2 = cols[k * 8u + 4u];
  let grow = r0.xyz * (dot(r0.xyz, d) * r0.w) + r1.xyz * (dot(r1.xyz, d) * r1.w) + r2.xyz * (dot(r2.xyz, d) * r2.w);
  return cols[k * 8u + 6u].xyz + cross(cols[k * 8u + 7u].xyz, d) + grow;
}


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
  if (j < tallT()) { return 1u; }
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
  let m = P.q0 / (b.w * colSize(k));   // the margin in grid cells (the grid's cells are b.w times the object's size)
  return all(g > vec3<f32>(-1.0 - m)) && all(g < dims + vec3<f32>(m));
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
// inside the tank (the water's box); whitewater can also be outside it, in the larger whitewater area, where there is only air
fn inTank(p: vec3<f32>) -> bool { return p.x >= P.x0 && p.y >= P.y0 && p.z >= P.z0 && p.x <= P.x1 && p.y <= P.y1 && p.z <= P.z1; }
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
// the new grid velocity alone (reads only accV, for kernels that cannot also bind accW)
fn sampleNew(p: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(sampleAxis(p, 0u), sampleAxis(p, 1u), sampleAxis(p, 2u));
}
// one component of the new grid velocity at p (8 faces instead of 24, when only that one is needed)
fn sampleAxis(p: vec3<f32>, axis: u32) -> f32 {
  var g = (p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih;
  if (axis == 0u) { g.y -= 0.5; g.z -= 0.5; } else if (axis == 1u) { g.x -= 0.5; g.z -= 0.5; } else { g.x -= 0.5; g.y -= 0.5; }
  let f0 = floor(g); let fr = g - f0; let i0 = vec3<i32>(f0);
  var sn = 0.0;
  for (var c = 0u; c < 8u; c++) {
    let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
    sn += w * gvR(faceIndex(axis, i0.x + dx, i0.y + dy, i0.z + dz));
  }
  return sn;
}

// ---- narrow band and ocean helpers ----
// Narrow band: particles live only in a band of cells under the surface. A depth field (phi, in cells, negative in water) is kept
// per cell in the top 16 bits of ctype; deep water below the band has no particles and moves with the grid velocity, which is kept
// from step to step in velG.
fn colBits(c: u32) -> u32 { return (ctype[c] >> 8u) & 0xffu; }
fn phiOf(c: u32) -> f32 { return 8.0 - f32(ctype[c] >> 16u) / 4096.0; }
fn phiPut(c: u32, v: f32) { let q = u32(clamp(round((8.0 - v) * 4096.0), 0.0, 65535.0)); ctype[c] = (ctype[c] & 0xffffu) | (q << 16u); }
fn inDom(p: vec3<i32>) -> bool { return p.x >= 0 && p.y >= 0 && p.z >= 0 && p.x < i32(P.nx) && p.y < i32(P.ny) && p.z < i32(P.nz); }
fn phiCell(p: vec3<i32>) -> f32 { if (!inDom(p)) { return 8.0; } if (p.y < tallT()) { return -7.9; } return phiOf(cellIdx(p.x, p.y, p.z)); }
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
    if (i0.y + dy < tallT()) { if (w > 0.0) { s += w * -7.9; ws += w; } continue; }
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
    s += w * velGF(axis, i0 + vec3<i32>(dx, dy, dz));
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
  for (var tk = lo.z; tk <= hi.z; tk++) { for (var tj = max(lo.y, tallT() >> 3u); tj <= hi.y; tj++) { for (var ti = lo.x; ti <= hi.x; ti++) {
    let t = u32(ti) + P.tx * (u32(tj) + P.ty * u32(tk));
    if (atomicLoad(&need[t]) == 0u) { atomicStore(&need[t], 1u); }
  } } }
}

