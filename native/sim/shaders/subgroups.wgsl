// Kernels using subgroups (compiled only when the card offers them): list building and the whitewater gather with ballots.
// Started from the web page's shader (src/flip/wgsl-*.js, 2026-10-29); now the desktop program's own source.

// how many of the lanes below this one voted yes
fn sgBelow(b: vec4<u32>, lane: u32) -> u32 {
  var n = 0u;
  for (var w = 0u; w < 4u; w++) {
    let lo = w * 32u;
    if (lane >= lo + 32u) { n += countOneBits(b[w]); } else if (lane > lo) { n += countOneBits(b[w] & ((1u << (lane - lo)) - 1u)); }
  }
  return n;
}
fn sgCount(b: vec4<u32>) -> u32 { return countOneBits(b.x) + countOneBits(b.y) + countOneBits(b.z) + countOneBits(b.w); }
// no early returns: every thread has to reach the ballots
@compute @workgroup_size(256)
fn buildListSG(@builtin(global_invocation_id) g: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {
  let a = acell(gid1(g));
  var par = 2u;
  if (a.ok) { if ((ctype[a.c] & 0xffu) == 1u) { if (settled(a.c)) { atomicAdd(&ctl[15], 1u); } else { par = u32((a.p.x + a.p.y + a.p.z) & 1); } } }
  for (var k = 0u; k < 2u; k++) {
    let want = par == k;
    let b = subgroupBallot(want);
    var base = 0u;
    if ((lane == subgroupBroadcastFirst(lane))) { base = atomicAdd(&ctl[k], sgCount(b)); }
    base = subgroupBroadcastFirst(base);
    if (want) { let s = base + sgBelow(b, lane); if (s < P.lcap) { lst[k * P.lcap + s] = a.c; } }
  }
}
@compute @workgroup_size(256)
fn sprayDispSG(@builtin(global_invocation_id) g: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {
  let j = gid1(g); let used = min(atomicLoad(&sctl[0]), P.smax);
  var want = j < used;
  if (want) { want = sPos[j].w > 0.0; }
  if (want && used > P.sdMax) { want = hash1(j * 7919u + 104729u) * f32(used) < f32(P.sdMax); }
  let b = subgroupBallot(want);
  var base = 0u;
  if ((lane == subgroupBroadcastFirst(lane))) { base = atomicAdd(&sctl[2], sgCount(b)); }
  base = subgroupBroadcastFirst(base);
  if (!want) { return; }
  let k = base + sgBelow(b, lane); if (k >= P.sdMax) { return; }
  let o = P.sdOff + k; if (o >= arrayLength(&disp)) { return; }
  disp[o] = vec4<f32>(sPos[j].xyz, bitcast<f32>(packSpray(sVel[j].xyz, u32(sVel[j].w + 0.5), sPos[j].w / max(P.wwFoamLife, 0.01), wwSeed(j))));
}
