// WebGPU version of the same position based fluid solver. Mirrors FluidSim, including the boundary density.

// shared by the PBF and FLIP shaders. cols holds 8 vec4 per collider, sdf all distance grids back to back.
// (off nx ny nz) (origin cell) (Rt row 0) (Rt row 1) (Rt row 2) (position) (velocity) (angular velocity)
const SDF_WGSL = /* wgsl */ `
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
  return vec4<f32>(phi, wn);
}
// world velocity of the collider's surface at p
fn colSurfVel(k: u32, p: vec3<f32>) -> vec3<f32> {
  let c = cols[k * 8u + 5u].xyz;
  return cols[k * 8u + 6u].xyz + cross(cols[k * 8u + 7u].xyz, p - c);
}
`;

// packs the colliders of one step into sim.cf (32 floats each) and uploads their distance grids when the set changed
function packColliders(sim, cols) {
  const nc = Math.min(cols.length, 32), cf = sim.cf;
  let sig = '', off = 0; const offs = new Map();
  for (let k = 0; k < nc; k++) { const sd = cols[k].sdf; if (!offs.has(sd.id)) { offs.set(sd.id, off); off += sd.data.length; sig += sd.id + ','; } }
  if (sig !== sim.sdfSig) {
    if (off > sim.sdfCap) {
      if (sim.bSdf) sim.bSdf.destroy();
      sim.sdfCap = Math.ceil(off * 1.3);
      sim.bSdf = sim.dev.createBuffer({ size: sim.sdfCap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      sim.makeGroups();
    }
    const seen = new Set();
    for (let k = 0; k < nc; k++) { const sd = cols[k].sdf; if (seen.has(sd.id)) continue; seen.add(sd.id); sim.dev.queue.writeBuffer(sim.bSdf, offs.get(sd.id) * 4, sd.data); }
    sim.sdfSig = sig;
  }
  for (let k = 0; k < nc; k++) {
    const c = cols[k], sd = c.sdf, R = c.R, j = k * 32;
    cf[j] = offs.get(sd.id); cf[j + 1] = sd.dims[0]; cf[j + 2] = sd.dims[1]; cf[j + 3] = sd.dims[2];
    cf[j + 4] = sd.origin[0]; cf[j + 5] = sd.origin[1]; cf[j + 6] = sd.origin[2]; cf[j + 7] = sd.cell;
    cf[j + 8] = R[0]; cf[j + 9] = R[3]; cf[j + 10] = R[6]; cf[j + 11] = 0;
    cf[j + 12] = R[1]; cf[j + 13] = R[4]; cf[j + 14] = R[7]; cf[j + 15] = 0;
    cf[j + 16] = R[2]; cf[j + 17] = R[5]; cf[j + 18] = R[8]; cf[j + 19] = 0;
    cf[j + 20] = c.x; cf[j + 21] = c.y; cf[j + 22] = c.z; cf[j + 23] = 0;
    cf[j + 24] = c.vx; cf[j + 25] = c.vy; cf[j + 26] = c.vz; cf[j + 27] = 0;
    cf[j + 28] = c.wx; cf[j + 29] = c.wy; cf[j + 30] = c.wz; cf[j + 31] = 0;
  }
  if (nc) sim.dev.queue.writeBuffer(sim.bCols, 0, cf, 0, nc * 32);
  return nc;
}

const GPU_WGSL = /* wgsl */ `
struct Params {
  n: u32, nx: u32, ny: u32, nz: u32,
  ncols: u32, open: u32, pad1: u32, pad2: u32,
  dt: f32, h: f32, h2: f32, d: f32,
  rho0: f32, poly: f32, spiky: f32, W0: f32,
  eps: f32, c0: f32, Gh: f32, margin: f32,
  gravity: f32, visc: f32, rest: f32, relax: f32,
  bx0: f32, bx1: f32, by0: f32, by1: f32,
  bz0: f32, bz1: f32, maxD: f32, vmax: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> prd: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dlt: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> bgr: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> vel2: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> lam: array<f32>;
@group(0) @binding(8) var<storage, read_write> cid: array<u32>;
@group(0) @binding(9) var<storage, read_write> ccount: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> cstart: array<u32>;
@group(0) @binding(11) var<storage, read_write> sorted: array<u32>;
@group(0) @binding(12) var<storage, read_write> ccursor: array<atomic<u32>>;
@group(0) @binding(13) var<storage, read> cols: array<vec4<f32>>;
@group(0) @binding(14) var<storage, read> sdf: array<f32>;
${SDF_WGSL}
const DEADY: f32 = -1.0e5;
const DEADC: u32 = 0xffffffffu;

fn collide(pin: vec3<f32>) -> vec3<f32> {
  var p = pin;
  let m = P.margin;
  for (var k = 0u; k < P.ncols; k++) {
    let e = sdfEval(k, p);
    if (e.x < m) { p += e.yzw * (m - e.x); }
  }
  let big = 1.0e9;
  let lo = vec3<f32>(select(P.bx0 + m, -big, (P.open & 1u) != 0u), select(P.by0 + m, -big, (P.open & 4u) != 0u), select(P.bz0 + m, -big, (P.open & 16u) != 0u));
  let hi = vec3<f32>(select(P.bx1 - m, big, (P.open & 2u) != 0u), select(P.by1 - m, big, (P.open & 8u) != 0u), select(P.bz1 - m, big, (P.open & 32u) != 0u));
  return clamp(p, lo, hi);
}

fn Gf(s: f32) -> f32 {
  let h2 = P.h2; let h4 = h2 * h2; let h6 = h4 * h2; let h8 = h4 * h4;
  let s2 = s * s; let s3 = s2 * s; let s5 = s3 * s2; let s7 = s5 * s2; let s9 = s7 * s2;
  return h8 * s - (4.0 / 3.0) * h6 * s3 + (6.0 / 5.0) * h4 * s5 - (4.0 / 7.0) * h2 * s7 + s9 / 9.0;
}
// (density, d density / d distance) of a solid surface at distance phi
fn surf(phi0: f32) -> vec2<f32> {
  let p = max(phi0, 0.0);
  let t = P.h2 - p * p;
  let t2 = t * t;
  return vec2<f32>(P.c0 * (P.Gh - Gf(p)), -P.c0 * t2 * t2);
}
fn bnd(x: vec3<f32>) -> vec4<f32> {
  let h = P.h;
  var rho = 0.0;
  var g = vec3<f32>(0.0);
  var ph = x.x - P.bx0; if ((P.open & 1u) == 0u && ph < h) { let r = surf(ph); rho += r.x; g.x += r.y; }
  ph = P.bx1 - x.x; if ((P.open & 2u) == 0u && ph < h) { let r = surf(ph); rho += r.x; g.x -= r.y; }
  ph = x.y - P.by0; if ((P.open & 4u) == 0u && ph < h) { let r = surf(ph); rho += r.x; g.y += r.y; }
  ph = P.by1 - x.y; if ((P.open & 8u) == 0u && ph < h) { let r = surf(ph); rho += r.x; g.y -= r.y; }
  ph = x.z - P.bz0; if ((P.open & 16u) == 0u && ph < h) { let r = surf(ph); rho += r.x; g.z += r.y; }
  ph = P.bz1 - x.z; if ((P.open & 32u) == 0u && ph < h) { let r = surf(ph); rho += r.x; g.z -= r.y; }
  for (var k = 0u; k < P.ncols; k++) {
    let e = sdfEval(k, x);
    if (e.x >= h) { continue; }
    let r = surf(e.x);
    rho += r.x;
    g += e.yzw * r.y;
  }
  return vec4<f32>(rho, g);
}
fn cellOf(p: vec3<f32>) -> u32 {
  let inv = 1.0 / P.h;
  let cx = clamp(i32((p.x - P.bx0) * inv), 0, i32(P.nx) - 1);
  let cy = clamp(i32((p.y - P.by0) * inv), 0, i32(P.ny) - 1);
  let cz = clamp(i32((p.z - P.bz0) * inv), 0, i32(P.nz) - 1);
  return u32(cx) + P.nx * (u32(cy) + P.ny * u32(cz));
}

@compute @workgroup_size(64)
fn predict(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (pos[i].y < DEADY) { prd[i] = pos[i]; return; }
  let v = vel[i].xyz + vec3<f32>(0.0, -P.gravity * P.dt, 0.0);
  vel[i] = vec4<f32>(v, 0.0);
  prd[i] = vec4<f32>(collide(pos[i].xyz + v * P.dt), 0.0);
}
@compute @workgroup_size(64)
fn clearGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x; if (c >= P.nx * P.ny * P.nz) { return; }
  atomicStore(&ccount[c], 0u);
}
@compute @workgroup_size(64)
fn countCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (prd[i].y < DEADY) { cid[i] = DEADC; return; }
  let c = cellOf(prd[i].xyz);
  cid[i] = c;
  atomicAdd(&ccount[c], 1u);
}
var<workgroup> sums: array<u32, 256>;
@compute @workgroup_size(256)
fn scanCells(@builtin(local_invocation_id) lid3: vec3<u32>) {
  let lid = lid3.x;
  let cells = P.nx * P.ny * P.nz;
  let chunk = (cells + 255u) / 256u;
  let start = min(lid * chunk, cells);
  let end = min(start + chunk, cells);
  var s = 0u;
  for (var c = start; c < end; c++) { s += atomicLoad(&ccount[c]); }
  sums[lid] = s;
  workgroupBarrier();
  if (lid == 0u) {
    var acc = 0u;
    for (var k = 0u; k < 256u; k++) { let v = sums[k]; sums[k] = acc; acc += v; }
    cstart[cells] = acc;
  }
  workgroupBarrier();
  var run = sums[lid];
  for (var c = start; c < end; c++) {
    cstart[c] = run;
    atomicStore(&ccursor[c], run);
    run += atomicLoad(&ccount[c]);
  }
}
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (cid[i] == DEADC) { return; }
  let idx = atomicAdd(&ccursor[cid[i]], 1u);
  sorted[idx] = i;
}

@compute @workgroup_size(64)
fn lambda(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (cid[i] == DEADC) { return; }
  let qi = prd[i].xyz;
  let irho = 1.0 / P.rho0;
  var rho = P.W0;
  var g = vec3<f32>(0.0);
  var sg = 0.0;
  let c = cid[i];
  let cx = i32(c % P.nx); let t = c / P.nx; let cy = i32(t % P.ny); let cz = i32(t / P.ny);
  let xa = u32(max(cx - 1, 0)); let xb = u32(min(cx + 1, i32(P.nx) - 1));
  for (var z = max(cz - 1, 0); z <= min(cz + 1, i32(P.nz) - 1); z++) {
    for (var y = max(cy - 1, 0); y <= min(cy + 1, i32(P.ny) - 1); y++) {
      let row = P.nx * u32(y + i32(P.ny) * z);
      let s1 = cstart[row + xb + 1u];
      for (var s = cstart[row + xa]; s < s1; s++) {
        let j = sorted[s];
        if (j == i) { continue; }
        let dd = qi - prd[j].xyz;
        let r2 = dot(dd, dd);
        if (r2 >= P.h2) { continue; }
        let tt = P.h2 - r2;
        rho += P.poly * tt * tt * tt;
        let r = sqrt(r2);
        if (r < 1e-7) { continue; }
        let hr = P.h - r;
        let f = P.spiky * hr * hr / r * irho;
        let fv = f * dd;
        g += fv;
        sg += dot(fv, fv);
      }
    }
  }
  let b = bnd(qi);
  rho += b.x;
  let bg = b.yzw * irho;
  bgr[i] = vec4<f32>(bg, 0.0);
  g += bg;
  sg += dot(bg, bg);
  let C = rho * irho - 1.0;
  lam[i] = select(0.0, -C / (sg + dot(g, g) + P.eps), C > 0.0);
}

@compute @workgroup_size(64)
fn delta(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (cid[i] == DEADC) { return; }
  let qi = prd[i].xyz;
  let irho = 1.0 / P.rho0;
  let li = lam[i];
  var s = li * bgr[i].xyz;
  let c = cid[i];
  let cx = i32(c % P.nx); let t = c / P.nx; let cy = i32(t % P.ny); let cz = i32(t / P.ny);
  let xa = u32(max(cx - 1, 0)); let xb = u32(min(cx + 1, i32(P.nx) - 1));
  for (var z = max(cz - 1, 0); z <= min(cz + 1, i32(P.nz) - 1); z++) {
    for (var y = max(cy - 1, 0); y <= min(cy + 1, i32(P.ny) - 1); y++) {
      let row = P.nx * u32(y + i32(P.ny) * z);
      let s1 = cstart[row + xb + 1u];
      for (var q = cstart[row + xa]; q < s1; q++) {
        let j = sorted[q];
        if (j == i) { continue; }
        let sj = li + lam[j];
        if (sj == 0.0) { continue; }
        let dd = qi - prd[j].xyz;
        let r2 = dot(dd, dd);
        if (r2 >= P.h2) { continue; }
        let r = sqrt(r2);
        if (r < 1e-7) { continue; }
        let hr = P.h - r;
        s += (P.spiky * hr * hr / r * irho * sj) * dd;
      }
    }
  }
  s = s * P.relax;
  let m2 = dot(s, s);
  if (m2 > P.maxD * P.maxD) { s = s * (P.maxD * inverseSqrt(m2)); }
  dlt[i] = vec4<f32>(s, 0.0);
}
@compute @workgroup_size(64)
fn applyDelta(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (cid[i] == DEADC) { return; }
  prd[i] = vec4<f32>(collide(prd[i].xyz + dlt[i].xyz), 0.0);
}
@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (pos[i].y < DEADY) { vel2[i] = vec4<f32>(0.0); return; }
  let p = pos[i].xyz;
  let q = prd[i].xyz;
  let vo = vel[i].xyz;
  var v = (q - p) / P.dt;
  let g = bgr[i].xyz;
  let gm2 = dot(g, g);
  if (gm2 > 1e-6) {
    let nrm = -g * inverseSqrt(gm2);
    let vn0 = dot(vo, nrm);
    if (vn0 < 0.0) {
      let vn = dot(v, nrm);
      let lim = -vn0 * P.rest;
      if (vn > lim) { v = v - (vn - lim) * nrm; }
    }
  }
  let s2 = dot(v, v);
  if (s2 > P.vmax * P.vmax) { v = v * (P.vmax * inverseSqrt(s2)); }
  vel2[i] = vec4<f32>(v, 0.0);
  let o = P.open;
  if (o != 0u && (((o & 1u) != 0u && q.x < P.bx0) || ((o & 2u) != 0u && q.x > P.bx1) || ((o & 4u) != 0u && q.y < P.by0) ||
      ((o & 8u) != 0u && q.y > P.by1) || ((o & 16u) != 0u && q.z < P.bz0) || ((o & 32u) != 0u && q.z > P.bz1))) {
    pos[i] = vec4<f32>(0.0, -1.0e6, 0.0, 0.0); vel2[i] = vec4<f32>(0.0);
    return;
  }
  pos[i] = vec4<f32>(q, 0.0);
}
@compute @workgroup_size(64)
fn viscosity(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= P.n) { return; }
  if (pos[i].y < DEADY) { vel[i] = vec4<f32>(0.0); return; }
  let pi = pos[i].xyz;
  let vi = vel2[i].xyz;
  let irho = 1.0 / P.rho0;
  var a = vec3<f32>(0.0);
  if (P.visc > 0.0) {
    let c = cid[i];
    let cx = i32(c % P.nx); let t = c / P.nx; let cy = i32(t % P.ny); let cz = i32(t / P.ny);
    let xa = u32(max(cx - 1, 0)); let xb = u32(min(cx + 1, i32(P.nx) - 1));
    for (var z = max(cz - 1, 0); z <= min(cz + 1, i32(P.nz) - 1); z++) {
      for (var y = max(cy - 1, 0); y <= min(cy + 1, i32(P.ny) - 1); y++) {
        let row = P.nx * u32(y + i32(P.ny) * z);
        let s1 = cstart[row + xb + 1u];
        for (var q = cstart[row + xa]; q < s1; q++) {
          let j = sorted[q];
          if (j == i) { continue; }
          let dd = pi - pos[j].xyz;
          let r2 = dot(dd, dd);
          if (r2 >= P.h2) { continue; }
          let tt = P.h2 - r2;
          a += (vel2[j].xyz - vi) * (P.poly * tt * tt * tt * irho);
        }
      }
    }
  }
  let nv = vi + P.visc * a;
  vel[i] = vec4<f32>(nv, 0.0);
  pos[i].w = length(nv);
}
`;

class GpuSim {
  constructor(device, opt) {
    const c = new FluidSim({ d: opt.d, maxN: 1, size: opt.size, open: opt.open });
    this.c = c; this.dev = device; this.d = c.d; this.h = c.h; this.b = c.b;
    this.MAXN = opt.maxN; this.cap = opt.maxN; this.N = 0; this.ring = 0; this.recycle = true;
    this.cells = c.nx * c.ny * c.nz; this.busy = false; this.needRead = true; this.lastMs = 0; this.outN = 0;
    this.out = opt.out || null;
    const M = this.MAXN, U = GPUBufferUsage;
    const mk = (size, extra) => device.createBuffer({ size: Math.max(size, 16), usage: U.STORAGE | U.COPY_SRC | U.COPY_DST | (extra || 0) });
    this.bPos = mk(M * 16); this.bVel = mk(M * 16); this.bPrd = mk(M * 16); this.bDlt = mk(M * 16);
    this.bBg = mk(M * 16); this.bVel2 = mk(M * 16); this.bLam = mk(M * 4); this.bCid = mk(M * 4); this.bSorted = mk(M * 4);
    this.bCount = mk(this.cells * 4); this.bStart = mk((this.cells + 1) * 4); this.bCursor = mk(this.cells * 4);
    this.bCols = mk(32 * 128);
    this.sdfCap = 16; this.sdfSig = null; this.bSdf = mk(64);
    this.bParams = device.createBuffer({ size: 128, usage: U.UNIFORM | U.COPY_DST });
    this.stage = device.createBuffer({ size: M * 16, usage: U.MAP_READ | U.COPY_DST });
    this.pS = new Float32Array(M * 4); this.vS = new Float32Array(M * 4);
    this.runStart = 0; this.runLen = 0;
    this.pu = new ArrayBuffer(128); this.pu32 = new Uint32Array(this.pu); this.pf32 = new Float32Array(this.pu);
    this.cf = new Float32Array(32 * 32);
    const mod = device.createShaderModule({ code: GPU_WGSL });
    this.L = { predict: [0, 1, 2, 3, 13, 14], clearGrid: [0, 9], countCells: [0, 3, 8, 9], scanCells: [0, 9, 10, 12], scatter: [0, 8, 11, 12],
      lambda: [0, 3, 5, 7, 8, 10, 11, 13, 14], delta: [0, 3, 4, 5, 7, 8, 10, 11], applyDelta: [0, 3, 4, 8, 13, 14], finalize: [0, 1, 2, 3, 5, 6], viscosity: [0, 1, 2, 6, 8, 10, 11] };
    this.pipes = {};
    for (const name in this.L) this.pipes[name] = { pipeline: device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: name } }) };
    this.makeGroups();
  }
  makeGroups() {
    const bufs = { 0: this.bParams, 1: this.bPos, 2: this.bVel, 3: this.bPrd, 4: this.bDlt, 5: this.bBg, 6: this.bVel2, 7: this.bLam, 8: this.bCid, 9: this.bCount, 10: this.bStart, 11: this.bSorted, 12: this.bCursor, 13: this.bCols, 14: this.bSdf };
    for (const name in this.L) { const p = this.pipes[name]; p.bg = this.dev.createBindGroup({ layout: p.pipeline.getBindGroupLayout(0), entries: this.L[name].map((k) => ({ binding: k, resource: { buffer: bufs[k] } })) }); }
  }
  setCap(c) { this.cap = Math.min(c, this.MAXN); if (this.N > this.cap) this.N = this.cap; if (this.ring >= this.cap) this.ring = 0; this.needRead = true; }
  clear() { this.flushRun(); this.N = 0; this.ring = 0; this.needRead = true; this.outSeqDone = this.rseq || 0; this.outN = 0; this.gen = (this.gen || 0) + 1; }
  add(x, y, z, vx, vy, vz) {
    let i;
    if (this.N < this.cap) i = this.N++;
    else if (this.recycle) { i = this.ring++; if (this.ring >= this.cap) this.ring = 0; }
    else return false;
    const o = i * 4;
    this.pS[o] = x; this.pS[o + 1] = y; this.pS[o + 2] = z; this.pS[o + 3] = Math.sqrt(vx * vx + vy * vy + vz * vz);
    this.vS[o] = vx; this.vS[o + 1] = vy; this.vS[o + 2] = vz; this.vS[o + 3] = 0;
    if (this.runLen > 0 && i === this.runStart + this.runLen) this.runLen++;
    else { this.flushRun(); this.runStart = i; this.runLen = 1; }
    this.needRead = true;
    return true;
  }
  flushRun() {
    if (!this.runLen) return;
    this.dev.queue.writeBuffer(this.bPos, this.runStart * 16, this.pS, this.runStart * 4, this.runLen * 4);
    this.dev.queue.writeBuffer(this.bVel, this.runStart * 16, this.vS, this.runStart * 4, this.runLen * 4);
    this.runLen = 0;
  }
  step(dt, o) {
    this.flushRun();
    const N = this.N; if (N === 0) return;
    const c = this.c, u32 = this.pu32, f32 = this.pf32, b = this.b;
    const nc = packColliders(this, o.cols);
    u32[0] = N; u32[1] = c.nx; u32[2] = c.ny; u32[3] = c.nz; u32[4] = nc; u32[5] = c.open; u32[6] = 0; u32[7] = 0;
    const F = [dt, c.h, c.h2, c.d, c.rho0, c.poly, c.spiky, c.W0, c.eps, c.c0, c.Gh, c.margin, o.g, o.visc, c.restitution, c.relax, b.x0, b.x1, b.y0, b.y1, b.z0, b.z1, 0.5 * c.d, 12];
    for (let k = 0; k < 24; k++) f32[8 + k] = F[k];
    this.dev.queue.writeBuffer(this.bParams, 0, this.pu);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    const wg = Math.ceil(N / 64), wc = Math.ceil(this.cells / 64);
    const run = (name, groups) => { const p = this.pipes[name]; pass.setPipeline(p.pipeline); pass.setBindGroup(0, p.bg); pass.dispatchWorkgroups(groups); };
    run('predict', wg); run('clearGrid', wc); run('countCells', wg); run('scanCells', 1); run('scatter', wg);
    for (let it = 0; it < o.iters; it++) { run('lambda', wg); run('delta', wg); run('applyDelta', wg); }
    run('finalize', wg); run('viscosity', wg);
    pass.end();
    this.dev.queue.submit([enc.finish()]);
    this.needRead = true; this.track();
  }
  // copy particle state back to the CPU. Position in xyz, speed in w.
  readbackInto(dst) {
    this.flushRun();
    const n = this.N, bytes = Math.max(n, 1) * 16;
    if (!this.stage) this.stage = this.dev.createBuffer({ size: Math.max(this.MAXN * 16, 16), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.bPos, 0, this.stage, 0, bytes);
    this.dev.queue.submit([enc.finish()]);
    this.needRead = false;
    return this.stage.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
      if (n > 0) dst.set(new Float32Array(this.stage.getMappedRange(0, bytes)).subarray(0, n * 4));
      this.stage.unmap();
      return n;
    });
  }
  // how many steps are still queued on the GPU, and a running average of the time one step really takes
  track() {
    const t = performance.now(); this.inflight = (this.inflight || 0) + 1;
    const start = Math.max(t, this.lastDone || 0);
    this.dev.queue.onSubmittedWorkDone().then(() => {
      const n = performance.now(); this.inflight--; const ms = n - start; this.lastDone = n;
      this.lastMs = this.lastMs ? this.lastMs * 0.9 + ms * 0.1 : ms;
    });
  }
  // live view: up to three readbacks in flight, so stepping never waits for the copy to the CPU. The newest finished copy is shown.
  pump() {
    if (!this.needRead || !this.out) return;
    if (!this.rs) this.rs = [0, 1, 2].map(() => ({ buf: this.dev.createBuffer({ size: Math.max((this.ringCap || this.MAXN) * 16, 16), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }));
    const s = this.rs.find((q) => !q.busy); if (!s) return;
    this.flushRun();
    const enc = this.dev.createCommandEncoder();
    const src = this.dispSource ? this.dispSource(enc) : { buf: this.bPos, n: this.N };
    const n = src.n, bytes = Math.max(n, 1) * 16, seq = this.rseq = (this.rseq || 0) + 1;
    enc.copyBufferToBuffer(src.buf, 0, s.buf, 0, bytes);
    this.dev.queue.submit([enc.finish()]);
    this.needRead = false; s.busy = true;
    s.buf.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
      if (!this.dead && seq > (this.outSeqDone || 0)) {
        if (n > 0) this.out.set(new Float32Array(s.buf.getMappedRange(0, bytes)).subarray(0, n * 4));
        this.outN = this.rawOut ? n : compactLive(this.out, n); this.outSeqDone = seq; this.gen = (this.gen || 0) + 1;
      }
      s.buf.unmap(); s.busy = false;
    }).catch(() => { s.busy = false; });
  }
  destroy() { this.dead = true; [this.bPos, this.bVel, this.bPrd, this.bDlt, this.bBg, this.bVel2, this.bLam, this.bCid, this.bSorted, this.bCount, this.bStart, this.bCursor, this.bCols, this.bSdf, this.bParams, this.stage].forEach((b) => b.destroy()); (this.rs || []).forEach((q) => q.buf.destroy()); }
}
GpuSim.prototype.fillBox = FluidSim.prototype.fillBox;
GpuSim.prototype.fillSphere = FluidSim.prototype.fillSphere;

