// The mist and smoke volume: see-through layers facing the camera, far to near, each a whole rectangle of the screen around the box. The
// depth test keeps them behind water and objects without reading any depth. The density bytes are the square root of the density.
struct FogU {
  inv: mat4x4<f32>,      // screen to scene
  rect: vec4<f32>,       // the rectangle on screen: x0, y0, x1, y1
  z: vec4<f32>,          // view distance of the farthest edge, step to the next layer, blend between the two frames, how thick
  pz: vec4<f32>,         // the projection's z and w from view z: (a z + b) / (c z + d)
  b0: vec4<f32>,         // the volume's low corner; w length of a layer's step in scene units
  e: vec4<f32>,          // its size; w how far a step towards the sun goes in the volume's own coordinates
  sun: vec4<f32>,        // towards the sun, scene coordinates over size
  col: vec4<f32>,        // lit colour; w how dark its shade goes
};
@group(0) @binding(0) var<uniform> F: FogU;
@group(1) @binding(0) var ta: texture_3d<f32>;
@group(1) @binding(1) var sa: sampler;
@group(2) @binding(0) var tb: texture_3d<f32>;
@group(2) @binding(1) var sb: sampler;

struct V { @builtin(position) p: vec4<f32>, @location(0) ndc: vec3<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32, @builtin(instance_index) k: u32) -> V {
  let c = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
  let q = mix(F.rect.xy, F.rect.zw, c[i]);
  let vz = -(F.z.x - (f32(k) + 0.5) * F.z.y);
  let depth = (F.pz.x * vz + F.pz.y) / (F.pz.z * vz + F.pz.w);
  var o: V;
  o.p = vec4<f32>(q, depth, 1.0);
  o.ndc = vec3<f32>(q, depth);
  return o;
}

fn density(u: vec3<f32>) -> f32 {
  let a = textureSampleLevel(ta, sa, u, 0.0).r;
  let b = textureSampleLevel(tb, sb, u, 0.0).r;
  let d = mix(a, b, F.z.z);
  return d * d;
}

@fragment
fn fs(v: V) -> @location(0) vec4<f32> {
  let w = F.inv * vec4<f32>(v.ndc, 1.0);
  let u = (w.xyz / w.w - F.b0.xyz) / F.e.xyz;
  if (any(u < vec3<f32>(0.0)) || any(u > vec3<f32>(1.0))) { discard; }
  // thinning out towards the edges of the volume, so its box never shows
  let edge = min(u, vec3<f32>(1.0) - u) * F.e.xyz / (F.e.w * 3.0);
  let d = density(u) * smoothstep(0.0, 1.0, min(edge.x, min(edge.y, edge.z)));
  if (d < 0.002) { discard; }
  let a = 1.0 - exp(-F.z.w * d * F.b0.w);
  // a little of its own shadow: how much lies towards the sun
  let s = F.sun.xyz * F.e.w;
  let sh = density(u + s) + density(u + 2.0 * s) + density(u + 4.0 * s);
  let lit = mix(F.col.w, 1.0, exp(-2.5 * sh));
  return vec4<f32>(F.col.rgb * lit, a);
}
