// Native only (not part of the page's shader): tall cells for deep narrow-band water (after Irving et al. 2006, simplified).
// Below row T (a whole number of 8-cell block rows) every column of water is one tall cell: no blocks are stored there. A tall cell keeps
// one pressure, for its top cell (row T - 1; the pressure further down adds the hydrostatic part, gravity x h a cell), and the sideways
// flow averaged over its height on its four sides (U on x faces, W on z faces). Its top face is the bottom face of the ordinary cell above,
// whose vertical velocity is stored as usual; inside, the vertical velocity goes linearly from that to 0 at the floor. Mass: what flows out
// of a column's sides (its height in cells x the face velocities) and out of its top adds up to the divergence, solved together with the
// ordinary cells (the cell above sees the tall pressure as its lower neighbour). When the surface, particles or anything not water comes
// within a margin of row T, T goes down one block row: those cells are made ordinary again from the tall cell's flow and pressure.
//
// tall[]: 0 T (cells), 1 T before this step, 2 release wanted, 3 margin (cells), 4-7 spare; then per column (i + nx k) the pressure and
// its right-hand side, then U ((nx + 1) x nz) and W (nx x (nz + 1)).
@group(0) @binding(43) var<storage, read_write> tall: array<f32>;
const TALLH: u32 = 8u;
fn tallT() -> i32 { return i32(tall[0]); }
fn tallCol(i: i32, k: i32) -> u32 { return TALLH + u32(clamp(i, 0, i32(P.nx) - 1)) + P.nx * u32(clamp(k, 0, i32(P.nz) - 1)); }
fn tallRhs(i: i32, k: i32) -> u32 { return tallCol(i, k) + P.nx * P.nz; }
fn tallU(i: i32, k: i32) -> u32 { return TALLH + 2u * P.nx * P.nz + u32(clamp(i, 0, i32(P.nx))) + (P.nx + 1u) * u32(clamp(k, 0, i32(P.nz) - 1)); }
fn tallW(i: i32, k: i32) -> u32 { return TALLH + 2u * P.nx * P.nz + (P.nx + 1u) * P.nz + u32(clamp(i, 0, i32(P.nx) - 1)) + P.nx * u32(clamp(k, 0, i32(P.nz))); }
// the pressure of cell q, for a neighbour below row T: the tall cell's, with the hydrostatic part for cells below its top cell
fn presAt(q: vec3<i32>) -> f32 {
  if (q.y < tallT()) { return tall[tallCol(q.x, q.z)] + f32(tallT() - 1 - q.y) * P.gravity * P.h; }
  return pres[cellIdx(q.x, q.y, q.z)];
}
// the kept grid velocity on face (axis, cell f), the tall cells' below row T
fn velGF(axis: u32, f: vec3<i32>) -> f32 {
  let T = tallT();
  if (f.y < T && f.y >= 0) {
    if (axis == 0u) { return tall[tallU(f.x, f.z)]; }
    if (axis == 2u) { return tall[tallW(f.x, f.z)]; }
    let ix = clamp(f.x, 0, i32(P.nx) - 1); let kz = clamp(f.z, 0, i32(P.nz) - 1);
    return velG[faceIndex(1u, ix, T, kz)] * f32(f.y) / f32(T);
  }
  return velG[faceIndex(axis, f.x, f.y, f.z)];
}
// once a step, first: T goes down a block row when the last step asked for it
@compute @workgroup_size(1)
fn tallStep() {
  let T = tall[0];
  tall[1] = T;
  if (T > 0.0 && tall[2] > 0.5) { tall[0] = max(T - 8.0, 0.0); }
  tall[2] = 0.0;
}
// the cells that just stopped being tall (rows T to T before): water, deep, with the tall cell's flow and pressure
@compute @workgroup_size(256)
fn tallFill(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  let T = tallT(); let To = i32(tall[1]);
  if (a.p.y < T || a.p.y >= To || !inDom(a.p)) { return; }
  let c = a.c;
  ctype[c] = (ctype[c] & 0xff00u) | 1u;
  phiPut(c, -7.9);
  let wt = velG[faceIndex(1u, a.p.x, To, a.p.z)];
  velG[c * 3u] = tall[tallU(a.p.x, a.p.z)];
  velG[c * 3u + 1u] = wt * f32(a.p.y) / f32(To);
  velG[c * 3u + 2u] = tall[tallW(a.p.x, a.p.z)];
  pres[c] = tall[tallCol(a.p.x, a.p.z)] + f32(To - 1 - a.p.y) * P.gravity * P.h;
}
// each column's divergence: out through its sides (its height in cells x the face velocities) and its top
@compute @workgroup_size(256)
fn tallDiv(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); if (t >= P.nx * P.nz || tallT() <= 0) { return; }
  let i = i32(t % P.nx); let k = i32(t / P.nx); let H = f32(tallT());
  let side = tall[tallU(i + 1, k)] - tall[tallU(i, k)] + tall[tallW(i, k + 1)] - tall[tallW(i, k)];
  let top = gvR(faceIndex(1u, i, tallT(), k));
  tall[tallRhs(i, k)] = -(H * side + top) * P.h / P.dt;
}
fn tallRelax(t: u32, color: u32) {
  if (t >= P.nx * P.nz || tallT() <= 0) { return; }
  let i = i32(t % P.nx); let k = i32(t / P.nx);
  if (u32((i + k) & 1) != color) { return; }
  let H = f32(tallT());
  var sum = 0.0; var dg = 0.0;
  for (var q = 0u; q < 4u; q++) {
    var n = vec2<i32>(i, k);
    if (q == 0u) { n.x -= 1; } else if (q == 1u) { n.x += 1; } else if (q == 2u) { n.y -= 1; } else { n.y += 1; }
    let out = n.x < 0 || n.y < 0 || n.x >= i32(P.nx) || n.y >= i32(P.nz);
    if (out) {
      let bit = select(select(select(16u, 32u, q == 3u), 2u, q == 1u), 1u, q == 0u);
      if ((P.open & bit) != 0u) { dg += H; }   // an open side: pressure 0 out there
      continue;
    }
    dg += H; sum += H * tall[tallCol(n.x, n.y)];
  }
  let ty = ctypeOf(i, tallT(), k);
  if (ty == 1u) { dg += 1.0; sum += pres[cellIdx(i, tallT(), k)]; } else if (ty == 0u) { dg += 1.0; }
  if (dg < 0.5) { return; }
  let c = tallCol(i, k);
  tall[c] = tall[c] + P.omega * ((tall[tallRhs(i, k)] + sum) / dg - tall[c]);
}
@compute @workgroup_size(256)
fn tallRed(@builtin(global_invocation_id) g: vec3<u32>) { tallRelax(gid1(g), 0u); }
@compute @workgroup_size(256)
fn tallBlack(@builtin(global_invocation_id) g: vec3<u32>) { tallRelax(gid1(g), 1u); }
// the sideways flow takes the pressure differences between columns (closed walls: none through them)
@compute @workgroup_size(256)
fn tallProj(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); let nx = i32(P.nx); let nz = i32(P.nz);
  if (t >= (P.nx + 1u) * (P.nz + 1u) || tallT() <= 0) { return; }
  let i = i32(t % (P.nx + 1u)); let k = i32(t / (P.nx + 1u));
  let s = P.dt * P.ih;
  if (k < nz) {
    let f = tallU(i, k);
    if (i == 0 || i == nx) {
      let open = select((P.open & 1u) != 0u, (P.open & 2u) != 0u, i == nx);
      if (!open) { tall[f] = 0.0; } else { let pin = tall[tallCol(select(0, nx - 1, i == nx), k)]; tall[f] -= s * select(pin, -pin, i == 0); }
    } else { tall[f] -= s * (tall[tallCol(i, k)] - tall[tallCol(i - 1, k)]); }
  }
  if (i < nx) {
    let f = tallW(i, k);
    if (k == 0 || k == nz) {
      let open = select((P.open & 16u) != 0u, (P.open & 32u) != 0u, k == nz);
      if (!open) { tall[f] = 0.0; } else { let pin = tall[tallCol(i, select(0, nz - 1, k == nz))]; tall[f] -= s * select(pin, -pin, k == 0); }
    } else { tall[f] -= s * (tall[tallCol(i, k)] - tall[tallCol(i, k - 1)]); }
  }
}
// the surface, particles or anything not deep water within the margin above row T: let a block row go back to ordinary cells
@compute @workgroup_size(256)
fn tallCheck(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  let T = tallT(); if (T <= 0 || a.p.y < T || a.p.y >= T + i32(tall[3]) || !inDom(a.p)) { return; }
  let c = a.c;
  // air, an object (a solid cell with a collider; the ocean's boundary along the sides is solid too, but it is water moving with the
  // waves and may sit over tall cells), the surface or particles
  let ty = ctype[c] & 0xffu;
  if (ty == 0u || (ty == 2u && (ctype[c] & 0x7f00u) != 0u) || (ty == 1u && phiOf(c) > -2.0) || atomicLoad(&cnt[c]) > 0) { tall[2] = 1.0; }
}
// look only: points in the tall cells (deep water), as deepPick does for ordinary deep cells
@compute @workgroup_size(256)
fn tallPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g); let T = u32(max(tallT(), 0));
  if (t >= P.nx * P.nz * T) { return; }
  let col = t % (P.nx * P.nz); let j = i32(t / (P.nx * P.nz)); let i = i32(col % P.nx); let k = i32(col / P.nx);
  atomicAdd(&ctl[11], 1u);
  let prev = atomicLoad(&ctl[12]);
  if (prev > DEEPMAX && hash1(t * 2654435761u + 7u) * f32(prev) >= f32(DEEPMAX)) { return; }
  let s = atomicAdd(&ctl[13], 1u); if (s >= DEEPMAX) { return; }
  let o = u32(P.opad) + s; if (o >= arrayLength(&disp)) { return; }
  let x = cellCenter(i, j, k);
  let v = vec2<f32>(0.5 * (tall[tallU(i, k)] + tall[tallU(i + 1, k)]), 0.5 * (tall[tallW(i, k)] + tall[tallW(i, k + 1)]));
  disp[o] = vec4<f32>(x, 4096.0 + min(length(v), 63.0));
}
