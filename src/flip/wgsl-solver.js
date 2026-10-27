// FLIP shader: one solver step (clear, particle to grid, classify, divergence, pressure, project, collisions, grid to particle).
const FLIP_WGSL_SOLVER = /* wgsl */ `
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
// Particle to grid, grouped (Speed-ups > Grouped transfer; p2g below is the plain one). Sorted particles (Speed-ups > Sort particles) lie close together, so the 256 of a workgroup usually fall within a few
// cells: they first add into a 11x11x11 window of faces in workgroup memory, and each touched face is then added to the grid once, instead
// of 48 global atomic adds per particle fighting over the same faces. The sums are integers, so the result is exactly the same.
// A workgroup whose particles spread wider (unsorted, or at the edge of a sort run) adds straight to the grid as before.
var<workgroup> p2gAcc: array<atomic<i32>, 2662>;   // 1331 faces of one axis: velocity, weight
var<workgroup> p2gLo: array<atomic<i32>, 3>;
var<workgroup> p2gHi: array<atomic<i32>, 3>;
var<workgroup> p2gOk: u32;
var<workgroup> p2gO: vec3<i32>;
fn p2gFace(axis: u32, c: vec3<i32>, vc: f32, w: f32) {
  let idx = faceIndex(axis, c.x, c.y, c.z);
  atomicAdd(&accV[idx], i32(round(w * vc * P.scale)));
  atomicAdd(&accW[idx], i32(round(w * P.scale)));
}
@compute @workgroup_size(256)
fn p2gWin(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = gid1(g);
  var ok = i < P.n; var p = vec3<f32>(0.0); var v = vec3<f32>(0.0); var cc = vec3<i32>(0);
  if (ok) { p = pos[i].xyz; ok = pos[i].y >= DEADY && !isBallistic(i); }
  if (ok) { cc = particleCell(p); ok = hasStorage(cc); }   // no storage only when the block pool is full; it grows on the next steps
  if (ok) { v = vel[i].xyz; }
  if (lid == 0u) { for (var k = 0u; k < 3u; k++) { atomicStore(&p2gLo[k], 1 << 30); atomicStore(&p2gHi[k], -(1 << 30)); } }
  workgroupBarrier();
  if (ok) { for (var k = 0u; k < 3u; k++) { atomicMin(&p2gLo[k], cc[k]); atomicMax(&p2gHi[k], cc[k]); } }
  workgroupBarrier();
  if (lid == 0u) {
    let lo = vec3<i32>(atomicLoad(&p2gLo[0]), atomicLoad(&p2gLo[1]), atomicLoad(&p2gLo[2])); let hi = vec3<i32>(atomicLoad(&p2gHi[0]), atomicLoad(&p2gHi[1]), atomicLoad(&p2gHi[2]));
    p2gOk = select(0u, 1u, all(hi - lo <= vec3<i32>(8)) && all(hi >= lo)); p2gO = lo - vec3<i32>(1);
  }
  let win = workgroupUniformLoad(&p2gOk);
  let o = p2gO;
  for (var axis = 0u; axis < 3u; axis++) {
    if (win == 1u) {
      for (var e = lid; e < 2662u; e += 256u) { atomicStore(&p2gAcc[e], 0); }
      workgroupBarrier();
    }
    if (ok) {
      var q = (p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih;
      if (axis == 0u) { q.y -= 0.5; q.z -= 0.5; } else if (axis == 1u) { q.x -= 0.5; q.z -= 0.5; } else { q.x -= 0.5; q.y -= 0.5; }
      let f0 = floor(q); let fr = q - f0; let i0 = vec3<i32>(f0);
      var vc = v.x; if (axis == 1u) { vc = v.y; } else if (axis == 2u) { vc = v.z; }
      for (var c = 0u; c < 8u; c++) {
        let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
        let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
        if (w <= 0.0) { continue; }
        let gc = i0 + vec3<i32>(dx, dy, dz); let l = gc - o;
        if (win == 1u && all(l >= vec3<i32>(0)) && all(l < vec3<i32>(11))) {
          let e = u32(l.x + 11 * (l.y + 11 * l.z)) * 2u;
          atomicAdd(&p2gAcc[e], i32(round(w * vc * P.scale))); atomicAdd(&p2gAcc[e + 1u], i32(round(w * P.scale)));
        } else { p2gFace(axis, gc, vc, w); }
      }
    }
    if (win == 1u) {
      workgroupBarrier();
      for (var e = lid; e < 1331u; e += 256u) {
        let sv = atomicLoad(&p2gAcc[e * 2u]); let sw = atomicLoad(&p2gAcc[e * 2u + 1u]);
        if (sv == 0 && sw == 0) { continue; }
        let gc = o + vec3<i32>(i32(e % 11u), i32((e / 11u) % 11u), i32(e / 121u));
        let idx = faceIndex(axis, gc.x, gc.y, gc.z);
        atomicAdd(&accV[idx], sv); atomicAdd(&accW[idx], sw);
      }
      workgroupBarrier();
    }
  }
  if (ok) { atomicMax(&ctl[6], bitcast<u32>(length(v))); atomicAdd(&cnt[cellIdx(cc.x, cc.y, cc.z)], 1); }
}
@compute @workgroup_size(256)
fn p2g(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let p = pos[i].xyz;
  if (pos[i].y < DEADY || isBallistic(i)) { return; }
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
  if (pos[i].y < DEADY || isBallistic(i)) { return; }
  let p = pos[i].xyz;
  let v0 = vel[i].xyz;
  let fcell = particleCell(p);
  var vn = v0 - vec3<f32>(0.0, P.gravity * P.dt, 0.0); var vo = v0;   // falls freely if its block had no room this step
  if (hasStorage(fcell)) { let s2 = sampleBoth(p); vn = s2.vn; vo = s2.vo; }
  g2pRest(i, p, v0, fcell, vn, vo);
}
// Grid to particle, grouped (Speed-ups > Grouped transfer, with p2gWin): the 256 particles of a workgroup usually lie within a few cells
// once sorted, so the grid faces around them (an 11x11x11 window, one axis at a time, new and old velocity) are read into workgroup memory
// once, instead of every particle looking up 48 faces, each through its block, on its own. The same sums in the same order: identical.
@compute @workgroup_size(256)
fn g2pWin(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = gid1(g);
  var ok = i < P.n; var p = vec3<f32>(0.0); var v0 = vec3<f32>(0.0); var fcell = vec3<i32>(0); var st = false;
  if (ok) { ok = pos[i].y >= DEADY && !isBallistic(i); }
  if (ok) { p = pos[i].xyz; v0 = vel[i].xyz; fcell = particleCell(p); st = hasStorage(fcell); }
  if (lid == 0u) { for (var k = 0u; k < 3u; k++) { atomicStore(&p2gLo[k], 1 << 30); atomicStore(&p2gHi[k], -(1 << 30)); } }
  workgroupBarrier();
  if (ok && st) { for (var k = 0u; k < 3u; k++) { atomicMin(&p2gLo[k], fcell[k]); atomicMax(&p2gHi[k], fcell[k]); } }
  workgroupBarrier();
  if (lid == 0u) {
    let lo = vec3<i32>(atomicLoad(&p2gLo[0]), atomicLoad(&p2gLo[1]), atomicLoad(&p2gLo[2])); let hi = vec3<i32>(atomicLoad(&p2gHi[0]), atomicLoad(&p2gHi[1]), atomicLoad(&p2gHi[2]));
    p2gOk = select(0u, 1u, all(hi - lo <= vec3<i32>(8)) && all(hi >= lo)); p2gO = lo - vec3<i32>(1);
  }
  let win = workgroupUniformLoad(&p2gOk);
  let o = p2gO;
  var vn = v0 - vec3<f32>(0.0, P.gravity * P.dt, 0.0); var vo = v0;
  for (var axis = 0u; axis < 3u; axis++) {
    if (win == 1u) {
      for (var e = lid; e < 1331u; e += 256u) {
        let gc = o + vec3<i32>(i32(e % 11u), i32((e / 11u) % 11u), i32(e / 121u));
        let f = faceIndex(axis, gc.x, gc.y, gc.z);
        atomicStore(&p2gAcc[e * 2u], bitcast<i32>(gvR(f))); atomicStore(&p2gAcc[e * 2u + 1u], bitcast<i32>(gv0R(f)));
      }
      workgroupBarrier();
    }
    if (ok && st) {
      var q = (p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih;
      if (axis == 0u) { q.y -= 0.5; q.z -= 0.5; } else if (axis == 1u) { q.x -= 0.5; q.z -= 0.5; } else { q.x -= 0.5; q.y -= 0.5; }
      let f0 = floor(q); let fr = q - f0; let i0 = vec3<i32>(f0);
      var sn = 0.0; var so = 0.0;
      for (var c = 0u; c < 8u; c++) {
        let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
        let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
        let gc = i0 + vec3<i32>(dx, dy, dz); let l = gc - o;
        if (win == 1u && all(l >= vec3<i32>(0)) && all(l < vec3<i32>(11))) {
          let e = u32(l.x + 11 * (l.y + 11 * l.z)) * 2u;
          sn += w * bitcast<f32>(atomicLoad(&p2gAcc[e])); so += w * bitcast<f32>(atomicLoad(&p2gAcc[e + 1u]));
        } else { let f = faceIndex(axis, gc.x, gc.y, gc.z); sn += w * gvR(f); so += w * gv0R(f); }
      }
      vn[axis] = sn; vo[axis] = so;
    }
    if (win == 1u) { workgroupBarrier(); }
  }
  if (ok) { g2pRest(i, p, v0, fcell, vn, vo); }
}
// everything g2p does after reading the grid: FLIP/PIC blend, white-water level, air drag, collisions, open walls
fn g2pRest(i: u32, p: vec3<f32>, v0: vec3<f32>, fcell: vec3<i32>, vn: vec3<f32>, vo: vec3<f32>) {
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
  // a drop on its own (at most a couple of others in the cells around it) moving over a third of a cell a step flies free of the grid:
  // the grid then picks its substeps from the water that is still together, not from the fastest flying drop
  let alone = P.q9 < 0.5 && select(csum < 3.5, csum < 8.5, fast);   // up to 3 particles in the 8 cells around; fast: csum is 8 x its own cell's count
  vel[i] = vec4<f32>(v, foam + select(0.0, 2.0, P.ext0.x > 0.5 && alone && length(v) * P.dt > 0.35 * P.h));
}
// Fast drops flying free (Speed-ups > Fast drops fly free): a ballistic particle is moved here instead of by the grid: gravity, air
// drag towards the wind (as a lone drop in g2p), the colliders and the walls, in as many small steps of its own as its speed needs.
// It joins the water again when it reaches a cell with water in it or slows down.
@compute @workgroup_size(256)
fn ballistic(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  if (pos[i].y < DEADY || !isBallistic(i)) { return; }
  var p = pos[i].xyz; var v = vel[i].xyz; var foam = vel[i].w - 2.0;
  let n = u32(clamp(ceil(length(v) * P.dt / (0.5 * P.h)), 1.0, 32.0)); let dt = P.dt / f32(n);
  let kd = P.q4 * 1.54;
  for (var k = 0u; k < n; k++) {
    var gust = vec3<f32>(0.0);
    if (P.q7 > 0.0 && P.q4 > 0.0) {
      let gp = p * 0.55; let tt = P.q8 * 0.6;
      gust = vec3<f32>(vnz(gp + vec3<f32>(tt, 0.0, 0.0)), vnz(gp + vec3<f32>(17.3, tt, 4.1)), vnz(gp + vec3<f32>(5.7, 9.2, tt))) * 2.0 - vec3<f32>(1.0);
    }
    v.y -= P.gravity * dt;
    v = v + (vec3<f32>(P.q1, P.q2, P.q3) + gust * P.q7 - v) * (1.0 - exp(-kd * dt));
    let sp = length(v); if (sp > P.vmax) { v = v * (P.vmax / sp); }
    let pt = p + v * dt; let pc = collideP(pt); let dsp = pc - pt;
    if (dot(dsp, dsp) > 1.0e-12) { let nrm = normalize(dsp); let vd = dot(v, nrm); if (vd < 0.0) { v = v - vd * nrm; } }
    p = pc;
    let o = P.open;
    if (o != 0u && (((o & 1u) != 0u && p.x < P.x0) || ((o & 2u) != 0u && p.x > P.x1) || ((o & 4u) != 0u && p.y < P.y0) ||
        ((o & 8u) != 0u && p.y > P.y1) || ((o & 16u) != 0u && p.z < P.z0) || ((o & 32u) != 0u && p.z > P.z1))) {
      pos[i] = vec4<f32>(0.0, -1.0e6, 0.0, 0.0); vel[i] = vec4<f32>(0.0); return;
    }
    let c = particleCell(p);
    if (hasStorage(c) && atomicLoad(&cnt[cellIdx(c.x, c.y, c.z)]) > 0) { break; }   // reached water: joins it below
  }
  // airborne drops stay white, as in g2p for a drop in open air
  foam = max(foam * exp(-P.dt / (max(P.q5, 0.05) * 2.5)), 0.9 * (0.25 + 0.75 * clamp(length(v) / 4.0, 0.0, 1.0)));
  let c = particleCell(p);
  let land = hasStorage(c) && atomicLoad(&cnt[cellIdx(c.x, c.y, c.z)]) > 0;
  let slow = length(v) * P.dt < 0.15 * P.h;   // well below the speed it left at, so it does not flip back and forth
  pos[i] = vec4<f32>(p, min(length(v), 63.0) + 64.0 * floor(foam * 15.0 + 0.5));
  vel[i] = vec4<f32>(v, foam + select(2.0, 0.0, land || slow || P.ext0.x < 0.5));
}
`;
