// Narrow band: the depth field, trimming and refilling the band of particles under the surface.
// Started from the web page's shader (src/flip/wgsl-*.js, 2026-10-29); now the desktop program's own source.

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
  if (i32(tt % P.ty) * 8 < tallT()) { return; }
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
    if (n.y < tallT()) { m = max(m, -7.9); continue; }
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
    if (ctypeOf(lo.x, lo.y, lo.z) != 1u) { continue; }
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
  if (!kill && P.nb != 0u && calmV(vel[i].xyz)) { let cc = particleCell(q.xyz); if (cc.y < tallT() || (hasStorage(cc) && phiOf(cellIdx(cc.x, cc.y, cc.z)) < -P.band)) { kill = true; } }
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
    let fast = !calmV(velGVec(cx));
    if ((ctype[c] & 0xffu) != 1u || ph > -1.0 || (ph < -P.band && !fast)) { return; }
    // fast water thinning out is spray and foam, not missing water; but a fast water cell with no particles at all is deep water an
    // impact set moving: it gets particles at any depth, moving with it, so the impact runs as full FLIP (grid-only deep water is
    // smoothed by its semi-Lagrangian velocity and pushed the lake up in a broad mound instead of throwing a crown; once calm, nbKill
    // trims them again). Only where the deeper cells around it have no particles either (grid-only water): a gap in a thinning splash
    // has particles around it, and refilling those added water wherever a splash spread out
    if (fast) {
      if (atomicLoad(&cnt[c]) > 0) { return; }
      for (var q = 0u; q < 6u; q++) {
        var p = a.p;
        if (q == 0u) { p.x -= 1; } else if (q == 1u) { p.x += 1; } else if (q == 2u) { p.y -= 1; } else if (q == 3u) { p.y += 1; } else if (q == 4u) { p.z -= 1; } else { p.z += 1; }
        if (!inDom(p) || !hasStorage(p)) { continue; }
        let cq = cellIdx(p.x, p.y, p.z);
        if (phiOf(cq) < ph && atomicLoad(&cnt[cq]) > 0) { return; }
      }
    }
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
    if (P.ext1.y > 0.5) { for (var a = 0u; a < 3u; a++) { aff[i * 3u + a] = vec4<f32>(0.0); } }   // APIC: a new particle has no gradient yet
  }
}
