// Shared between the page and the bake worker.
// Position based fluids with a boundary density term, so walls and colliders act like a layer of
// solid particles instead of a hard clamp that stacks fluid against the surface.

// ---------- mesh colliders ----------
// A collider is a closed mesh. Its signed distance field is sampled once on a local grid (negative inside),
// and every solver queries that field through the object's position and rotation.
let SDF_ID = 1;
function eulerMat(rx, ry, rz) {   // R = Rz * Ry * Rx, row major
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx];
}
function meshCube(hx, hy, hz) {
  const v = [];
  for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) v.push([x * hx, y * hy, z * hz]);
  // vertex index = x + 2y + 4z ; faces wound counter clockwise seen from outside
  const f = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
  return { v, f };
}
function meshSphere(r, seg, rings) {
  seg = seg || 14; rings = rings || 9;
  const v = [[0, -r, 0]];
  for (let i = 1; i < rings; i++) {
    const a = -Math.PI / 2 + (i / rings) * Math.PI, y = Math.sin(a) * r, rr = Math.cos(a) * r;
    for (let j = 0; j < seg; j++) { const b = (j / seg) * Math.PI * 2; v.push([Math.cos(b) * rr, y, Math.sin(b) * rr]); }
  }
  v.push([0, r, 0]);
  const f = [], top = v.length - 1, ring = (i, j) => 1 + (i - 1) * seg + ((j + seg) % seg);
  for (let j = 0; j < seg; j++) f.push([0, ring(1, j + 1), ring(1, j)]);
  for (let i = 1; i < rings - 1; i++) for (let j = 0; j < seg; j++) f.push([ring(i, j), ring(i, j + 1), ring(i + 1, j + 1), ring(i + 1, j)]);
  for (let j = 0; j < seg; j++) f.push([top, ring(rings - 1, j), ring(rings - 1, j + 1)]);
  return { v, f };
}
function meshCylinder(r, hh, seg) {
  seg = seg || 16; const v = [], f = [];
  for (let j = 0; j < seg; j++) { const a = (j / seg) * Math.PI * 2; v.push([Math.cos(a) * r, -hh, Math.sin(a) * r]); }
  for (let j = 0; j < seg; j++) { const a = (j / seg) * Math.PI * 2; v.push([Math.cos(a) * r, hh, Math.sin(a) * r]); }
  for (let j = 0; j < seg; j++) { const k = (j + 1) % seg; f.push([j, k, seg + k, seg + j]); }
  f.push(Array.from({ length: seg }, (_, j) => seg - 1 - j));
  f.push(Array.from({ length: seg }, (_, j) => seg + j));
  return { v, f };
}
// triangle list [a,b,c, ...] and, for each triangle, the face it came from (fan triangulation)
function meshTris(m) {
  const t = [], of = [];
  m.f.forEach((face, fi) => { for (let k = 1; k + 1 < face.length; k++) { t.push(face[0], face[k], face[k + 1]); of.push(fi); } });
  return { t, of };
}
function meshEdges(m) {
  const seen = new Map(), out = [];
  m.f.forEach((face, fi) => {
    for (let k = 0; k < face.length; k++) {
      const a = face[k], b = face[(k + 1) % face.length], key = a < b ? a + ',' + b : b + ',' + a;
      let e = seen.get(key);
      if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), faces: [] }; seen.set(key, e); out.push(e); }
      e.faces.push(fi);
    }
  });
  return out;
}
function meshBounds(m) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const p of m.v) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  return { lo, hi };
}
function ptTriDist2(px, py, pz, a, b, c) {   // squared distance from a point to a triangle (Ericson)
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = px - a[0], apy = py - a[1], apz = pz - a[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = a[0]; qy = a[1]; qz = a[2]; }
  else {
    const bpx = px - b[0], bpy = py - b[1], bpz = pz - b[2], d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = b[0]; qy = b[1]; qz = b[2]; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = a[0] + abx * v; qy = a[1] + aby * v; qz = a[2] + abz * v; }
      else {
        const cpx = px - c[0], cpy = py - c[1], cpz = pz - c[2], d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = c[0]; qy = c[1]; qz = c[2]; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = a[0] + acx * w; qy = a[1] + acy * w; qz = a[2] + acz * w; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); qx = b[0] + (c[0] - b[0]) * w; qy = b[1] + (c[1] - b[1]) * w; qz = b[2] + (c[2] - b[2]) * w; }
            else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; qx = a[0] + abx * v + acx * w; qy = a[1] + aby * v + acy * w; qz = a[2] + abz * v + acz * w; }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz; return dx * dx + dy * dy + dz * dz;
}
// signed distance grid of a closed mesh. cell is the voxel size, margin how far outside the mesh the field stays exact.
function buildSDF(mesh, cell, margin) {
  cell = cell || 0.025; margin = margin === undefined ? 0.16 : margin;
  const bb = meshBounds(mesh), lo = bb.lo.map((x) => x - margin), hi = bb.hi.map((x) => x + margin);
  let dims = lo.map((x, k) => Math.ceil((hi[k] - x) / cell) + 1);
  while (dims[0] * dims[1] * dims[2] > 2.6e6) { cell *= 1.25; dims = lo.map((x, k) => Math.ceil((hi[k] - x) / cell) + 1); }
  const { t } = meshTris(mesh), nt = t.length / 3, V = mesh.v;
  const tri = [], tmin = [], tmax = [];
  for (let i = 0; i < nt; i++) {
    const a = V[t[i * 3]], b = V[t[i * 3 + 1]], c = V[t[i * 3 + 2]]; tri.push([a, b, c]);
    tmin.push([Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])]); tmax.push([Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])]);
  }
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  const dir = [1, 0.0371, 0.0137];   // slanted ray, so it rarely grazes an edge
  let idx = 0;
  for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++, idx++) {
    const px = lo[0] + i * cell, py = lo[1] + j * cell, pz = lo[2] + k * cell;
    let best = 1e30;
    for (let q = 0; q < nt; q++) { const d2 = ptTriDist2(px, py, pz, tri[q][0], tri[q][1], tri[q][2]); if (d2 < best) best = d2; }
    // inside test: count crossings of the ray p + s*dir (Moller Trumbore)
    let hits = 0;
    for (let q = 0; q < nt; q++) {
      const a = tri[q][0], b = tri[q][1], c = tri[q][2];
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2], e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
      const hx = dir[1] * e2z - dir[2] * e2y, hy = dir[2] * e2x - dir[0] * e2z, hz = dir[0] * e2y - dir[1] * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz; if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det, sx = px - a[0], sy = py - a[1], sz = pz - a[2];
      const u = inv * (sx * hx + sy * hy + sz * hz); if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = inv * (dir[0] * qx + dir[1] * qy + dir[2] * qz); if (v < 0 || u + v > 1) continue;
      if (inv * (e2x * qx + e2y * qy + e2z * qz) > 0) hits++;
    }
    const d = Math.sqrt(best); data[idx] = hits & 1 ? -d : d;
  }
  return { id: SDF_ID++, dims, origin: lo, cell, data };
}
// phi and gradient of an sdf at a local point, written to out = [phi, gx, gy, gz]
function sdfSample(sd, x, y, z, out) {
  const nx = sd.dims[0], ny = sd.dims[1], nz = sd.dims[2], inv = 1 / sd.cell;
  let gx = (x - sd.origin[0]) * inv, gy = (y - sd.origin[1]) * inv, gz = (z - sd.origin[2]) * inv;
  let ox = 0, oy = 0, oz = 0;
  const mx = nx - 1.0001, my = ny - 1.0001, mz = nz - 1.0001;
  if (gx < 0) { ox = gx; gx = 0; } else if (gx > mx) { ox = gx - mx; gx = mx; }
  if (gy < 0) { oy = gy; gy = 0; } else if (gy > my) { oy = gy - my; gy = my; }
  if (gz < 0) { oz = gz; gz = 0; } else if (gz > mz) { oz = gz - mz; gz = mz; }
  const i = gx | 0, j = gy | 0, k = gz | 0, fx = gx - i, fy = gy - j, fz = gz - k, D = sd.data, b = i + nx * (j + ny * k), s = nx * ny;
  const v000 = D[b], v100 = D[b + 1], v010 = D[b + nx], v110 = D[b + nx + 1], v001 = D[b + s], v101 = D[b + s + 1], v011 = D[b + s + nx], v111 = D[b + s + nx + 1];
  const c00 = v000 + (v100 - v000) * fx, c10 = v010 + (v110 - v010) * fx, c01 = v001 + (v101 - v001) * fx, c11 = v011 + (v111 - v011) * fx;
  const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
  let phi = c0 + (c1 - c0) * fz;
  const ex = ox * ox + oy * oy + oz * oz;
  if (ex > 0) {
    const l = Math.sqrt(ex); out[0] = phi + l * sd.cell; out[1] = ox / l; out[2] = oy / l; out[3] = oz / l; return;
  }
  let dx = ((v100 - v000) * (1 - fy) + (v110 - v010) * fy) * (1 - fz) + ((v101 - v001) * (1 - fy) + (v111 - v011) * fy) * fz;
  let dy = ((c10 - c00) * (1 - fz) + (c11 - c01) * fz);
  let dz = (c1 - c0);
  const l = Math.hypot(dx, dy, dz) || 1;
  out[0] = phi; out[1] = dx / l; out[2] = dy / l; out[3] = dz / l;
}

