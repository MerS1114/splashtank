// Bake points drawn straight from the cache file's layout (like the page's water, deep and whitewater shaders in
// src/app/02-viewport.js): compact frames hold a u32 position across the box (bits q) and a u16 speed | level << 8;
// the 16-bit layout holds 3 x u16 positions and u8 speeds (and u8 levels x 17). Each point is a camera-facing quad of 6 vertices.

struct Cam {
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  org: vec4<f32>,      // xyz: cache origin added to every point
  look: vec4<f32>,     // x: point size factor, y: speed for white (m/s), z: speed byte scale (m/s per 16th), w: skip buried points (1)
};
struct Layer {
  b0: vec4<f32>,       // box low corner, w: kind (0 water, 1 deep, 2 whitewater)
  e: vec4<f32>,        // box size, w: point radius in scene units
  q: vec4<u32>,        // bits x, y, z, w: 1 compact
  n: vec4<u32>,        // x: points, y: has levels (16-bit layout)
};

@group(0) @binding(0) var<uniform> cam: Cam;
@group(1) @binding(0) var<uniform> L: Layer;
@group(1) @binding(1) var<storage, read> pos: array<u32>;
@group(1) @binding(2) var<storage, read> spd: array<u32>;   // compact: u16 sf; 16-bit: u8 speeds; whitewater: u32 codes
@group(1) @binding(3) var<storage, read> lvl: array<u32>;   // 16-bit layout: u8 levels x 17

struct VOut {
  @builtin(position) p: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) col: vec3<f32>,
};

fn u16at(i: u32) -> u32 { return (pos[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu; }
fn byteAt(i: u32) -> u32 { return (spd[i >> 2u] >> ((i & 3u) * 8u)) & 255u; }
fn ramp(t: f32) -> vec3<f32> {
  let a = vec3<f32>(0.03, 0.12, 0.95); let b = vec3<f32>(0.0, 0.82, 0.98); let c = vec3<f32>(1.0);
  return select(mix(b, c, (t - 0.5) * 2.0), mix(a, b, t * 2.0), t < 0.5);
}

const CORNER = array<vec2<f32>, 6>(vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let i = vi / 6u;
  let uv = CORNER[vi % 6u];
  o.uv = uv;
  o.p = vec4<f32>(0.0, 0.0, -2.0, 1.0);   // outside the view: culled
  if (i >= L.n.x) { return o; }
  let kind = u32(L.b0.w);
  var f: vec3<f32>;
  var s: u32 = 0u;
  var level: u32 = 0u;
  var r = L.e.w;
  var col: vec3<f32>;
  if (L.q.w == 1u) {
    let v = pos[i];
    let mx = (1u << L.q.x) - 1u; let my = (1u << L.q.y) - 1u; let mz = (1u << L.q.z) - 1u;
    f = vec3<f32>(f32(v & mx) / f32(mx), f32((v >> L.q.x) & my) / f32(my), f32((v >> (L.q.x + L.q.y)) & mz) / f32(mz));
  } else {
    f = vec3<f32>(f32(u16at(i * 3u)), f32(u16at(i * 3u + 1u)), f32(u16at(i * 3u + 2u))) / 65535.0;
  }
  if (kind == 2u) {
    // whitewater codes (packSpray): 0 = none; bits 30-29: 00 spray, 10 mist, 01 foam, 11 bubble
    let c = spd[i];
    if (c == 0u) { return o; }
    let k = (c >> 29u) & 3u;
    if (k == 0u) { col = vec3<f32>(0.95, 0.97, 1.0); r = r * 0.8; }
    else if (k == 2u) { col = vec3<f32>(0.8, 0.85, 0.9); r = r * 0.6; }
    else if (k == 1u) { col = vec3<f32>(1.0, 1.0, 1.0); }
    else { col = vec3<f32>(0.75, 0.88, 1.0); r = r * 0.7; }
  } else {
    if (L.q.w == 1u) {
      let w = (spd[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu;
      s = w & 255u; level = (w >> 8u) & 15u;
      // buried water (markInterior): no view can see it; 1 in 16 drawn twice the size as a backstop, as the page does
      if ((w & 4096u) != 0u && cam.look.w > 0.5) { if ((i & 15u) != 0u) { return o; } r = r * 2.0; }
    } else {
      s = byteAt(i);
      if (L.n.y == 1u) { level = u32(round(f32((lvl[i >> 2u] >> ((i & 3u) * 8u)) & 255u) / 17.0)); }
    }
    if (s == 255u) { return o; }   // gone
    let t = clamp(f32(s) / 16.0 * cam.look.z / cam.look.y, 0.0, 1.0);
    if (kind == 1u) { col = ramp(t) * 0.82; }
    else { col = mix(ramp(t), vec3<f32>(0.97, 0.99, 1.0), f32(level) / 15.0 * 0.8); }
  }
  let world = L.b0.xyz + f * L.e.xyz + cam.org.xyz;
  var v = cam.view * vec4<f32>(world, 1.0);
  let rr = r * cam.look.x;
  v = vec4<f32>(v.xy + uv * rr, v.z, v.w);
  o.p = cam.proj * v;
  o.col = col;
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
  let d = dot(i.uv, i.uv);
  if (d > 1.0) { discard; }
  // a sphere's shading: light from the upper left
  let n = vec3<f32>(i.uv.x, -i.uv.y, sqrt(1.0 - d));
  let sh = 0.45 + 0.55 * max(dot(n, normalize(vec3<f32>(-0.4, 0.6, 0.7))), 0.0);
  return vec4<f32>(i.col * sh, 1.0);
}