// drop particles that left the box (parked at y < -1e5), in place, 4 floats per particle
function compactLive(buf, n) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    if (buf[k + 1] < -1e5) continue;
    if (w !== i) { const j = w * 4; buf[j] = buf[k]; buf[j + 1] = buf[k + 1]; buf[j + 2] = buf[k + 2]; buf[j + 3] = buf[k + 3]; }
    w++;
  }
  return w;
}

async function initGpu() {
  try {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const lim = adapter.limits;
    const dev = await adapter.requestDevice({ requiredLimits: {
      maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 1 << 29),
      maxBufferSize: Math.min(lim.maxBufferSize, 1 << 29)
    } });
    const log = (m) => { (window.__errLog = window.__errLog || []).push({ t: new Date().toISOString(), msg: String(m).slice(0, 400) }); };
    dev.addEventListener('uncapturederror', (ev) => log('GPU: ' + (ev.error && ev.error.message)));
    dev.lost.then((info) => log('GPU device lost: ' + info.reason + ' ' + info.message));
    let name = 'GPU';
    try { const info = adapter.info || (adapter.requestAdapterInfo && await adapter.requestAdapterInfo()); if (info) name = info.description || info.device || info.vendor || 'GPU'; } catch (e) { /* ignore */ }
    return { dev, name, maxBuf: dev.limits.maxStorageBufferBindingSize };
  } catch (e) { return null; }
}