const SDFTMP = [0, 0, 0, 0];
// fill a water volume: every lattice point inside the mesh (through its signed distance field and pose) gets a particle
function fillVolume(sim, f) {
  const d = sim.d, R = f.R, j = 0.01 * d / 0.12;
  for (let y = f.lo[1] + d / 2; y < f.hi[1]; y += d)
    for (let x = f.lo[0] + d / 2; x < f.hi[0]; x += d)
      for (let z = f.lo[2] + d / 2; z < f.hi[2]; z += d) {
        const dx = x - f.x, dy = y - f.y, dz = z - f.z;
        sdfSample(f.sdf, R[0] * dx + R[3] * dy + R[6] * dz, R[1] * dx + R[4] * dy + R[7] * dz, R[2] * dx + R[5] * dy + R[8] * dz, SDFTMP);
        if (SDFTMP[0] < 0 && !sim.add(x + (Math.random() - 0.5) * j, y + (Math.random() - 0.5) * j, z + (Math.random() - 0.5) * j, 0, 0, 0)) return;
      }
}
const FDEAD = -1e5;   // a particle that left through an open face is parked at y = -1e6
class FluidSim {
  constructor(opt) {
    opt = opt || {};
    const d = (this.d = opt.d || 0.12);
    const M = (this.MAXN = opt.maxN || 8000);
    this.h = 2.2 * d;
    this.MAXNB = 48;
    const sz = opt.size || [3, 2.6, 3];
    this.b = { x0: -sz[0] / 2, x1: sz[0] / 2, y0: 0, y1: sz[1], z0: -sz[2] / 2, z1: sz[2] / 2 };
    // open faces let particles leave the box, where they are deleted. bits: 1 x0, 2 x1, 4 floor, 8 top, 16 z0, 32 z1
    this.open = opt.open | 0;
    this.N = 0; this.ring = 0; this.cap = M; this.recycle = true;
    this.P = new Float32Array(M * 3); this.V = new Float32Array(M * 3);
    this.Q = new Float32Array(M * 3); this.D = new Float32Array(M * 3);
    this.NV = new Float32Array(M * 3); this.BG = new Float32Array(M * 3);
    this.S = new Float32Array(M); this.lam = new Float32Array(M);
    this.cid = new Int32Array(M); this.sorted = new Int32Array(M);
    this.nb = new Int32Array(M * this.MAXNB); this.nc = new Int32Array(M);
    const h = this.h, b = this.b;
    this.nx = Math.ceil((b.x1 - b.x0) / h) + 1;
    this.ny = Math.ceil((b.y1 - b.y0) / h) + 1;
    this.nz = Math.ceil((b.z1 - b.z0) / h) + 1;
    const cells = this.nx * this.ny * this.nz;
    this.cellCount = new Int32Array(cells); this.cellStart = new Int32Array(cells + 1); this.cursor = new Int32Array(cells);
    const h2 = (this.h2 = h * h);
    this.poly = 315 / (64 * Math.PI * Math.pow(h, 9));
    this.spiky = -45 / (Math.PI * Math.pow(h, 6));
    this.W0 = this.poly * Math.pow(h2, 3);
    // rest density and one sided (half space) density of a lattice
    let rho0 = 0, below = 0, sgRest = 0;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) for (let k = -3; k <= 3; k++) {
      const r2 = (i * i + j * j + k * k) * d * d;
      if (r2 < h2) { const w = this.poly * Math.pow(h2 - r2, 3); rho0 += w; if (k < 0) below += w; }
    }
    this.rho0 = rho0;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) for (let k = -3; k <= 3; k++) {
      const r = Math.sqrt(i * i + j * j + k * k) * d;
      if (r > 1e-9 && r < h) { const f = this.spiky * (h - r) * (h - r) / r / rho0 * r; sgRest += f * f; }
    }
    this.eps = (opt.epsK || 0.64) * sgRest;
    this.relax = 1.0;
    this.restitution = 0.1;
    // boundary density table, calibrated so a particle d/2 off a wall sees exactly the rest density
    const h4 = h2 * h2, h6 = h4 * h2, h8 = h4 * h4;
    this.G = (s) => { const s2 = s * s, s3 = s2 * s, s5 = s3 * s2, s7 = s5 * s2, s9 = s7 * s2; return h8 * s - (4 / 3) * h6 * s3 + (6 / 5) * h4 * s5 - (4 / 7) * h2 * s7 + s9 / 9; };
    this.Gh = this.G(h);
    const c0 = (1 / (d * d * d)) * (Math.PI / 4) * this.poly;
    const cont = c0 * (this.Gh - this.G(d / 2));
    this.c0 = c0 * (below / cont) * (opt.wallK || 1.8);
    this.margin = 0.15 * d;
    this.br = 0; this.bgx = 0; this.bgy = 0; this.bgz = 0;
  }
  setCap(c) { this.cap = Math.min(c, this.MAXN); if (this.N > this.cap) this.N = this.cap; if (this.ring >= this.cap) this.ring = 0; }
  clear() { this.N = 0; this.ring = 0; }
  add(x, y, z, vx, vy, vz) {
    let i;
    if (this.N < this.cap) i = this.N++;
    else if (this.recycle) { i = this.ring++; if (this.ring >= this.cap) this.ring = 0; }
    else return false;
    const i3 = i * 3;
    this.P[i3] = x; this.P[i3 + 1] = y; this.P[i3 + 2] = z;
    this.V[i3] = vx; this.V[i3 + 1] = vy; this.V[i3 + 2] = vz;
    this.S[i] = Math.sqrt(vx * vx + vy * vy + vz * vz);
    return true;
  }
  fillBox(x0, x1, y0, y1, z0, z1) {
    const d = this.d, j = 0.01 * d / 0.12;
    for (let y = y0 + d / 2; y < y1; y += d)
      for (let x = x0 + d / 2; x < x1; x += d)
        for (let z = z0 + d / 2; z < z1; z += d)
          this.add(x + (Math.random() - 0.5) * j, y + (Math.random() - 0.5) * j, z + (Math.random() - 0.5) * j, 0, 0, 0);
  }
  fillSphere(cx, cy, cz, R, vx, vy, vz) {
    const d = this.d, j = 0.01 * d / 0.12;
    for (let y = -R; y <= R; y += d) for (let x = -R; x <= R; x += d) for (let z = -R; z <= R; z += d)
      if (x * x + y * y + z * z <= R * R)
        this.add(cx + x + (Math.random() - 0.5) * j, cy + y + (Math.random() - 0.5) * j, cz + z + (Math.random() - 0.5) * j, vx, vy, vz);
  }
  // hard projection, only a safety net behind the boundary density
  collide(cols, N) {
    const Q = this.Q, b = this.b, m = this.margin;
    const op = this.open, BIG = 1e9;
    const x0 = op & 1 ? -BIG : b.x0 + m, x1 = op & 2 ? BIG : b.x1 - m, y0 = op & 4 ? -BIG : b.y0 + m, y1 = op & 8 ? BIG : b.y1 - m, z0 = op & 16 ? -BIG : b.z0 + m, z1 = op & 32 ? BIG : b.z1 - m;
    const nc = cols.length;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      let x = Q[i3], y = Q[i3 + 1], z = Q[i3 + 2];
      if (y < FDEAD) continue;
      for (let k = 0; k < nc; k++) {
        const c = cols[k], R = c.R, dx = x - c.x, dy = y - c.y, dz = z - c.z;
        sdfSample(c.sdf, R[0] * dx + R[3] * dy + R[6] * dz, R[1] * dx + R[4] * dy + R[7] * dz, R[2] * dx + R[5] * dy + R[8] * dz, SDFTMP);
        if (SDFTMP[0] < m) {
          const sc = m - SDFTMP[0], gx = SDFTMP[1], gy = SDFTMP[2], gz = SDFTMP[3];
          x += (R[0] * gx + R[1] * gy + R[2] * gz) * sc; y += (R[3] * gx + R[4] * gy + R[5] * gz) * sc; z += (R[6] * gx + R[7] * gy + R[8] * gz) * sc;
        }
      }
      Q[i3] = x < x0 ? x0 : x > x1 ? x1 : x;
      Q[i3 + 1] = y < y0 ? y0 : y > y1 ? y1 : y;
      Q[i3 + 2] = z < z0 ? z0 : z > z1 ? z1 : z;
    }
  }
  // density contribution of the tank walls and colliders at a point, and its gradient
  bnd(x, y, z, cols) {
    const h = this.h, h2 = this.h2, b = this.b, c0 = this.c0, Gh = this.Gh;
    let rho = 0, gx = 0, gy = 0, gz = 0, p, t, dd;
    const op = this.open;
    p = x - b.x0; if (!(op & 1) && p < h) { if (p < 0) p = 0; t = h2 - p * p; t *= t; rho += c0 * (Gh - this.G(p)); gx -= c0 * t * t; }
    p = b.x1 - x; if (!(op & 2) && p < h) { if (p < 0) p = 0; t = h2 - p * p; t *= t; rho += c0 * (Gh - this.G(p)); gx += c0 * t * t; }
    p = y - b.y0; if (!(op & 4) && p < h) { if (p < 0) p = 0; t = h2 - p * p; t *= t; rho += c0 * (Gh - this.G(p)); gy -= c0 * t * t; }
    p = b.y1 - y; if (!(op & 8) && p < h) { if (p < 0) p = 0; t = h2 - p * p; t *= t; rho += c0 * (Gh - this.G(p)); gy += c0 * t * t; }
    p = z - b.z0; if (!(op & 16) && p < h) { if (p < 0) p = 0; t = h2 - p * p; t *= t; rho += c0 * (Gh - this.G(p)); gz -= c0 * t * t; }
    p = b.z1 - z; if (!(op & 32) && p < h) { if (p < 0) p = 0; t = h2 - p * p; t *= t; rho += c0 * (Gh - this.G(p)); gz += c0 * t * t; }
    const nc = cols.length;
    for (let k = 0; k < nc; k++) {
      const c = cols[k], R = c.R, dx = x - c.x, dy = y - c.y, dz = z - c.z;
      sdfSample(c.sdf, R[0] * dx + R[3] * dy + R[6] * dz, R[1] * dx + R[4] * dy + R[7] * dz, R[2] * dx + R[5] * dy + R[8] * dz, SDFTMP);
      let phi = SDFTMP[0];
      if (phi >= h) continue;
      if (phi < 0) phi = 0;
      t = h2 - phi * phi; t *= t; dd = -c0 * t * t;
      rho += c0 * (Gh - this.G(phi));
      const lx = SDFTMP[1], ly = SDFTMP[2], lz = SDFTMP[3];
      gx += dd * (R[0] * lx + R[1] * ly + R[2] * lz); gy += dd * (R[3] * lx + R[4] * ly + R[5] * lz); gz += dd * (R[6] * lx + R[7] * ly + R[8] * lz);
    }
    this.br = rho; this.bgx = gx; this.bgy = gy; this.bgz = gz;
  }
  buildNeighbors(N) {
    const { Q, cid, cellCount, cellStart, cursor, sorted, nb, nc, b, h2, nx, ny, nz, MAXNB } = this;
    const inv = 1 / this.h;
    cellCount.fill(0);
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      if (Q[i3 + 1] < FDEAD) { cid[i] = -1; continue; }
      let cx = ((Q[i3] - b.x0) * inv) | 0, cy = ((Q[i3 + 1] - b.y0) * inv) | 0, cz = ((Q[i3 + 2] - b.z0) * inv) | 0;
      if (cx < 0) cx = 0; else if (cx >= nx) cx = nx - 1;
      if (cy < 0) cy = 0; else if (cy >= ny) cy = ny - 1;
      if (cz < 0) cz = 0; else if (cz >= nz) cz = nz - 1;
      const c = cx + nx * (cy + ny * cz);
      cid[i] = c; cellCount[c]++;
    }
    const cells = nx * ny * nz;
    cellStart[0] = 0;
    for (let c = 0; c < cells; c++) { cellStart[c + 1] = cellStart[c] + cellCount[c]; cursor[c] = cellStart[c]; }
    for (let i = 0; i < N; i++) if (cid[i] >= 0) sorted[cursor[cid[i]]++] = i;
    for (let i = 0; i < N; i++) {
      const c = cid[i];
      if (c < 0) { nc[i] = 0; continue; }
      const cx = c % nx, t = (c / nx) | 0, cy = t % ny, cz = (t / ny) | 0;
      const i3 = i * 3, xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2];
      const xa = cx > 0 ? cx - 1 : 0, xb = cx < nx - 1 ? cx + 1 : nx - 1;
      const ya = cy > 0 ? cy - 1 : 0, yb = cy < ny - 1 ? cy + 1 : ny - 1;
      const za = cz > 0 ? cz - 1 : 0, zb = cz < nz - 1 ? cz + 1 : nz - 1;
      const base = i * MAXNB; let n = 0;
      for (let z = za; z <= zb; z++) for (let y = ya; y <= yb; y++) {
        const row = nx * (y + ny * z);
        const s0 = cellStart[row + xa], s1 = cellStart[row + xb + 1];
        for (let s = s0; s < s1; s++) {
          const j = sorted[s];
          if (j === i) continue;
          const j3 = j * 3, dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2];
          if (dx * dx + dy * dy + dz * dz < h2 && n < MAXNB) nb[base + n++] = j;
        }
      }
      nc[i] = n;
    }
  }
  solve(N, cols) {
    const { Q, D, BG, nb, nc, lam, h, h2, poly, spiky, rho0, W0, MAXNB, eps, relax } = this;
    const irho = 1 / rho0, maxD = 0.5 * this.d, maxD2 = maxD * maxD;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3, xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2];
      if (yi < FDEAD) { lam[i] = 0; BG[i3] = BG[i3 + 1] = BG[i3 + 2] = 0; continue; }
      let rho = W0, gx = 0, gy = 0, gz = 0, sg = 0;
      const base = i * MAXNB, cnt = nc[i];
      for (let k = 0; k < cnt; k++) {
        const j3 = nb[base + k] * 3;
        const dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const t = h2 - r2; rho += poly * t * t * t;
        const r = Math.sqrt(r2); if (r < 1e-7) continue;
        const hr = h - r, f = spiky * hr * hr / r * irho;
        const fx = f * dx, fy = f * dy, fz = f * dz;
        gx += fx; gy += fy; gz += fz; sg += fx * fx + fy * fy + fz * fz;
      }
      this.bnd(xi, yi, zi, cols);
      rho += this.br;
      const bx = this.bgx * irho, by = this.bgy * irho, bz = this.bgz * irho;
      BG[i3] = bx; BG[i3 + 1] = by; BG[i3 + 2] = bz;
      gx += bx; gy += by; gz += bz; sg += bx * bx + by * by + bz * bz;
      const C = rho * irho - 1;
      lam[i] = C > 0 ? -C / (sg + gx * gx + gy * gy + gz * gz + eps) : 0;
    }
    for (let i = 0; i < N; i++) {
      const i3 = i * 3, xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2], li = lam[i];
      if (yi < FDEAD) { D[i3] = D[i3 + 1] = D[i3 + 2] = 0; continue; }
      let sx = li * BG[i3], sy = li * BG[i3 + 1], sz = li * BG[i3 + 2];
      const base = i * MAXNB, cnt = nc[i];
      for (let k = 0; k < cnt; k++) {
        const j = nb[base + k], j3 = j * 3;
        const s = li + lam[j];
        if (s === 0) continue;
        const dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const r = Math.sqrt(r2); if (r < 1e-7) continue;
        const hr = h - r, f = spiky * hr * hr / r * irho * s;
        sx += f * dx; sy += f * dy; sz += f * dz;
      }
      sx *= relax; sy *= relax; sz *= relax;
      const m2 = sx * sx + sy * sy + sz * sz;
      if (m2 > maxD2) { const k = maxD / Math.sqrt(m2); sx *= k; sy *= k; sz *= k; }
      D[i3] = sx; D[i3 + 1] = sy; D[i3 + 2] = sz;
    }
    for (let i = 0; i < N * 3; i++) Q[i] += D[i];
  }
  step(dt, o) {
    const N = this.N; if (N === 0) return;
    const { P, V, Q, NV, S, nb, nc, MAXNB, h2, poly, rho0 } = this;
    const g = o.g;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      if (P[i3 + 1] < FDEAD) { Q[i3] = P[i3]; Q[i3 + 1] = P[i3 + 1]; Q[i3 + 2] = P[i3 + 2]; continue; }
      V[i3 + 1] -= g * dt;
      Q[i3] = P[i3] + V[i3] * dt; Q[i3 + 1] = P[i3 + 1] + V[i3 + 1] * dt; Q[i3 + 2] = P[i3 + 2] + V[i3 + 2] * dt;
    }
    this.collide(o.cols, N);
    this.buildNeighbors(N);
    for (let it = 0; it < o.iters; it++) { this.solve(N, o.cols); this.collide(o.cols, N); }
    const idt = 1 / dt, vmax = 12, rest = this.restitution, BG = this.BG;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      if (P[i3 + 1] < FDEAD) continue;
      let vx = (Q[i3] - P[i3]) * idt, vy = (Q[i3 + 1] - P[i3 + 1]) * idt, vz = (Q[i3 + 2] - P[i3 + 2]) * idt;
      // inelastic contact: a particle that arrived at a surface may not leave faster than e times its approach speed
      const gx = BG[i3], gy = BG[i3 + 1], gz = BG[i3 + 2], gm2 = gx * gx + gy * gy + gz * gz;
      if (gm2 > 1e-6) {
        const gm = 1 / Math.sqrt(gm2), nx = -gx * gm, ny = -gy * gm, nz = -gz * gm;
        const vo = V[i3] * nx + V[i3 + 1] * ny + V[i3 + 2] * nz;
        if (vo < 0) {
          const vn = vx * nx + vy * ny + vz * nz, lim = -vo * rest;
          if (vn > lim) { const k = vn - lim; vx -= k * nx; vy -= k * ny; vz -= k * nz; }
        }
      }
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > vmax * vmax) { const k = vmax / Math.sqrt(s2); vx *= k; vy *= k; vz *= k; }
      V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
    }
    const c = o.visc;
    if (c > 0) {
      const irho = 1 / rho0;
      for (let i = 0; i < N; i++) {
        const i3 = i * 3, xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2];
        if (yi < FDEAD) { NV[i3] = NV[i3 + 1] = NV[i3 + 2] = 0; continue; }
        let ax = 0, ay = 0, az = 0; const base = i * MAXNB, cnt = nc[i];
        for (let k = 0; k < cnt; k++) {
          const j3 = nb[base + k] * 3;
          const dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= h2) continue;
          const t = h2 - r2, w = poly * t * t * t * irho;
          ax += (V[j3] - V[i3]) * w; ay += (V[j3 + 1] - V[i3 + 1]) * w; az += (V[j3 + 2] - V[i3 + 2]) * w;
        }
        NV[i3] = V[i3] + c * ax; NV[i3 + 1] = V[i3 + 1] + c * ay; NV[i3 + 2] = V[i3 + 2] + c * az;
      }
      for (let i = 0; i < N * 3; i++) V[i] = NV[i];
    }
    const op = this.open, b = this.b;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      if (P[i3 + 1] < FDEAD) continue;
      const x = Q[i3], y = Q[i3 + 1], z = Q[i3 + 2];
      if (op && ((op & 1 && x < b.x0) || (op & 2 && x > b.x1) || (op & 4 && y < b.y0) || (op & 8 && y > b.y1) || (op & 16 && z < b.z0) || (op & 32 && z > b.z1))) {
        P[i3 + 1] = FDEAD * 10; V[i3] = V[i3 + 1] = V[i3 + 2] = 0; S[i] = 0; continue;
      }
      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
      S[i] = Math.sqrt(V[i3] * V[i3] + V[i3 + 1] * V[i3 + 1] + V[i3 + 2] * V[i3 + 2]);
    }
  }
  // number of particles still inside the box
  liveCount() { let n = 0; const P = this.P; for (let i = 0; i < this.N; i++) if (P[i * 3 + 1] >= FDEAD) n++; return n; }
}

