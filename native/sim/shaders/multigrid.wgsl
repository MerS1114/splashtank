// Multigrid pressure: levels inside each block, then dense levels over the box.
// Started from the web page's shader (src/flip/wgsl-*.js, 2026-10-29); now the desktop program's own source.

const MGS: u32 = 220u;
struct MC { r: u32, e: u32, t: f32 };
// coarse cell G of level l: where its numbers are in mg and its type (outside the box: wall or open side; a block without storage: air)
fn mgCell(l: u32, G: vec3<i32>) -> MC {
  var m: MC; m.t = 0.0; m.r = 0u; m.e = 0u;
  let f = G * i32(1u << l);
  if (f.x < 0 || f.y < 0 || f.z < 0 || f.x >= i32(P.nx) || f.y >= i32(P.ny) || f.z >= i32(P.nz)) { m.t = f32(ctypeOf(f.x, f.y, f.z)); return m; }
  if (l <= 3u) {
    let n = 8 >> l; let B = G / n; let sl = tmap[u32(B.x) + P.tx * (u32(B.y) + P.ty * u32(B.z))];
    if (sl == NONE) { return m; }
    let q = G - B * n; let li = u32(q.x + n * (q.y + n * q.z)); let n3 = u32(n * n * n);
    let base = sl * MGS + select(select(216u, 192u, l == 2u), 0u, l == 1u);
    m.r = base + li; m.e = base + n3 + li; m.t = mg[base + 2u * n3 + li]; return m;
  }
  let d = P.mgD[l - 4u]; let li = u32(G.x) + d.x * (u32(G.y) + d.y * u32(G.z)); let N = d.x * d.y * d.z;
  m.r = d.w + li; m.e = d.w + N + li; m.t = mg[d.w + 2u * N + li]; return m;
}
// the corrections of the six neighbours added up (x), and how many are not walls (y)
fn mgNbr(l: u32, G: vec3<i32>) -> vec2<f32> {
  var sum = 0.0; var nns = 0.0;
  for (var a = 0u; a < 6u; a++) {
    var q = G;
    if (a == 0u) { q.x -= 1; } else if (a == 1u) { q.x += 1; } else if (a == 2u) { q.y -= 1; } else if (a == 3u) { q.y += 1; } else if (a == 4u) { q.z -= 1; } else { q.z += 1; }
    let c = mgCell(l, q);
    if (c.t > 1.5) { continue; }
    nns += 1.0;
    if (c.t > 0.5) { sum += mg[c.e]; }
  }
  return vec2<f32>(sum, nns);
}
// thread t of a level's dispatch -> its cell (w = 0: none). Levels 1-3 go over the blocks in use, dense levels over their whole grid.
fn mgAt(l: u32, t: u32) -> vec4<i32> {
  if (l <= 3u) {
    let n = 8 >> l; let m = u32(n * n * n);
    if (t >= atomicLoad(&ctl[4]) * m) { return vec4<i32>(0); }
    let sl = slotList[t / m]; let li = i32(t % m); let tl = slotTile[sl]; let tt = tl / P.tx;
    let B = vec3<i32>(i32(tl % P.tx), i32(tt % P.ty), i32(tt / P.ty));
    return vec4<i32>(B * n + vec3<i32>(li % n, (li / n) % n, li / (n * n)), 1);
  }
  let d = P.mgD[l - 4u];
  if (t >= d.x * d.y * d.z) { return vec4<i32>(0); }
  return vec4<i32>(i32(t % d.x), i32((t / d.x) % d.y), i32(t / (d.x * d.y)), 1);
}
fn mgPut(l: u32, G: vec3<i32>, sum: f32, anyF: bool, anyA: bool) {
  let me = mgCell(l, G); if (me.e == 0u && me.r == 0u) { return; }
  let n3 = me.e - me.r;
  mg[me.r] = 0.5 * sum; mg[me.e] = 0.0; mg[me.e + n3] = select(select(2.0, 0.0, anyA), 1.0, anyF && !anyA);
}
// the correction of level l at cell f of level l - 1, trilinear from the parent and its neighbours on f's side (weights 3/4 and 1/4 per
// axis; constant from the parent alone converged poorly: for cell-centred grids the two transfers' orders must add up to more than 2).
// A wall takes the parent's value (nothing flows through it), air holds no correction.
fn mgProl(l: u32, f: vec3<i32>) -> f32 {
  let pc = f / 2; let sd = (f - pc * 2) * 2 - vec3<i32>(1);
  let par = mgCell(l, pc); if (par.t < 0.5 || par.t > 1.5) { return 0.0; }
  let ep = mg[par.e]; var v = 0.0;
  for (var c = 0; c < 8; c++) {
    let o = vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let w = select(0.75, 0.25, o.x == 1) * select(0.75, 0.25, o.y == 1) * select(0.75, 0.25, o.z == 1);
    if (c == 0) { v += w * ep; continue; }
    let q = mgCell(l, pc + o * sd);
    if (q.t > 1.5) { v += w * ep; } else if (q.t > 0.5) { v += w * mg[q.e]; }
  }
  return v;
}
@compute @workgroup_size(1)
fn mgArgs() { let sc = atomicLoad(&ctl[4]); split((sc * 64u + 255u) / 256u, 32u); split((sc * 8u + 255u) / 256u, 36u); split((sc + 255u) / 256u, 40u); }
// level 1 from the solver's cells: their residuals (what one exact solve would still have to remove) added up
@compute @workgroup_size(256)
fn mgDown1(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(1u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let ty = ctypeOf(ch.x, ch.y, ch.z);
    if (ty == 1u) { anyF = true; let ci = cellIdx(ch.x, ch.y, ch.z); let sn = presNbr(ch.x, ch.y, ch.z); sum += rhs[ci] - (sn.y * pres[ci] - sn.x); }
    else if (ty == 0u) { anyA = true; }
  }
  mgPut(1u, a.xyz, sum, anyF, anyA);
}
// the correction back into the pressure of the solver's cells
@compute @workgroup_size(256)
fn mgUp0(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  if ((ctype[a.c] & 0xffu) != 1u) { return; }
  pres[a.c] += P.ext1.x * mgProl(1u, a.p);
}

