// Bake points drawn straight from the cache file's layout: a port of the page's three point shaders (VW, VD, VS and FRAG in
// src/app/02-viewport.js). Water is blended between two frames (A and B; a particle keeps its number), deep water and whitewater come
// from the nearer frame, and look-only extras are placed by a hash of the point number (whitewater: of its slot seed). Each copy of a
// point is a camera-facing square of 6 vertices sized like the page's gl_PointSize (pixels = size x scale / depth).
// Compact frames hold a u32 position across the box (bits q) and a u16 speed | level << 8 (bit 12: buried); the 16-bit layout holds
// 3 x u16 positions and u8 speeds (and u8 levels x 17). Whitewater holds 32-bit codes.

struct Cam {
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  org: vec4<f32>,      // xyz: cache origin added to every point
  vp: vec4<f32>,       // viewport width, height (px); z: uScale (px a unit at depth 1), w: uOrtho (px a unit, orthographic; 0 perspective)
  a: vec4<f32>,        // uSize (point size, scene units), uD (spacing), uCR (cell ratio), uMax (speed drawn white)
  b: vec4<f32>,        // uFoam, uVs (metres a unit for m/s speed bytes, else 1), uFdt (seconds a frame), uBlend
  c: vec4<f32>,        // uKw (water extras), uKs (whitewater extras), uStreak, uHide (skip buried water)
  d: vec4<f32>,        // uCull (px), copies a point (k1) for this draw, 0, 0
};
struct Layer {
  b0: vec4<f32>,       // box low corner
  e: vec4<f32>,        // box size
  q: vec4<u32>,        // bits x, y, z, w: 1 compact
  n: vec4<u32>,        // x: points, y: has levels (16-bit layout)
};

@group(0) @binding(0) var<uniform> cam: Cam;
@group(1) @binding(0) var<uniform> LA: Layer;
@group(1) @binding(1) var<storage, read> posA: array<u32>;
@group(1) @binding(2) var<storage, read> spdA: array<u32>;
@group(1) @binding(3) var<storage, read> lvlA: array<u32>;
@group(2) @binding(0) var<uniform> LB: Layer;
@group(2) @binding(1) var<storage, read> posB: array<u32>;
@group(2) @binding(2) var<storage, read> spdB: array<u32>;
@group(2) @binding(3) var<storage, read> lvlB: array<u32>;

struct VOut {
  @builtin(position) p: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) k: vec4<f32>,   // vS (speed, or life x 63), vF (white water), vK (kind), vL (level)
};