// Turns scene object states (emitters, boxes, spheres) into emission and colliders for one solver step.
function vhash(x, y, z) { let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vnoise(x, y, z) {   // smooth value noise in [-1, 1]
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz), L = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => vhash(ix + i, iy + j, iz + k);
  return 2 * L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v), L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w) - 1;
}
// lim: objects faster than their speed limit are jumping, so they never ask for substeps
function objSpeed(a, b, dt, lim) {
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    const o = b[i], p = a && a[i];
    if (o.kind === 'emitter') { if (o.on) v = Math.max(v, o.speed || 0); continue; }
    if (!p || p.id !== o.id) continue;
    const lin = Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z), rot = Math.abs((o.rx || 0) - (p.rx || 0)) + Math.abs((o.yaw || 0) - (p.yaw || 0)) + Math.abs((o.rz || 0) - (p.rz || 0));
    const R = o.sdf ? 0.5 * o.sdf.cell * Math.hypot(o.sdf.dims[0], o.sdf.dims[1], o.sdf.dims[2]) : 0.5;
    const ov = (lin + rot * R) / dt;
    if (!lim || ov <= lim) v = Math.max(v, ov);
  }
  return v;
}
class SceneRunner {
  constructor(sim) { this.sim = sim; this.em = {}; this.cols = []; this.prev = {}; }
  step(dt, states, par) {
    const cols = this.cols; cols.length = 0; this.scale = par.scale || 1;
    const prev = this.prev || (this.prev = {});
    const lim2 = Math.pow(par.colMax || 20, 2);   // faster than this, an object's move counts as a jump and gives the water no speed
    const colOf = (o) => {   // collider record with velocity and angular velocity, for the pressure solves
      const R = eulerMat(o.rx || 0, o.yaw || 0, o.rz || 0), p = prev[o.id];
      prev[o.id] = { x: o.x, y: o.y, z: o.z, R };
      const c = { sdf: o.sdf, x: o.x, y: o.y, z: o.z, R, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
      if (p) {
        const vx = (o.x - p.x) / dt, vy = (o.y - p.y) / dt, vz = (o.z - p.z) / dt;
        if (vx * vx + vy * vy + vz * vz < lim2) { c.vx = vx; c.vy = vy; c.vz = vz; }
        const P = p.R, d = [0, 0, 0, 0, 0, 0, 0, 0, 0];   // dR = R * Rprev^T
        for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) d[r * 3 + q] = R[r * 3] * P[q * 3] + R[r * 3 + 1] * P[q * 3 + 1] + R[r * 3 + 2] * P[q * 3 + 2];
        const wx = (d[7] - d[5]) / (2 * dt), wy = (d[2] - d[6]) / (2 * dt), wz = (d[3] - d[1]) / (2 * dt);
        if (wx * wx + wy * wy + wz * wz < lim2) { c.wx = wx; c.wy = wy; c.wz = wz; }
      }
      return c;
    };
    for (const o of states) {
      if (o.kind === 'mesh') { if (o.sdf && !o.water) cols.push(colOf(o)); }
      else if (o.on) this.emit(o, dt);
    }
    this.sim.step(dt, Object.assign({}, par, { cols }));
  }
  emit(o, dt) {
    const sim = this.sim, d = sim.d;
    const st = this.em[o.id] || (this.em[o.id] = { phase: 0, acc: 0, key: '', pts: null });
    const az = o.az * Math.PI / 180, el = o.el * Math.PI / 180;
    const dx = Math.cos(el) * Math.cos(az), dy = Math.sin(el), dz = Math.cos(el) * Math.sin(az);
    const ref = Math.abs(dy) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let ux = dy * ref[2] - dz * ref[1], uy = dz * ref[0] - dx * ref[2], uz = dx * ref[1] - dy * ref[0];
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
    const ks = 1 / (this.scale || 1), sp = (o.spread || 0) * ks, v = o.speed * ks, veff = Math.max(v, 0.3 * ks), tb = o.turb || 0;
    st.t = (st.t || 0) + dt; st.dist = (st.dist || 0) + veff * dt;
    // turbulent flow: eddies fixed in the stream (they travel with it), big ones across the whole disc plus smaller ones, changing in time
    const turbV = (a, c, adv) => {
      if (tb <= 0) return null;
      const r = Math.max(o.radius, 0.08), k1 = 1.4 / r, k2 = 4.2 / r, zz = (st.dist - adv) / (1.6 * r + 0.25) + st.t * 0.5;
      const n = (ox, oy, oz) => vnoise(a * k1 + ox, c * k1 + oy, zz + oz) * 0.7 + vnoise(a * k2 + oz, c * k2 + ox, zz * 2.3 + oy) * 0.3;
      const tv = tb * Math.max(v, 0.6 * ks), l = n(0, 0, 0) * 0.5, p1 = n(31.7, 5.2, 9.1) * 0.9 * tv, p2 = n(-12.4, 77.3, 3.3) * 0.9 * tv;
      const f = 1 + 0.6 * tb * n(53.1, -8.8, 21.7), jit = tb * 0.1 * Math.max(v, 0.6 * ks);
      return [dx * v * (f - 1) + ux * p1 + wx * p2 + (Math.random() - 0.5) * 2 * jit, dy * v * (f - 1) + uy * p1 + wy * p2 + (Math.random() - 0.5) * 2 * jit, dz * v * (f - 1) + uz * p1 + wz * p2 + (Math.random() - 0.5) * 2 * jit];
    };
    if (o.mode === 'random') {
      st.acc += Math.PI * o.radius * o.radius * veff / (d * d * d) * (o.density || 1) * dt;
      const n = Math.floor(st.acc); st.acc -= n;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, rr = o.radius * Math.sqrt(Math.random()), ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
        const adv = Math.random() * veff * dt, tz = turbV(ca, sa, adv) || [0, 0, 0];
        if (!sim.add(o.x + ux * ca + wx * sa + dx * adv, o.y + uy * ca + wy * sa + dy * adv, o.z + uz * ca + wz * sa + dz * adv,
          dx * v + (Math.random() - 0.5) * 2 * sp + tz[0], dy * v + (Math.random() - 0.5) * 2 * sp + tz[1], dz * v + (Math.random() - 0.5) * 2 * sp + tz[2])) break;
      }
      return;
    }
    // smooth: a new square lattice disc is released every time the stream has advanced one spacing
    const key = o.radius + '|' + d;
    if (st.key !== key) {
      const pts = [], R = Math.ceil(o.radius / d) + 1;
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
        const a = (i + 0.5) * d, c = (j + 0.5) * d;
        if (a * a + c * c <= o.radius * o.radius) pts.push(a, c);
      }
      if (!pts.length) pts.push(0, 0);
      st.pts = pts; st.key = key;
    }
    st.phase += veff * dt;
    let guard = 0;
    while (st.phase >= d && guard++ < 8) {
      st.phase -= d;
      const adv = st.phase, pts = st.pts;
      for (let k = 0; k < pts.length; k += 2) {
        const a = pts[k], c = pts[k + 1], tz = turbV(a, c, adv) || [0, 0, 0];
        if (!sim.add(o.x + ux * a + wx * c + dx * adv, o.y + uy * a + wy * c + dy * adv, o.z + uz * a + wz * c + dz * adv,
          dx * v + (sp ? (Math.random() - 0.5) * 2 * sp : 0) + tz[0], dy * v + (sp ? (Math.random() - 0.5) * 2 * sp : 0) + tz[1], dz * v + (sp ? (Math.random() - 0.5) * 2 * sp : 0) + tz[2])) return;
      }
    }
  }
}