@compute @workgroup_size(256)
fn mgS1a(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(1u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 0u) { return; }
  let q = mgCell(1u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(1u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgS1b(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(1u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 1u) { return; }
  let q = mgCell(1u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(1u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgUp1(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(1u, gid1(g)); if (a.w == 0) { return; }
  let q = mgCell(1u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  mg[q.e] += P.ext1.x * mgProl(2u, a.xyz);
}
@compute @workgroup_size(256)
fn mgDown2(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(2u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let q = mgCell(1u, ch);
    if (q.t > 0.5 && q.t < 1.5) { anyF = true; let sn = mgNbr(1u, ch); sum += mg[q.r] - (sn.y * mg[q.e] - sn.x); }
    else if (q.t < 0.5) { anyA = true; }
  }
  mgPut(2u, a.xyz, sum, anyF, anyA);
}
@compute @workgroup_size(256)
fn mgS2a(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(2u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 0u) { return; }
  let q = mgCell(2u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(2u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgS2b(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(2u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 1u) { return; }
  let q = mgCell(2u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(2u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgUp2(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(2u, gid1(g)); if (a.w == 0) { return; }
  let q = mgCell(2u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  mg[q.e] += P.ext1.x * mgProl(3u, a.xyz);
}
@compute @workgroup_size(256)
fn mgDown3(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(3u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let q = mgCell(2u, ch);
    if (q.t > 0.5 && q.t < 1.5) { anyF = true; let sn = mgNbr(2u, ch); sum += mg[q.r] - (sn.y * mg[q.e] - sn.x); }
    else if (q.t < 0.5) { anyA = true; }
  }
  mgPut(3u, a.xyz, sum, anyF, anyA);
}
@compute @workgroup_size(256)
fn mgS3a(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(3u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 0u) { return; }
  let q = mgCell(3u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(3u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgS3b(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(3u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 1u) { return; }
  let q = mgCell(3u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(3u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgUp3(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(3u, gid1(g)); if (a.w == 0) { return; }
  let q = mgCell(3u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  mg[q.e] += P.ext1.x * mgProl(4u, a.xyz);
}
@compute @workgroup_size(256)
fn mgDown4(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(4u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let q = mgCell(3u, ch);
    if (q.t > 0.5 && q.t < 1.5) { anyF = true; let sn = mgNbr(3u, ch); sum += mg[q.r] - (sn.y * mg[q.e] - sn.x); }
    else if (q.t < 0.5) { anyA = true; }
  }
  mgPut(4u, a.xyz, sum, anyF, anyA);
}
@compute @workgroup_size(256)
fn mgS4a(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(4u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 0u) { return; }
  let q = mgCell(4u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(4u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgS4b(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(4u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 1u) { return; }
  let q = mgCell(4u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(4u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgUp4(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(4u, gid1(g)); if (a.w == 0) { return; }
  let q = mgCell(4u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  mg[q.e] += P.ext1.x * mgProl(5u, a.xyz);
}
@compute @workgroup_size(256)
fn mgDown5(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(5u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let q = mgCell(4u, ch);
    if (q.t > 0.5 && q.t < 1.5) { anyF = true; let sn = mgNbr(4u, ch); sum += mg[q.r] - (sn.y * mg[q.e] - sn.x); }
    else if (q.t < 0.5) { anyA = true; }
  }
  mgPut(5u, a.xyz, sum, anyF, anyA);
}
@compute @workgroup_size(256)
fn mgS5a(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(5u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 0u) { return; }
  let q = mgCell(5u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(5u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgS5b(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(5u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 1u) { return; }
  let q = mgCell(5u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(5u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgUp5(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(5u, gid1(g)); if (a.w == 0) { return; }
  let q = mgCell(5u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  mg[q.e] += P.ext1.x * mgProl(6u, a.xyz);
}
@compute @workgroup_size(256)
fn mgDown6(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(6u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let q = mgCell(5u, ch);
    if (q.t > 0.5 && q.t < 1.5) { anyF = true; let sn = mgNbr(5u, ch); sum += mg[q.r] - (sn.y * mg[q.e] - sn.x); }
    else if (q.t < 0.5) { anyA = true; }
  }
  mgPut(6u, a.xyz, sum, anyF, anyA);
}
@compute @workgroup_size(256)
fn mgS6a(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(6u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 0u) { return; }
  let q = mgCell(6u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(6u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgS6b(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(6u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 1u) { return; }
  let q = mgCell(6u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(6u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgUp6(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(6u, gid1(g)); if (a.w == 0) { return; }
  let q = mgCell(6u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  mg[q.e] += P.ext1.x * mgProl(7u, a.xyz);
}
@compute @workgroup_size(256)
fn mgDown7(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(7u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let q = mgCell(6u, ch);
    if (q.t > 0.5 && q.t < 1.5) { anyF = true; let sn = mgNbr(6u, ch); sum += mg[q.r] - (sn.y * mg[q.e] - sn.x); }
    else if (q.t < 0.5) { anyA = true; }
  }
  mgPut(7u, a.xyz, sum, anyF, anyA);
}
@compute @workgroup_size(256)
fn mgS7a(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(7u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 0u) { return; }
  let q = mgCell(7u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(7u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
@compute @workgroup_size(256)
fn mgS7b(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(7u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != 1u) { return; }
  let q = mgCell(7u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(7u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}