// narrow band look only: deep water points (x, y, z, 4096 + speed) -> positions across the box and speed in 16ths
function packDeep(p, n, b) {
  const pos = new Uint16Array(n * 3), spd = new Uint8Array(n);
  const kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const i4 = i * 4; if (p[i4 + 1] <= -1e5) continue;
    pos[k * 3] = Math.max(0, Math.min(65535, Math.round((p[i4] - b.x0) * kx))); pos[k * 3 + 1] = Math.max(0, Math.min(65535, Math.round((p[i4 + 1] - b.y0) * ky)));
    pos[k * 3 + 2] = Math.max(0, Math.min(65535, Math.round((p[i4 + 2] - b.z0) * kz)));
    const s = (p[i4 + 3] - 4096) * 16; spd[k++] = s > 191 ? 191 : Math.max(0, s);
  }
  return { n: k, pos: k < n ? pos.slice(0, k * 3) : pos, spd: k < n ? spd.slice(0, k) : spd };
}
function packFrameBuf(buf, n, b, states) {
  const U = new Uint32Array(buf.buffer, buf.byteOffset, buf.length);
  // spray points from the live view go to their own list, and so do deep water points (narrow band, look only); the empty slots after the water are dropped
  let ns = 0, last = -1, nd = 0, d0 = -1;
  for (let i = 0; i < n; i++) { if (buf[i * 4 + 1] <= -1e5) continue; if (U[i * 4 + 3] >= 0x80000000) ns++; else if (buf[i * 4 + 3] >= 4096) { nd++; if (d0 < 0) d0 = i; } else last = i; }
  const dp = nd ? packDeep(buf.subarray(d0 * 4, n * 4), n - d0, b) : null;
  const nAll = n; n = last + 1;
  const pos = new Uint16Array(n * 3), spd = new Uint8Array(n), fm = new Uint8Array(n);
  const sp = ns ? { n: ns, pos: new Uint16Array(ns * 3), pk: new Uint32Array(ns), alive: ns } : null; let si = 0;
  let anyFoam = false;
  const kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0);
  for (let i = 0; i < nAll; i++) {
    const i4 = i * 4, i3 = i * 3, inW = i < n;
    if (buf[i4 + 1] < -1e5) { if (inW) spd[i] = 255; continue; }
    if (buf[i4 + 3] >= 4096 && U[i4 + 3] < 0x80000000) { if (inW) spd[i] = 255; continue; }
    if (U[i4 + 3] >= 0x80000000) {
      if (inW) spd[i] = 255;
      sp.pos[si * 3] = Math.max(0, Math.min(65535, Math.round((buf[i4] - b.x0) * kx))); sp.pos[si * 3 + 1] = Math.max(0, Math.min(65535, Math.round((buf[i4 + 1] - b.y0) * ky)));
      sp.pos[si * 3 + 2] = Math.max(0, Math.min(65535, Math.round((buf[i4 + 2] - b.z0) * kz))); sp.pk[si++] = U[i4 + 3];
      continue;
    }
    pos[i3] = Math.max(0, Math.min(65535, Math.round((buf[i4] - b.x0) * kx)));
    pos[i3 + 1] = Math.max(0, Math.min(65535, Math.round((buf[i4 + 1] - b.y0) * ky)));
    pos[i3 + 2] = Math.max(0, Math.min(65535, Math.round((buf[i4 + 2] - b.z0) * kz)));
    // the solver packs speed (below 64) and a white water level (0 to 15) into one number
    const w = buf[i4 + 3], lv = Math.floor(w / 64), spv = w - lv * 64;
    const s = spv * 16; spd[i] = s > 191 ? 191 : s;
    if (lv) { fm[i] = lv * 17; anyFoam = true; }
  }
  const objs = packObjs(states);
  const fr = anyFoam ? { n, pos, spd, fm, objs } : { n, pos, spd, objs };
  if (sp) fr.sp = sp;
  if (dp && dp.n) fr.dp = dp;
  return fr;
}