// Pose of an object at time t (seconds) from its keyframes. keys are sorted by t.
function keyPose(keys, t, smooth) {
  const n = keys.length;
  if (t <= keys[0].t) return keys[0];
  if (t >= keys[n - 1].t) return keys[n - 1];
  let i = 0; while (i < n - 2 && t >= keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1], u = (t - a.t) / Math.max(b.t - a.t, 1e-6);
  const p0 = keys[i - 1] || a, p3 = keys[i + 2] || b, u2 = u * u, u3 = u2 * u;
  const f = (k) => {
    const A = a[k] || 0, B = b[k] || 0, P0 = p0[k] || 0, P3 = p3[k] || 0;
    if (!smooth) return A + (B - A) * u;
    return 0.5 * ((2 * A) + (-P0 + B) * u + (2 * P0 - 5 * A + 4 * B - P3) * u2 + (-P0 + 3 * A - 3 * B + P3) * u3);
  };
  return { t, x: f('x'), y: f('y'), z: f('z'), rx: f('rx'), yaw: f('yaw'), rz: f('rz'), on: a.on, speed: a.speed === undefined ? undefined : a.speed + (b.speed - a.speed) * u };
}

function sampleObjState(o, t) {
  const s = Object.assign({}, o);
  if (o.keys && o.keys.length) {
    const k = keyPose(o.keys, t, o.smooth !== false);
    s.x = k.x; s.y = k.y; s.z = k.z; s.yaw = k.yaw || 0; s.rx = k.rx || 0; s.rz = k.rz || 0;
    if (o.kind === 'emitter') { if (k.on !== undefined) s.on = k.on; if (k.speed !== undefined) s.speed = k.speed; }
  } else if (o.rec && o.rec.arr.length >= 4) {
    const a = o.rec.arr, n = a.length / 4;
    let k = t * 60 - o.rec.start; if (k < 0) k = 0; if (k > n - 1) k = n - 1;
    const i0 = Math.floor(k), i1 = Math.min(i0 + 1, n - 1), w = k - i0;
    s.x = a[i0 * 4] + (a[i1 * 4] - a[i0 * 4]) * w; s.y = a[i0 * 4 + 1] + (a[i1 * 4 + 1] - a[i0 * 4 + 1]) * w;
    s.z = a[i0 * 4 + 2] + (a[i1 * 4 + 2] - a[i0 * 4 + 2]) * w; s.yaw = a[i0 * 4 + 3] + (a[i1 * 4 + 3] - a[i0 * 4 + 3]) * w;
  } else { s.yaw = (o.yaw || 0) + (o.spin || 0) * t; }
  return s;
}