fn hsh(x0: u32) -> u32 { var x = x0; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
fn ball(s: u32) -> vec3<f32> {
  let r = vec3<f32>(f32(hsh(s) & 65535u), f32(hsh(s + 7919u) & 65535u), f32(hsh(s + 104729u) & 65535u)) / 32767.5 - 1.0;
  let l = length(r);
  return select(r, r / l, l > 1.0);
}

// one point of a layer: whether it is there, its position (scene units), speed byte, level 0-15, buried, compact
struct Pt { ok: bool, p: vec3<f32>, s: f32, lv: f32, bur: bool, cmp: bool };
fn unq(v: u32, q: vec4<u32>) -> vec3<f32> {
  let mx = (1u << q.x) - 1u; let my = (1u << q.y) - 1u; let mz = (1u << q.z) - 1u;
  return vec3<f32>(f32(v & mx) / f32(mx), f32((v >> q.x) & my) / f32(my), f32((v >> (q.x + q.y)) & mz) / f32(mz));
}
fn ptA(i: u32) -> Pt {
  var o: Pt; o.cmp = LA.q.w == 1u;
  if (i >= LA.n.x) { return o; }
  var f: vec3<f32>;
  if (o.cmp) {
    f = unq(posA[i], LA.q);
    let w = (spdA[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu;
    o.s = f32(w & 255u); o.lv = f32((w >> 8u) & 15u); o.bur = ((w >> 12u) & 1u) == 1u; o.ok = (w & 255u) != 255u;
  } else {
    let j = i * 3u;
    let x = (posA[j >> 1u] >> ((j & 1u) * 16u)) & 0xffffu; let y = (posA[(j + 1u) >> 1u] >> (((j + 1u) & 1u) * 16u)) & 0xffffu; let z = (posA[(j + 2u) >> 1u] >> (((j + 2u) & 1u) * 16u)) & 0xffffu;
    f = vec3<f32>(f32(x), f32(y), f32(z)) / 65535.0;
    let s = (spdA[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
    o.s = f32(s); o.ok = s != 255u;
    if (LA.n.y == 1u) { o.lv = floor(f32((lvlA[i >> 2u] >> ((i & 3u) * 8u)) & 255u) / 17.0 + 0.5); }
  }
  o.p = LA.b0.xyz + f * LA.e.xyz + cam.org.xyz;
  return o;
}
fn ptB(i: u32) -> Pt {
  var o: Pt; o.cmp = LB.q.w == 1u;
  if (i >= LB.n.x) { return o; }
  var f: vec3<f32>;
  if (o.cmp) {
    f = unq(posB[i], LB.q);
    let w = (spdB[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu;
    o.s = f32(w & 255u); o.lv = f32((w >> 8u) & 15u); o.bur = ((w >> 12u) & 1u) == 1u; o.ok = (w & 255u) != 255u;
  } else {
    let j = i * 3u;
    let x = (posB[j >> 1u] >> ((j & 1u) * 16u)) & 0xffffu; let y = (posB[(j + 1u) >> 1u] >> (((j + 1u) & 1u) * 16u)) & 0xffffu; let z = (posB[(j + 2u) >> 1u] >> (((j + 2u) & 1u) * 16u)) & 0xffffu;
    f = vec3<f32>(f32(x), f32(y), f32(z)) / 65535.0;
    let s = (spdB[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
    o.s = f32(s); o.ok = s != 255u;
    if (LB.n.y == 1u) { o.lv = floor(f32((lvlB[i >> 2u] >> ((i & 3u) * 8u)) & 255u) / 17.0 + 0.5); }
  }
  o.p = LB.b0.xyz + f * LB.e.xyz + cam.org.xyz;
  return o;
}

const CORNER = array<vec2<f32>, 6>(vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
fn hidden() -> VOut { var o: VOut; o.p = vec4<f32>(2.0, 2.0, 2.0, 1.0); return o; }
// a point's size on screen in pixels (the page's gl_PointSize)
fn pxAt(p: vec3<f32>, sz: f32) -> f32 {
  let mv = cam.view * vec4<f32>(p, 1.0);
  return select(cam.a.x * cam.vp.z / max(-mv.z, 1e-4), cam.a.x * cam.vp.w, cam.vp.w > 0.0) * sz;
}
fn place(p: vec3<f32>, sz: f32, minPx: f32, uv: vec2<f32>, k: vec4<f32>) -> VOut {
  var o: VOut;
  let mv = cam.view * vec4<f32>(p, 1.0);
  let px = max(pxAt(p, sz), minPx);
  o.p = cam.proj * mv;
  o.p = vec4<f32>(o.p.xy + uv * vec2<f32>(px / cam.vp.x, px / cam.vp.y) * o.p.w, o.p.zw);
  o.uv = uv; o.k = k;
  return o;
}

// water: blended between frame A and frame B. A particle only in B shows at once; one only in A shows until halfway.
@vertex
fn vs_water(@builtin(vertex_index) vi: u32) -> VOut {
  let k1 = u32(cam.d.y + 0.5); let q = vi / 6u; let bi = q / k1; let lk = f32(q - bi * k1); let uv = CORNER[vi % 6u];
  let w = cam.b.w; let bl = w > 0.0;
  let A = ptA(bi);
  var B: Pt; if (bl) { B = ptB(bi); }
  var va = A.ok; var vb = B.ok;
  // buried water (compact bake frames mark it, bit 12): no view can see it, so only 1 in 16 is drawn, twice the size and without copies
  let bur = cam.c.w > 0.5 && (!va || !A.cmp || A.bur) && (!vb || !B.cmp || B.bur) && (va || vb) && (A.cmp || B.cmp);
  if (bur && ((hsh(bi) & 15u) != 0u || lk > 0.5)) { return hidden(); }
  // a slot can be a different particle in the next frame (narrow band reseeding reuses slots): further than it could have moved, it
  // switches halfway instead of streaking across the water
  let sm = max(A.s, B.s);
  if (va && vb && sm < 191.0 && length(B.p - A.p) > sm / 16.0 / cam.b.y * 2.0 * cam.b.z + 3.0 * cam.a.y) { if (w < 0.5) { vb = false; } else { va = false; } }
  var p: vec3<f32>; var spd: f32; var lv: f32;
  if (va && vb) { p = mix(A.p, B.p, w); spd = mix(A.s, B.s, w) / 16.0; lv = floor(mix(A.lv, B.lv, w) + 0.5); }
  else if (va && w < 0.5) { p = A.p; spd = A.s / 16.0; lv = A.lv; }
  else if (vb) { p = B.p; spd = B.s / 16.0; lv = B.lv; }
  else { return hidden(); }
  let vL = lv / 15.0; let vF = vL * cam.b.x;
  if (lk > cam.c.x + 0.5) { return hidden(); }
  if (lk > 0.5) { p += ball(bi * 16u + u32(lk)) * 0.5 * cam.a.y; if (pxAt(p, 1.0) < cam.d.x) { return hidden(); } }
  return place(p, (1.0 - 0.3 * vF) * select(1.0, 2.0, bur), 1.5, uv, vec4<f32>(spd, vF, 0.0, vL));
}

// deep water (narrow band, look only): the centre of each deep cell and four extras spread over the cell
@vertex
fn vs_deep(@builtin(vertex_index) vi: u32) -> VOut {
  let k1 = u32(cam.d.y + 0.5); let q = vi / 6u; let bi = q / k1; let lk = f32(q - bi * k1); let uv = CORNER[vi % 6u];
  let A = ptA(bi);
  if (!A.ok) { return hidden(); }
  var p = A.p;
  if (lk > 0.5) { p += ball((bi + 0x40000000u) * 16u + u32(lk)) * 0.5 * cam.a.y * cam.a.z; if (pxAt(p, 1.3) < cam.d.x) { return hidden(); } }
  return place(p, 1.3, 1.5, uv, vec4<f32>(A.s / 16.0, 0.0, 3.0, 0.0));
}

// whitewater from its 32-bit code: spray (its copies trail back along its motion as a short streak), mist (a soft cloud), foam (flat
// on the surface, fading with its life) and bubbles. Codes are in spdA; positions are across the whitewater area.
@vertex
fn vs_ww(@builtin(vertex_index) vi: u32) -> VOut {
  let k1 = u32(cam.d.y + 0.5); let q = vi / 6u; let bi = q / k1; let lk = f32(q - bi * k1); let uv = CORNER[vi % 6u];
  if (bi >= LA.n.x) { return hidden(); }
  let pk = spdA[bi];
  if (pk == 0u) { return hidden(); }
  var f: vec3<f32>;
  if (LA.q.w == 1u) { f = unq(posA[bi], LA.q); }
  else {
    let j = bi * 3u;
    let x = (posA[j >> 1u] >> ((j & 1u) * 16u)) & 0xffffu; let y = (posA[(j + 1u) >> 1u] >> (((j + 1u) & 1u) * 16u)) & 0xffffu; let z = (posA[(j + 2u) >> 1u] >> (((j + 2u) & 1u) * 16u)) & 0xffffu;
    f = vec3<f32>(f32(x), f32(y), f32(z)) / 65535.0;
  }
  var p = LA.b0.xyz + f * LA.e.xyz + cam.org.xyz;
  let kc = (pk >> 29u) & 3u; let spd = f32((pk >> 21u) & 255u) / 4.0; let life = f32(pk & 1023u) / 1023.0;
  let ks = cam.c.y; let dd = cam.a.y;
  // mist, foam and bubbles carry a seed from their slot, so their extras stay put; older caches without one use the point number
  let sd = select(select((pk >> 10u) & 2047u, 0u, kc == 0u), pk & 0xFFFFFu, kc == 2u);
  let hs = select(bi, sd + 1048576u, sd != 0u) * 16u + u32(lk);
  if (kc == 0u) {
    if (lk > ks + 0.5) { return hidden(); }
    let u = f32(pk & 1023u) / 1023.0 * 2.0 - 1.0; let w = f32((pk >> 10u) & 1023u) / 1023.0 * 2.0 - 1.0;
    var n = vec3<f32>(u, w, 1.0 - abs(u) - abs(w));
    if (n.z < 0.0) { n = vec3<f32>((1.0 - abs(w)) * select(-1.0, 1.0, u >= 0.0), (1.0 - abs(u)) * select(-1.0, 1.0, w >= 0.0), n.z); }
    n = normalize(n);
    if (lk > 0.5) { p += -n * min(spd * cam.c.z, 0.6) * lk / max(ks, 1.0) + ball(hs) * 0.2 * dd; }
    return place(p, 0.42, 1.0, uv, vec4<f32>(spd, 0.0, 1.0, 0.0));
  }
  if (kc == 2u) {
    if (lk > ks + 0.5) { return hidden(); }
    if (lk > 0.5) { p += ball(hs) * 1.6 * dd; }
    return place(p, 0.6, 1.0, uv, vec4<f32>(spd, 0.0, 2.0, 0.0));
  }
  if (kc == 1u) {
    if (lk > ceil(ks * 0.5) + 0.5) { return hidden(); }
    if (lk > 0.5) { var o = ball(hs); o.y *= 0.12; p += o * dd * (0.5 + 0.5 * life); }
    return place(p, 0.5 * (0.6 + 0.4 * life), 1.0, uv, vec4<f32>(life * 63.0, 0.0, 4.0, 0.0));
  }
  if (lk > min(ks, 2.0) + 0.5) { return hidden(); }
  if (lk > 0.5) { p += ball(hs) * 0.25 * dd; }
  return place(p, 0.32, 1.0, uv, vec4<f32>(life * 63.0, 0.0, 5.0, 0.0));
}

fn ramp(t: f32) -> vec3<f32> {
  let a = vec3<f32>(0.03, 0.12, 0.95); let b = vec3<f32>(0.0, 0.82, 0.98); let c = vec3<f32>(1.0);
  return select(mix(b, c, (t - 0.5) * 2.0), mix(a, b, t * 2.0), t < 0.5);
}

@fragment
fn fs_water(i: VOut) -> @location(0) vec4<f32> {
  let r2 = dot(i.uv, i.uv);
  if (r2 > 1.0) { discard; }
  let sh = 0.78 + 0.22 * (1.0 - r2);
  let t = clamp(i.k.x / cam.a.w, 0.0, 1.0);
  let col = select(mix(ramp(t), vec3<f32>(0.97, 0.99, 1.0), i.k.y), ramp(t) * 0.82, i.k.z > 2.5);
  return vec4<f32>(col * sh, 1.0);
}

// whitewater is drawn see-through and soft-edged, so many points build up into white masses instead of hard dots
@fragment
fn fs_ww(i: VOut) -> @location(0) vec4<f32> {
  let r2 = dot(i.uv, i.uv);
  if (r2 > 1.0) { discard; }
  let edge = 1.0 - smoothstep(0.45, 1.0, r2);
  let life = clamp(i.k.x / 63.0, 0.0, 1.0);
  var c: vec3<f32>; var a: f32;
  if (i.k.z > 4.5) { c = vec3<f32>(0.74, 0.89, 0.97); a = 0.55; }
  else if (i.k.z > 3.5) { c = vec3<f32>(0.95, 0.97, 0.99); a = 0.85 * (0.35 + 0.65 * life); }
  else if (i.k.z > 1.5) { c = vec3<f32>(0.86, 0.9, 0.95); a = 0.22; }
  else { c = vec3<f32>(0.96, 0.98, 1.0); a = 0.9; }
  return vec4<f32>(c, a * edge);
}

// the viewport's background, as the page's stage: a gradient from #454545 at the top to #333 at the bottom
struct BOut { @builtin(position) p: vec4<f32>, @location(0) y: f32 };
@vertex
fn vs_bg(@builtin(vertex_index) vi: u32) -> BOut {
  let xy = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: BOut; o.p = vec4<f32>(xy, 1.0, 1.0); o.y = xy.y * 0.5 + 0.5; return o;
}
@fragment
fn fs_bg(i: BOut) -> @location(0) vec4<f32> { return vec4<f32>(mix(vec3<f32>(0x33, 0x33, 0x33), vec3<f32>(0x45, 0x45, 0x45), i.y) / 255.0, 1.0); }