// Same contract as runBake, but the solver runs on the GPU from the page.
async function runBakeGpu(desc, gpu, onFrame, isCancelled) {
  const sim = new GpuSim(gpu.dev, { d: desc.d, maxN: desc.maxN, size: desc.size, open: desc.open });
  sim.recycle = false; sim.cap = desc.maxN;
  const runner = new SceneRunner(sim);
  for (const f of desc.fills) {
    if (f.t === 'box') sim.fillBox(f.x0, f.x1, f.y0, f.y1, f.z0, f.z1);
    else if (f.t === 'vol') fillVolume(sim, f);
    else sim.fillSphere(f.x, f.y, f.z, f.r, 0, f.vy || 0, 0);
  }
  const dst = new Float32Array(desc.maxN * 4);
  const fps = desc.fps, sub = desc.substeps, dt = 1 / fps / sub, F = desc.frames;
  const ev = desc.events.slice().sort((a, b) => a.t - b.t); let ei = 0;
  const t0 = Date.now();
  const sampleAll = (t) => desc.objs.map((o) => sampleObjState(o, t));
  let n = await sim.readbackInto(dst);
  onFrame(packFrameBuf(dst, n, sim.b, sampleAll(0)), { f: 0, F, n, elapsed: 0, full: false });
  let ok = true;
  for (let f = 1; f <= F; f++) {
    for (let s = 0; s < sub; s++) {
      const t = ((f - 1) * sub + s + 1) * dt;
      while (ei < ev.length && ev[ei].t <= t) { const e = ev[ei++]; sim.fillSphere(e.x, e.y, e.z, e.r, 0, -1, 0); }
      runner.step(dt, sampleAll(t), { g: desc.g, iters: desc.iters, visc: desc.visc, colMax: desc.colMax, scale: desc.scale || 1 });
    }
    n = await sim.readbackInto(dst);
    onFrame(packFrameBuf(dst, n, sim.b, sampleAll(f / fps)), { f, F, n, elapsed: (Date.now() - t0) / 1000, full: sim.N >= sim.cap });
    if (isCancelled()) { ok = false; break; }
    await new Promise((r) => setTimeout(r, 0));
  }
  sim.destroy();
  return ok;
}