function packFrame(sim, states) {
  const n = sim.N, b = sim.b, P = sim.P, S = sim.S;
  const pos = new Uint16Array(n * 3), spd = new Uint8Array(n);
  const kx = 65535 / (b.x1 - b.x0), ky = 65535 / (b.y1 - b.y0), kz = 65535 / (b.z1 - b.z0);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    if (P[i3 + 1] < FDEAD) { pos[i3] = pos[i3 + 1] = pos[i3 + 2] = 0; continue; }
    pos[i3] = Math.max(0, Math.min(65535, Math.round((P[i3] - b.x0) * kx)));
    pos[i3 + 1] = Math.max(0, Math.min(65535, Math.round((P[i3 + 1] - b.y0) * ky)));
    pos[i3 + 2] = Math.max(0, Math.min(65535, Math.round((P[i3 + 2] - b.z0) * kz)));
    if (P[i3 + 1] < FDEAD) { spd[i] = 255; continue; }
    const s = S[i] * 16; spd[i] = s > 191 ? 191 : s;
  }
  return { n, pos, spd, objs: packObjs(states) };
}
function packObjs(states) {
  const objs = new Float32Array(states.length * 6);
  states.forEach((o, k) => { objs[k * 6] = o.x; objs[k * 6 + 1] = o.y; objs[k * 6 + 2] = o.z; objs[k * 6 + 3] = o.rx || 0; objs[k * 6 + 4] = o.yaw || 0; objs[k * 6 + 5] = o.rz || 0; });
  return objs;
}

