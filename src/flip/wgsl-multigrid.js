// FLIP shader: multigrid for the pressure solve (opt.mg). Red-black sweeps alone move a change in pressure about a cell per sweep, so
// at fine spacings 30 sweeps leave deep water under-solved (it compresses, then springs back). A V-cycle hands the slow, smooth part of
// the error to coarser grids, where a sweep covers 2, 4, 8 ... cells.
// Levels: 0 the solver's cells; 1-3 inside each 8x8x8 block (4x4x4, 2x2x2, then one cell per block), stored per slot in mg (MGS floats
// a slot: for each level the right-hand side r, the correction e and the cell type t, 0 air, 1 water, 2 solid); 4 and up are small
// dense grids over the whole box (blocks/2, blocks/4, ...: P.mgD[l - 4] = size x, y, z and where they start in mg), until about 4 a side.
// A coarse cell is water if any of its 8 smaller cells is, else air if any is, else solid; air holds no correction (the surface), solid
// is a wall. Right-hand side: the 8 residuals added up, halved (the average, times 4 for the doubled cell size); the correction goes back
// to the 8 cells unchanged. Kernels are made per level (mgDown<L>, mgS<L>a/b, mgUp<L>) so the level is a constant in each.
const FLIP_MG_LEVELS = 7;   // 3 inside the blocks + up to 4 dense
const FLIP_WGSL_MG = (() => {
  let s = /* wgsl */ `
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
`;
  for (let L = 1; L <= FLIP_MG_LEVELS; L++) {
    if (L >= 2) s += `
@compute @workgroup_size(256)
fn mgDown${L}(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(${L}u, gid1(g)); if (a.w == 0) { return; }
  var sum = 0.0; var anyF = false; var anyA = false;
  for (var c = 0; c < 8; c++) {
    let ch = a.xyz * 2 + vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let q = mgCell(${L - 1}u, ch);
    if (q.t > 0.5 && q.t < 1.5) { anyF = true; let sn = mgNbr(${L - 1}u, ch); sum += mg[q.r] - (sn.y * mg[q.e] - sn.x); }
    else if (q.t < 0.5) { anyA = true; }
  }
  mgPut(${L}u, a.xyz, sum, anyF, anyA);
}`;
    for (const [nm, col] of [['a', 0], ['b', 1]]) s += `
@compute @workgroup_size(256)
fn mgS${L}${nm}(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(${L}u, gid1(g)); if (a.w == 0) { return; }
  if (u32(a.x + a.y + a.z) % 2u != ${col}u) { return; }
  let q = mgCell(${L}u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  let sn = mgNbr(${L}u, a.xyz);
  mg[q.e] = select((mg[q.r] + sn.x) / sn.y, 0.0, sn.y < 0.5);
}`;
    if (L < FLIP_MG_LEVELS) s += `
@compute @workgroup_size(256)
fn mgUp${L}(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = mgAt(${L}u, gid1(g)); if (a.w == 0) { return; }
  let q = mgCell(${L}u, a.xyz); if (q.t < 0.5 || q.t > 1.5) { return; }
  mg[q.e] += P.ext1.x * mgProl(${L + 1}u, a.xyz);
}`;
  }
  return s + '\n';
})();
// bindings of the multigrid kernels (merged into FLIP_L)
const FLIP_MG_L = (() => {
  const L = { mgArgs: [12, 14], mgDown1: [0, 7, 8, 9, 12, 16, 18, 19, 40], mgUp0: [0, 7, 8, 12, 16, 18, 19, 40] }, B = [0, 7, 12, 16, 18, 19, 40];
  for (let l = 1; l <= FLIP_MG_LEVELS; l++) {
    if (l >= 2) L['mgDown' + l] = B;
    L['mgS' + l + 'a'] = B; L['mgS' + l + 'b'] = B;
    if (l < FLIP_MG_LEVELS) L['mgUp' + l] = B;
  }
  return L;
})();
