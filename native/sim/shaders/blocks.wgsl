// Sparse block allocation (which 8x8x8 blocks need storage) and the particle sort.
// Started from the web page's shader (src/flip/wgsl-*.js, 2026-10-29); now the desktop program's own source.

// ---- which blocks need storage ----
@compute @workgroup_size(1)
fn tileReset() { atomicStore(&ctl[3], 0u); atomicStore(&ctl[4], 0u); atomicStore(&ctl[5], 0u); atomicStore(&ctl[6], 0u); }
@compute @workgroup_size(256)
fn tileNeedClear(@builtin(global_invocation_id) g: vec3<u32>) { let t = gid1(g); if (t < ntiles()) { atomicStore(&need[t], 0u); } }
// every block within two cells of a particle: enough for the particle's own faces and for every neighbour those faces look at
@compute @workgroup_size(256)
fn tileMark(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let q = pos[i]; if (q.y < DEADY || isBallistic(i)) { return; }   // a drop flying free needs no grid around it
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
  pres[c] = 0.0; calm[c] = 0u;
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
// The key is the particle's block of cells in z-order (Morton order: nearby blocks get nearby keys), a counting sort over 32768 keys:
// 4x4x4 cell blocks while each side of the box is at most 128 cells, larger blocks beyond. It used to hash 4x4x4 blocks into 65536
// buckets, which put far-apart blocks in one bucket and neighbouring blocks far apart (as in Fernandez-Fernandez et al. 2022, the
// grouping only has to be nearly right, but it should follow space). Dead particles go last. Results do not depend on particle order.
fn spread5(v: u32) -> u32 { var x = v & 31u; x = (x | (x << 8u)) & 0x0300F00Fu; x = (x | (x << 4u)) & 0x030C30C3u; x = (x | (x << 2u)) & 0x09249249u; return x; }
fn sortShift() -> u32 { let m = max(max(P.nx, P.ny), P.nz); var sh = 2u; loop { if (((m - 1u) >> sh) < 32u || sh >= 12u) { break; } sh++; } return sh; }
fn sortKey(i: u32) -> u32 {
  let q = pos[i];
  if (q.y < DEADY) { return 65535u; }
  let c = vec3<u32>(particleCell(q.xyz)) >> vec3<u32>(sortShift());
  return spread5(c.x) | (spread5(c.y) << 1u) | (spread5(c.z) << 2u);
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