// Runs a whole bake. onFrame(frame, info) is called for every cache frame, including frame 0.
async function runBake(desc, onFrame, isCancelled) {
  const sim = new FluidSim({ d: desc.d, maxN: desc.maxN, size: desc.size, open: desc.open });
  sim.recycle = false; sim.cap = desc.maxN;
  const runner = new SceneRunner(sim);
  for (const f of desc.fills) {
    if (f.t === 'box') sim.fillBox(f.x0, f.x1, f.y0, f.y1, f.z0, f.z1);
    else if (f.t === 'vol') fillVolume(sim, f);
    else sim.fillSphere(f.x, f.y, f.z, f.r, 0, f.vy || 0, 0);
  }
  const fps = desc.fps, sub = desc.substeps, dt = 1 / fps / sub, F = desc.frames;
  const ev = desc.events.slice().sort((a, b) => a.t - b.t); let ei = 0;
  const t0 = Date.now();
  const sampleAll = (t) => desc.objs.map((o) => sampleObjState(o, t));
  onFrame(packFrame(sim, sampleAll(0)), { f: 0, F, n: sim.N, elapsed: 0, full: false });
  for (let f = 1; f <= F; f++) {
    for (let s = 0; s < sub; s++) {
      const t = ((f - 1) * sub + s + 1) * dt;
      while (ei < ev.length && ev[ei].t <= t) { const e = ev[ei++]; sim.fillSphere(e.x, e.y, e.z, e.r, 0, -1, 0); }
      runner.step(dt, sampleAll(t), { g: desc.g, iters: desc.iters, visc: desc.visc, colMax: desc.colMax, scale: desc.scale || 1 });
    }
    onFrame(packFrame(sim, sampleAll(f / fps)), { f, F, n: sim.N, elapsed: (Date.now() - t0) / 1000, full: sim.N >= sim.cap });
    if (isCancelled()) return false;
    await new Promise((r) => setTimeout(r, 0));
  }
  return true;
}

