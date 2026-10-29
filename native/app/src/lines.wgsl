// Tank box, floor grid, whitewater area, ocean level and objects: plain vertices with a colour (lines see-through by their alpha);
// triangles are lit by their normal as the page's Lambert objects, lines (normal 0) are not.

struct Cam {
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  org: vec4<f32>,
  vp: vec4<f32>,
  a: vec4<f32>,
  b: vec4<f32>,
  c: vec4<f32>,
  d: vec4<f32>,
};
@group(0) @binding(0) var<uniform> cam: Cam;

struct VIn {
  @location(0) p: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) c: vec4<f32>,
};
struct VOut {
  @builtin(position) p: vec4<f32>,
  @location(0) n: vec3<f32>,
  @location(1) c: vec4<f32>,
};

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.p = cam.proj * cam.view * vec4<f32>(v.p, 1.0);
  o.n = v.n;
  o.c = v.c;
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
  if (dot(i.n, i.n) < 0.01) { return i.c; }
  let n = normalize(i.n);
  // the page's objects: Lambert, ambient 0.7 and a sun of 0.75 from (2, 5, 3), both sides lit
  let sh = 0.7 + 0.75 * abs(dot(n, normalize(vec3<f32>(2.0, 5.0, 3.0))));
  return vec4<f32>(min(i.c.rgb * sh, vec3<f32>(1.0)), i.c.a);
}