// Cache file, version 2: 'SPLC', 2, length of a JSON block (spacing, fps, object ids, box, scene, bake settings and measurements),
// the JSON, padding to 4 bytes, frame count, then per frame: points, flags (1 = white water levels follow, 2 = spray follows, 4 = deep water points follow), object poses (6 floats each),
// positions (3 x uint16 across the box), speed (uint8, 16ths of m/s), white water (uint8), padding to 4 bytes.
function writeCacheParts(c) {
  const meta = { d: c.d, fps: c.fps, ids: c.ids, b: c.b, org: c.org, maxN: c.maxN, seconds: c.seconds, engine: c.engine, scene: c.scene, desc: c.desc, diag: c.diag, stableIds: !!c.stableIds, scale: c.scale || 1 };
  const mj = new TextEncoder().encode(JSON.stringify(meta)), pad = (k) => (4 - (k % 4)) % 4;
  const parts = [new Uint8Array([83, 80, 76, 67]), new Uint32Array([2, mj.length]), mj, new Uint8Array(pad(mj.length)), new Uint32Array([c.frames.length])];
  for (const fr of c.frames) {
    const sp = fr.sp && fr.sp.n ? fr.sp : null, dp = fr.dp && fr.dp.n ? fr.dp : null;
    parts.push(new Uint32Array([fr.n, (fr.fm ? 1 : 0) | (sp ? 2 : 0) | (dp ? 4 : 0)]), fr.objs, fr.pos, fr.spd);
    let bytes = fr.n * 7; if (fr.fm) { parts.push(fr.fm); bytes += fr.n; }
    parts.push(new Uint8Array(pad(bytes)));
    if (sp) parts.push(new Uint32Array([sp.n]), sp.pos, new Uint8Array(pad(sp.n * 6)), sp.pk);
    if (dp) parts.push(new Uint32Array([dp.n]), dp.pos, dp.spd, new Uint8Array(pad(dp.n * 7)));   // deep water points (narrow band, look only)
  }
  return parts;
}
function parseCache2(buf, dv) {
  let o = 8; const ml = dv.getUint32(o, true); o += 4;
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o, ml))); o += ml + (4 - (ml % 4)) % 4;
  const nf = dv.getUint32(o, true); o += 4;
  const nobj = (meta.ids || []).length, frames = []; let maxN = 0;
  for (let f = 0; f < nf; f++) {
    if (o + 8 > buf.byteLength) break;
    const n = dv.getUint32(o, true), fl = dv.getUint32(o + 4, true); o += 8;
    const need = nobj * 24 + n * ((fl & 1) ? 8 : 7);
    if (o + need > buf.byteLength) break;
    const objs = new Float32Array(buf.slice(o, o + nobj * 24)); o += nobj * 24;
    const pos = new Uint16Array(buf.slice(o, o + n * 6)); o += n * 6;
    const spd = new Uint8Array(buf.slice(o, o + n)); o += n;
    const fr = { n, pos, spd, objs };
    if (fl & 1) { fr.fm = new Uint8Array(buf.slice(o, o + n)); o += n; }
    o += (4 - ((n * ((fl & 1) ? 8 : 7)) % 4)) % 4;
    if (fl & 2) {
      const ns = dv.getUint32(o, true); o += 4;
      const pos2 = new Uint16Array(buf.slice(o, o + ns * 6)); o += ns * 6 + (4 - ((ns * 6) % 4)) % 4;
      const pk = new Uint32Array(buf.slice(o, o + ns * 4)); o += ns * 4;
      fr.sp = { n: ns, pos: pos2, pk, alive: ns };
    }
    if (fl & 4) {
      const nd = dv.getUint32(o, true); o += 4;
      const pos3 = new Uint16Array(buf.slice(o, o + nd * 6)); o += nd * 6;
      const spd3 = new Uint8Array(buf.slice(o, o + nd)); o += nd + (4 - ((nd * 7) % 4)) % 4;
      fr.dp = { n: nd, pos: pos3, spd: spd3 };
    }
    frames.push(fr); if (n > maxN) maxN = n;
  }
  return Object.assign({}, meta, { frames, maxN: Math.max(maxN, meta.maxN || 0) });
}
// Reads a cache file: version 2 from this page, or the older format from the native baker.
function parseCache(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 24 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'SPLC') throw new Error('This is not a Splash Tank cache file.');
  if (dv.getUint32(4, true) === 2) return parseCache2(buf, dv);
  let o = 4; o += 4;
  const d = dv.getFloat32(o, true); o += 4;
  const fps = dv.getUint32(o, true); o += 4;
  const nf = dv.getUint32(o, true); o += 4;
  const nobj = dv.getUint32(o, true); o += 4;
  const ids = []; for (let k = 0; k < nobj; k++) { ids.push(dv.getUint32(o, true)); o += 4; }
  const frames = []; let maxN = 0;
  for (let f = 0; f < nf; f++) {
    if (o + 4 > buf.byteLength) break;
    const n = dv.getUint32(o, true); o += 4;
    const need = nobj * 16 + n * 7;
    if (o + need > buf.byteLength) break;
    const objs = new Float32Array(nobj * 6);   // files hold x y z yaw, the viewer wants x y z rx yaw rz
    for (let k = 0; k < nobj; k++) { objs[k * 6] = dv.getFloat32(o + k * 16, true); objs[k * 6 + 1] = dv.getFloat32(o + k * 16 + 4, true); objs[k * 6 + 2] = dv.getFloat32(o + k * 16 + 8, true); objs[k * 6 + 4] = -dv.getFloat32(o + k * 16 + 12, true); }
    o += nobj * 16;
    const pos = new Uint16Array(buf.slice(o, o + n * 6)); o += n * 6;
    const spd = new Uint8Array(buf.slice(o, o + n)); o += n;
    frames.push({ n, pos, spd, objs }); if (n > maxN) maxN = n;
  }
  return { fps, d, frames, maxN, ids, seconds: 0 };
}

// ---- ocean waves (the same sums run in the FLIP shader and in the viewer) ----
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// 24 linear waves around the peak wavelength, with a Pierson-Moskowitz shaped spectrum scaled to the significant wave height,
// spread around the wave direction. Depth and gravity set each wave's speed (deep and shallow water dispersion).
// Per wave 8 floats: kx, kz, amplitude, angular frequency, phase, wavenumber, 0, 0.
function oceanWaves(oc, g, depth) {
  const N = 24, w = new Float32Array(N * 8), rnd = mulberry32(((oc.seed | 0) || 1) * 7919 + 13);
  const D = Math.max(depth, 1e-3), G = Math.max(g, 1e-4), lp = Math.max(oc.length, 1e-3), kp = 2 * Math.PI / lp, wp = Math.sqrt(G * kp * Math.tanh(kp * D));
  const kOf = (om) => { let k = om * om / G; for (let i = 0; i < 40; i++) k = om * om / (G * Math.tanh(Math.max(k * D, 1e-6))); return k; };
  const th0 = (oc.dir || 0) * Math.PI / 180, spr = Math.max(0, oc.spread || 0) * Math.PI / 180;
  const tmp = []; let sum = 0;
  for (let i = 0; i < N; i++) {
    const r = 0.6 + 1.6 * (i + rnd()) / N, om = r * wp, k = kOf(om), S = Math.pow(r, -5) * Math.exp(-1.25 * Math.pow(r, -4));
    tmp.push({ k, om, S, th: th0 + spr * (rnd() + rnd() + rnd() - 1.5) / 1.5, ph: rnd() * 2 * Math.PI }); sum += S;
  }
  const m0 = Math.pow(Math.max(oc.height || 0, 0) / 4, 2);   // significant height = 4 x the standard deviation of the surface
  tmp.forEach((q, i) => { const a = Math.min(Math.sqrt(2 * m0 * q.S / sum), 0.3 / q.k); w.set([q.k * Math.cos(q.th), q.k * Math.sin(q.th), a, q.om, q.ph, q.k, 0, 0], i * 8); });
  return { n: N, w };
}
function oceanEtaJS(W, oc, x, z, t) {
  let e = oc.level; const a = W.w;
  for (let k = 0; k < W.n; k++) { const j = k * 8; e += a[j + 2] * Math.cos(a[j] * x + a[j + 1] * z - a[j + 3] * t + a[j + 4]); }
  return e;
}
function oceanVelJS(W, oc, y0, x, y, z, t, out) {
  const D = Math.max(oc.level - y0, 1e-3), eta = oceanEtaJS(W, oc, x, z, t), a = W.w;
  const ys = Math.min(Math.max((y - y0) * D / Math.max(D + eta - oc.level, 0.1 * D), 0), D);
  let vx = 0, vy = 0, vz = 0;
  for (let k = 0; k < W.n; k++) {
    const j = k * 8, kk = Math.max(a[j + 5], 1e-4), th = a[j] * x + a[j + 1] * z - a[j + 3] * t + a[j + 4];
    const e1 = Math.exp(kk * (ys - D)), e2 = Math.exp(-kk * (ys + D)), dn = Math.max(1 - Math.exp(-2 * kk * D), 1e-4), aw = a[j + 2] * a[j + 3];
    const hc = aw * (e1 + e2) / dn * Math.cos(th) / kk;
    vx += hc * a[j]; vy += aw * (e1 - e2) / dn * Math.sin(th); vz += hc * a[j + 1];
  }
  out[0] = vx; out[1] = vy; out[2] = vz; return out;
}

// ---- narrow band: starting particles only in a band under the free surface ----
// The deep water starts on the solver's grid (from the same shapes), so only the band gets particles. Box faces on the tank walls
// are not free surfaces; for water meshes, a surface point that lies on a wall counts as deep, and the depth is measured upwards instead.
// mode 1: a restart, 2: water added to a running sim. Some empty slots are kept for the solver to refill the band from.
function nbSeed(sim, fills, nb, oc, t, g, mode) {
  const d = sim.d, h = sim.h, band = Math.max(2, (nb && nb.band) || 3) * h, b = sim.b, jit = 0.01 * d / 0.12, near = 0.6 * h, n0 = sim.N;
  const J = () => (Math.random() - 0.5) * jit, prims = [], vols = [];
  const onWall = (x, y, z) => x < b.x0 + near || x > b.x1 - near || z < b.z0 + near || z > b.z1 - near || y < b.y0 + near || y > b.y1 - near;
  let full = false;
  const put = (x, y, z, vx, vy, vz) => { if (!sim.add(x + J(), y + J(), z + J(), vx, vy, vz)) full = true; };
  for (const f of fills) {
    if (full) break;
    if (f.t === 'box') {
      const e = { x0: f.x0 <= b.x0 + near ? -1e4 : f.x0, x1: f.x1 >= b.x1 - near ? 1e4 : f.x1, y0: f.y0 <= b.y0 + near ? -1e4 : f.y0,
        y1: f.y1 >= b.y1 - near ? 1e4 : f.y1, z0: f.z0 <= b.z0 + near ? -1e4 : f.z0, z1: f.z1 >= b.z1 - near ? 1e4 : f.z1 };
      for (let y = f.y0 + d / 2; y < f.y1 && !full; y += d) for (let x = f.x0 + d / 2; x < f.x1 && !full; x += d) for (let z = f.z0 + d / 2; z < f.z1; z += d) {
        if (Math.min(x - e.x0, e.x1 - x, y - e.y0, e.y1 - y, z - e.z0, e.z1 - z) <= band) put(x, y, z, 0, 0, 0);
      }
      prims.push(Object.assign({ t: 'box' }, e));
    } else if (f.t === 'vol') {
      const R = f.R, loc = (x, y, z) => { const dx = x - f.x, dy = y - f.y, dz = z - f.z; sdfSample(f.sdf, R[0] * dx + R[3] * dy + R[6] * dz, R[1] * dx + R[4] * dy + R[7] * dz, R[2] * dx + R[5] * dy + R[8] * dz, SDFTMP); return SDFTMP[0]; };
      for (let y = f.lo[1] + d / 2; y < f.hi[1] && !full; y += d) for (let x = f.lo[0] + d / 2; x < f.hi[0] && !full; x += d) for (let z = f.lo[2] + d / 2; z < f.hi[2]; z += d) {
        const s = loc(x, y, z); if (s >= 0 || -s > band) continue;
        // nearest surface point, in world space: on a wall it is not a free surface, so measure the depth straight up instead
        const nx = SDFTMP[1], ny = SDFTMP[2], nz = SDFTMP[3], wx = R[0] * nx + R[1] * ny + R[2] * nz, wy = R[3] * nx + R[4] * ny + R[5] * nz, wz = R[6] * nx + R[7] * ny + R[8] * nz;
        if (onWall(x - s * wx, y - s * wy, z - s * wz)) { let up = 0; while (up <= band && y + up < b.y1 && loc(x, y + up, z) < 0) up += d; if (up <= band && y + up < b.y1) put(x, y, z, 0, 0, 0); }
        else put(x, y, z, 0, 0, 0);
      }
      vols.push({ sdf: f.sdf, x: f.x, y: f.y, z: f.z, R: f.R, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 });
    } else {
      const r = f.r;
      for (let y = -r; y <= r && !full; y += d) for (let x = -r; x <= r && !full; x += d) for (let z = -r; z <= r; z += d) {
        const dist = r - Math.hypot(x, y, z); if (dist >= 0 && dist <= band) put(f.x + x, f.y + y, f.z + z, 0, f.vy || 0, 0);
      }
      prims.push({ t: 'sphere', x: f.x, y: f.y, z: f.z, r });
    }
  }
  if (oc && !full) {   // the ocean: the band under the waves, moving with them, inside the boundary
    const W = oceanWaves(oc, g, oc.level - b.y0), v = [0, 0, 0];
    for (let x = b.x0 + d / 2; x < b.x1 && !full; x += d) for (let z = b.z0 + d / 2; z < b.z1 && !full; z += d) {
      if (1 - Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z) / Math.max(oc.layer, 1e-4) >= 0.5) continue;
      const eta = Math.min(oceanEtaJS(W, oc, x, z, t), b.y1 - d);
      for (let y = b.y0 + d / 2 + Math.max(0, Math.floor((eta - band - b.y0) / d)) * d; y < eta; y += d) { oceanVelJS(W, oc, b.y0, x, y, z, t, v); put(x, y, z, v[0], v[1], v[2]); }
    }
  }
  // spare slots, parked off the map, for the solver to refill the band with
  const seeded = sim.N - n0, spare = Math.min(sim.cap - sim.N, Math.ceil(0.35 * seeded) + 4000);
  for (let k = 0; k < spare && sim.N < sim.cap; k++) sim.add(0, -1e6, 0, 0, 0, 0);
  if (mode === 2) { sim.nbFills = (sim.nbFills || []).concat(prims); sim.nbFillVols = (sim.nbFillVols || []).concat(vols); }
  else { sim.nbFills = prims; sim.nbFillVols = vols; }
  sim.nbInit = mode || 1; sim.nbCfg = nb; sim.oceanCfg = oc;
  return { seeded, full };
}
