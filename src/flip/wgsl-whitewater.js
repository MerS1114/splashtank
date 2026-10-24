// FLIP shader: whitewater, air field, drips, and the live view (display sample, packing, deep water points).
const FLIP_WGSL_WHITEWATER = /* wgsl */ `
// ---- whitewater (Houdini style): spray, mist, foam and bubbles in one pool of points that never push the water ----
// kind 0 spray, 1 mist, 2 foam, 3 bubble. Each step a point is classified by how deep in water it sits: spray that lands turns to foam,
// foam rides the surface and fades, foam pushed under turns to bubbles, bubbles rise and turn to foam at the surface.
// how much water is at a cell, 0 to 1: particles over the rest count; deep narrow-band water (it has no particles) counts as full
fn wetCell(c: vec3<i32>) -> f32 {
  if (!inDom(c) || !hasStorage(c)) { return 0.0; }
  let ci = cellIdx(c.x, c.y, c.z);
  if (P.nb != 0u && (ctype[ci] & 0xffu) == 1u && phiOf(ci) < -1.0) { return 1.0; }
  return min(f32(atomicLoad(&cnt[ci])) / P.rest, 1.0);
}
fn wetAt(p: vec3<f32>) -> f32 {
  let g = (p - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih - vec3<f32>(0.5);
  let f0 = floor(g); let fr = g - f0; let i0 = vec3<i32>(f0);
  var s = 0.0;
  for (var c = 0u; c < 8u; c++) {
    let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
    if (w > 0.0) { s += w * wetCell(i0 + vec3<i32>(dx, dy, dz)); }
  }
  return s;
}
// air grid: cells of P.airH from the box's low corner, values at the cell centres
fn airIdx(c: vec3<i32>) -> u32 {
  let q = clamp(c, vec3<i32>(0), vec3<i32>(i32(P.aNx) - 1, i32(P.aNy) - 1, i32(P.aNz) - 1));
  return u32(q.x) + P.aNx * (u32(q.y) + P.aNy * u32(q.z));
}
fn airCell(p: vec3<f32>) -> vec3<i32> { return vec3<i32>(floor((p - vec3<f32>(P.x0, P.y0, P.z0)) / P.airH)); }
fn airAt(p: vec3<f32>) -> vec3<f32> {
  let g = (p - vec3<f32>(P.x0, P.y0, P.z0)) / P.airH - vec3<f32>(0.5);
  let f0 = floor(g); let fr = g - f0; let i0 = vec3<i32>(f0);
  var s = vec3<f32>(0.0);
  for (var c = 0u; c < 8u; c++) {
    let dx = i32(c & 1u); let dy = i32((c >> 1u) & 1u); let dz = i32((c >> 2u) & 1u);
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1) * select(1.0 - fr.z, fr.z, dz == 1);
    s += w * air[airIdx(i0 + vec3<i32>(dx, dy, dz))].xyz;
  }
  return s;
}
fn airPush(p: vec3<f32>, v: vec3<f32>, w: f32) {
  let c = airIdx(airCell(p)) * 4u;
  atomicAdd(&airAcc[c], i32(v.x * w * 256.0)); atomicAdd(&airAcc[c + 1u], i32(v.y * w * 256.0)); atomicAdd(&airAcc[c + 2u], i32(v.z * w * 256.0));
  atomicAdd(&airAcc[c + 3u], i32(w * 256.0));
}
@compute @workgroup_size(256)
fn airClear(@builtin(global_invocation_id) g: vec3<u32>) {
  let c = gid1(g); if (c >= P.aNx * P.aNy * P.aNz) { return; }
  for (var k = 0u; k < 4u; k++) { atomicStore(&airAcc[c * 4u + k], 0); }
}
// water near the surface drags the air (water deep inside a body never touches it)
@compute @workgroup_size(256)
fn airSplatW(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let p = pos[i].xyz; if (pos[i].y < DEADY) { return; }
  let c = particleCell(p);
  if (hasStorage(c) && f32(atomicLoad(&cnt[cellIdx(c.x, c.y, c.z)])) > 0.85 * P.rest) { return; }
  airPush(p, vel[i].xyz, 1.0);
}
// flying spray drags it too, so mist trails behind a splash
@compute @workgroup_size(256)
fn airSplatS(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = gid1(g); if (j >= P.smax) { return; }
  let sp = sPos[j]; if (sp.w <= 0.0 || sVel[j].w > 1.5 || !inTank(sp.xyz)) { return; }
  airPush(sp.xyz, sVel[j].xyz, 0.25);
}
// each air cell: spreads a little to its neighbours, is pulled towards what pushed it, moves with an object it is inside, and settles back to the wind
@compute @workgroup_size(256)
fn airUpdate(@builtin(global_invocation_id) g: vec3<u32>) {
  let c = gid1(g); if (c >= P.aNx * P.aNy * P.aNz) { return; }
  let ci = vec3<i32>(i32(c % P.aNx), i32((c / P.aNx) % P.aNy), i32(c / (P.aNx * P.aNy)));
  var a = air[c].xyz;
  let nb = (air[airIdx(ci + vec3<i32>(1, 0, 0))].xyz + air[airIdx(ci - vec3<i32>(1, 0, 0))].xyz + air[airIdx(ci + vec3<i32>(0, 1, 0))].xyz +
            air[airIdx(ci - vec3<i32>(0, 1, 0))].xyz + air[airIdx(ci + vec3<i32>(0, 0, 1))].xyz + air[airIdx(ci - vec3<i32>(0, 0, 1))].xyz) / 6.0;
  a = mix(a, nb, P.airBlur);
  let w = f32(atomicLoad(&airAcc[c * 4u + 3u])) / 256.0;
  if (w > 0.0) {
    let vt = vec3<f32>(f32(atomicLoad(&airAcc[c * 4u])), f32(atomicLoad(&airAcc[c * 4u + 1u])), f32(atomicLoad(&airAcc[c * 4u + 2u]))) / (w * 256.0);
    a = mix(a, vt, 1.0 - exp(-P.airCouple * min(w, 8.0) * P.dt));
  }
  let x = vec3<f32>(P.x0, P.y0, P.z0) + (vec3<f32>(ci) + vec3<f32>(0.5)) * P.airH;
  for (var k = 0u; k < P.ncols; k++) {
    if (colNear(k, x) && sdfEval(k, x).x < 0.6 * P.airH) { a = colSurfVel(k, x); break; }
  }
  a = mix(a, vec3<f32>(P.q1, P.q2, P.q3), 1.0 - exp(-P.airDecay * P.dt));
  air2[c] = vec4<f32>(a, 0.0);
}
@compute @workgroup_size(256)
fn airCopy(@builtin(global_invocation_id) g: vec3<u32>) { let c = gid1(g); if (c >= P.aNx * P.aNy * P.aNz) { return; } air[c] = air2[c]; }
// how wet each whitewater point is and the water's velocity there (a separate pass keeps every kernel within 8 storage buffers)
@compute @workgroup_size(256)
fn wwSample(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = gid1(g); if (j >= P.smax) { return; }
  let sp = sPos[j]; if (sp.w <= 0.0) { return; }
  let p = sp.xyz; var vf = vec3<f32>(0.0);
  if (!inTank(p)) { sAux[j] = vec4<f32>(0.0); return; }   // out in the whitewater area: no water, still air
  if (hasStorage(particleCell(p))) { vf = sampleBoth(p).vn; }
  // for foam: how fast the surface spreads apart (positive) or gathers (negative) there. Foam thins out where it spreads and collects
  // in lines and patches where the flow converges (what makes foam look lacy instead of an even sheet).
  var dq = 0.0;
  if (P.wwErode > 0.0 && u32(sVel[j].w + 0.5) == 2u) {
    let h = P.h; let ex = vec3<f32>(h, 0.0, 0.0); let ez = vec3<f32>(0.0, 0.0, h);
    if (hasStorage(particleCell(p + ex)) && hasStorage(particleCell(p - ex)) && hasStorage(particleCell(p + ez)) && hasStorage(particleCell(p - ez))) {
      let div = (sampleBoth(p + ex).vn.x - sampleBoth(p - ex).vn.x + sampleBoth(p + ez).vn.z - sampleBoth(p - ez).vn.z) / (2.0 * h);
      dq = clamp(round(div * 2.0), -15.0, 15.0);
    }
  }
  sAux[j] = vec4<f32>(vf, wetAt(p) + 4.0 * dq);
}
// every water particle can throw off whitewater, Houdini style (Whitewater Source):
//   crests: fast water at a convex, open part of the surface (a crest, a thin sheet, a splash edge) moving outwards, along the surface's
//     outward normal within the leading-edge angle, so only the leading edges of waves throw spray, not every fast flat surface;
//   churn: water whose white-water level is high (sudden changes of velocity: impacts, water landing on water, breaking; built in g2p);
//   spin: water spinning under the surface (vorticity of the grid velocity), which entrains air as bubbles.
// Points made inside the water start as bubbles; the rest as spray or mist, and the next steps sort them by depth.
@compute @workgroup_size(256)
fn sprayEmit(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n || P.smax == 0u || P.sprRate <= 0.0) { return; }
  let q = pos[i]; if (q.y < DEADY) { return; }
  if (P.ocean != 0u && layerW(q.xyz) > 0.0) { return; }
  let v = vel[i].xyz; let foam = vel[i].w; let spd = length(v);
  let fast = clamp((spd * P.vs - P.sprMin) / (2.0 * P.sprMin), 0.0, 1.0);
  let bc = vec3<i32>(floor((q.xyz - vec3<f32>(P.x0, P.y0, P.z0)) * P.ih - vec3<f32>(0.5)));
  var rho = 0.0;
  for (var dz = 0; dz <= 1; dz++) { for (var dy = 0; dy <= 1; dy++) { for (var dx = 0; dx <= 1; dx++) { rho += wetCell(bc + vec3<i32>(dx, dy, dz)); } } }
  rho = rho / 8.0;
  let h0 = i * 747796405u + P.seed * 2891336453u;
  var crest = 0.0;
  if (rho < 0.95 && fast > 0.0 && P.wwCrest > 0.0) {
    // the 3 x 3 x 3 cells around it: how open (a flat surface is about half open, a crest or an edge more) and which way is out
    let c0 = particleCell(q.xyz); var wsum = 0.0; var grad = vec3<f32>(0.0);
    for (var dz = -1; dz <= 1; dz++) { for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
      let w = wetCell(c0 + vec3<i32>(dx, dy, dz)); wsum += w; grad += vec3<f32>(f32(dx), f32(dy), f32(dz)) * w;
    } } }
    let open = 1.0 - wsum / 27.0; let gl = length(grad);
    var lead = 1.0;   // a lone drop or a thread has no clear surface: it counts as a leading edge
    if (gl > 0.5 && spd > 1.0e-4) { lead = smoothstep(P.wwEdge - 0.25, P.wwEdge + 0.05, dot(-grad / gl, v / spd)); }
    crest = smoothstep(0.55, 0.85, open) * lead * fast * (0.3 + 0.7 * foam);
  }
  let churn = (1.0 - smoothstep(0.8, 1.0, rho)) * clamp((foam - 0.55) / 0.45, 0.0, 1.0) * smoothstep(0.5, 1.5, spd * P.vs);   // moving water only: settling at the start is not churn
  // water falling onto water: fast downwards at the surface (some water around it, not deep inside) leaves foam where it lands
  let land = smoothstep(0.5, 2.0, -v.y * P.vs / max(P.sprMin, 0.1)) * smoothstep(0.25, 0.5, rho) * (1.0 - smoothstep(0.85, 1.0, rho));
  // the fastest water throws more, and more of it as mist
  let vfast = smoothstep(3.0, 8.0, spd * P.vs / max(P.sprMin, 0.1));
  let settle = smoothstep(0.1, 0.5, P.q8);   // none while the starting water settles
  let e = (P.wwCrest * crest * (1.0 + 2.0 * vfast) + P.wwImpact * churn + P.wwLand * land) * settle;
  if (e <= 0.0) { return; }
  let fromLand = P.wwLand * land * settle / e;   // the share from landing water: made as foam on the surface
  let k = min(u32(floor(P.sprRate * e * P.dt + hash1(h0))), 4u);
  for (var m = 0u; m < k; m++) {
    let hh = h0 ^ ((m + 1u) * 0x9E3779B9u);
    let z = hash1(hh + 1u) * 2.0 - 1.0; let a = hash1(hh + 2u) * 6.2831853; let s = sqrt(max(0.0, 1.0 - z * z));
    let dir = vec3<f32>(s * cos(a), s * sin(a), z);
    let onTop = hash1(hh + 9u) < fromLand;
    let under = !onTop && rho > 0.7 && hash1(hh + 7u) < 0.7;
    let mist = !under && !onTop && hash1(hh + 3u) < min(0.9, P.mistFrac * (fast + 2.0 * vfast));
    var nv = v * (0.9 + 0.2 * hash1(hh + 4u)) + dir * spd * select(0.06, 0.2, mist);   // mostly the water's own velocity: a wide random spread looks like a sparkler
    var life = P.sprLife * (0.6 + 0.8 * hash1(hh + 5u)) * select(1.0, 1.6, mist);
    var kind = select(0.0, 1.0, mist);
    if (under) { nv = v + dir * spd * 0.05; life = P.wwFoamLife * (0.6 + 0.8 * hash1(hh + 5u)); kind = 3.0; }
    if (onTop) { nv = vec3<f32>(v.x * 0.5, 0.0, v.z * 0.5) + vec3<f32>(dir.x, 0.0, dir.z) * spd * 0.15; life = P.wwFoamLife * (0.6 + 0.8 * hash1(hh + 5u)); kind = 2.0; }
    let slot = atomicAdd(&sctl[0], 1u) % P.smax;
    if (sPos[slot].w > 0.0) { continue; }   // never replace a living point: when the pool is full, new whitewater waits for room
    sPos[slot] = vec4<f32>(q.xyz + nv * P.dt + dir * P.h * 0.3 * hash1(hh + 6u), life);
    sVel[slot] = vec4<f32>(nv, kind);
  }
}
// spin: water turning over under the surface drags air down as bubbles (Houdini: vorticity). Its own kernel, because the curl needs the
// grid velocity and sprayEmit already uses its 8 storage buffers. Vorticity costs six grid samples, so a quarter of the particles look
// each step and count four times (the same on average).
@compute @workgroup_size(256)
fn spinEmit(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n || P.smax == 0u || P.sprRate <= 0.0 || P.wwSpin <= 0.0) { return; }
  let q = pos[i]; if (q.y < DEADY) { return; }
  if (P.ocean != 0u && layerW(q.xyz) > 0.0) { return; }
  let v = vel[i].xyz; let spd = length(v); if (spd * P.vs < 0.5) { return; }
  let h0 = i * 747796405u + P.seed * 2891336453u + 101u;
  if (hash1(h0) >= 0.25) { return; }
  let c0 = particleCell(q.xyz); if (!hasStorage(c0)) { return; }
  if (f32(atomicLoad(&cnt[cellIdx(c0.x, c0.y, c0.z)])) < 0.5 * P.rest) { return; }   // in the body of the water, not at a thin edge
  let h = P.h; let p = q.xyz; let ex = vec3<f32>(h, 0.0, 0.0); let ey = vec3<f32>(0.0, h, 0.0); let ez = vec3<f32>(0.0, 0.0, h);
  if (!(hasStorage(particleCell(p + ex)) && hasStorage(particleCell(p - ex)) && hasStorage(particleCell(p + ey)) && hasStorage(particleCell(p - ey)) &&
        hasStorage(particleCell(p + ez)) && hasStorage(particleCell(p - ez)))) { return; }
  let ax = sampleNew(p + ex) - sampleNew(p - ex); let ay = sampleNew(p + ey) - sampleNew(p - ey); let az = sampleNew(p + ez) - sampleNew(p - ez);
  let curl = vec3<f32>(ay.z - az.y, az.x - ax.z, ax.y - ay.x) / (2.0 * h);
  let e = P.wwSpin * 4.0 * clamp((length(curl) - 3.0) / 12.0, 0.0, 1.0) * smoothstep(0.1, 0.5, P.q8);
  if (e <= 0.0) { return; }
  let k = min(u32(floor(P.sprRate * e * P.dt + hash1(h0 + 1u))), 4u);
  for (var m = 0u; m < k; m++) {
    let hh = h0 ^ ((m + 1u) * 0x9E3779B9u);
    let z = hash1(hh + 1u) * 2.0 - 1.0; let a = hash1(hh + 2u) * 6.2831853; let s = sqrt(max(0.0, 1.0 - z * z));
    let dir = vec3<f32>(s * cos(a), s * sin(a), z);
    let slot = atomicAdd(&sctl[0], 1u) % P.smax;
    if (sPos[slot].w > 0.0) { continue; }   // never replace a living point
    sPos[slot] = vec4<f32>(p + v * P.dt + dir * h * 0.4 * hash1(hh + 6u), P.wwFoamLife * (0.6 + 0.8 * hash1(hh + 5u)));
    sVel[slot] = vec4<f32>(v + dir * spd * 0.05, 3.0);
  }
}
// whitewater pass over a bake: the baked particles move on along the velocity worked out from two baked frames
@compute @workgroup_size(256)
fn wwAdvect(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = gid1(g); if (i >= P.n) { return; }
  let q = pos[i]; if (q.y < DEADY) { return; }
  pos[i] = vec4<f32>(q.xyz + vel[i].xyz * P.dt, q.w);
}
// moves every whitewater point by its kind: spray and mist fly with gravity and drag towards the air; foam follows the water's surface;
// bubbles are carried by the water and rise. They are gone when their time is up, when they hit an object or leave the box.
@compute @workgroup_size(256)
fn sprayStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = gid1(g); if (j >= P.smax) { return; }
  let sp = sPos[j]; if (sp.w <= 0.0) { return; }
  var v = sVel[j].xyz; let kw = sVel[j].w; var kind = u32(kw + 0.5);
  // the fraction part of the kind is how long the point has been this kind (0.4 = WWHOLD seconds or more). A point keeps its kind at least
  // that long, so it never flickers between kinds (and sizes) from one step to the next where the water is thin or broken up.
  var tk = (kw - f32(kind)) / 0.4 * WWHOLD; let settled = tk >= WWHOLD * 0.999; let k0 = kind;
  let aux = sAux[j]; let dq = floor((aux.w + 2.0) / 4.0); let wet = aux.w - 4.0 * dq; let spread = dq * 0.5; let vf = aux.xyz;
  var life = sp.w;
  let h0 = j * 2654435761u + P.seed * 974711u;
  if (kind == 0u && v.y < vf.y && wet > 0.55 && tk > 0.05) { kind = 2u; life = P.wwFoamLife * (0.6 + 0.8 * hash1(h0)); v = vf; }   // spray landing on water turns to foam
  else if (kind == 1u && wet > 0.55) { life = 0.0; }                                                                   // mist falling into water is gone
  else if (kind == 2u && wet > 0.97 && settled) { kind = 3u; }                                                         // foam pushed under: bubbles
  else if (kind == 2u && wet < 0.04 && settled) { kind = 0u; life = min(life, P.sprLife); }                            // foam that lost the surface falls as spray
  else if (kind == 3u && wet < 0.6 && settled) { kind = 2u; life = max(life, 0.5 * P.wwFoamLife); }                   // a bubble reaching the surface: foam
  if (kind != k0) { tk = 0.0; } else { tk = min(tk + P.dt, WWHOLD); }
  let p = sp.xyz;
  // fast spray leaves a trail of mist behind it (drops shed fine droplets as the air tears at them)
  if (kind == 0u && P.wwTrail > 0.0 && life > 0.0) {
    let sp2 = length(v) * P.vs / max(P.sprMin, 0.1);
    let pr = P.wwTrail * P.sprRate * P.mistFrac * smoothstep(1.5, 5.0, sp2) * P.dt;
    if (hash1(h0 + 31u) < pr) {
      let slot = atomicAdd(&sctl[0], 1u) % P.smax;
      if (slot != j && sPos[slot].w <= 0.0) {
        sPos[slot] = vec4<f32>(sp.xyz, P.sprLife * 1.6 * (0.6 + 0.8 * hash1(h0 + 32u)));
        sVel[slot] = vec4<f32>(v * (0.2 + 0.2 * hash1(h0 + 33u)), 1.0);
      }
    }
  }
  if (kind <= 1u) {
    let mist = kind == 1u;
    var gust = vec3<f32>(0.0);
    if (P.q7 > 0.0) {
      let gp = p * 0.55 * P.vs; let tt = P.q8 * 0.6;
      gust = vec3<f32>(vnz(gp + vec3<f32>(tt, 0.0, 0.0)), vnz(gp + vec3<f32>(17.3, tt, 4.1)), vnz(gp + vec3<f32>(5.7, 9.2, tt))) * 2.0 - vec3<f32>(1.0);
    }
    var base = vec3<f32>(P.q1, P.q2, P.q3); if (P.airOn != 0u) { base = airAt(p); }
    let airv = base + gust * P.q7 * select(1.0, 2.5, mist);
    v.y -= P.gravity * P.dt;
    v = v + (airv - v) * (1.0 - exp(-select(P.sprDrag, P.mistDrag, mist) * P.dt));
    life -= P.dt;
  } else if (kind == 2u) {
    let vy = vf.y + clamp((wet - 0.5) * 4.0, -1.0, 1.0) * P.h * 4.0;   // held at the surface: pushed up when under, pulled down when above
    v = mix(v, vec3<f32>(vf.x, vy, vf.z), 1.0 - exp(-10.0 * P.dt));
    life -= P.dt * clamp(1.0 + P.wwErode * spread, 0.3, 2.0);   // fades faster where the surface spreads apart, lasts where it gathers
  } else {
    // bubbles of different sizes: big ones rise fast, small ones hang in the water and keep it white longer
    v = mix(v, vf + vec3<f32>(0.0, P.wwRise * (0.4 + 1.2 * hash1(j * 7919u + 3u)), 0.0), 1.0 - exp(-6.0 * P.dt));
    life -= 0.3 * P.dt;
  }
  let np = p + v * P.dt;
  // gone at the walls of the whitewater area (at least the tank); outside the tank over an ocean, gone below the sea's level
  if (np.x < P.wwA0.x || np.x > P.wwA1.x || np.y < P.wwA0.y || np.y > P.wwA1.y || np.z < P.wwA0.z || np.z > P.wwA1.z) { life = 0.0; }
  else if (P.ocean != 0u && !inTank(np) && np.y < P.olevel) { life = 0.0; }
  else if (P.ncols > 0u && colAt(np) >= 0) { life = 0.0; }
  else if (P.ocean != 0u && kind >= 2u && layerW(np) > 0.6) { life = 0.0; }
  sPos[j] = vec4<f32>(np, life); sVel[j] = vec4<f32>(v, f32(kind) + 0.4 * tk / WWHOLD);
}
const WWHOLD: f32 = 0.2;
// packed for drawing: top bit marks whitewater, the next two bits the kind (00 spray, 10 mist, 01 foam, 11 bubble), 8 bits of speed in quarter
// units per second, then for spray and mist the direction (octahedral, 20 bits), for foam and bubbles how much of their life is left (10 bits)
fn packSpray(v: vec3<f32>, kind: u32, lifeFrac: f32) -> u32 {
  let s = length(v);
  var code = 0x80000000u | (min(u32(s * 4.0), 255u) << 21u);
  if (kind == 1u) { code = code | 0x40000000u; } else if (kind == 2u) { code = code | 0x20000000u; } else if (kind == 3u) { code = code | 0x60000000u; }
  if (kind >= 2u) { return code | u32(clamp(lifeFrac, 0.0, 1.0) * 1023.0); }
  var n = vec3<f32>(0.0, 1.0, 0.0); if (s > 1e-6) { n = v / s; }
  var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { p = (vec2<f32>(1.0) - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0)); }
  let u = u32(clamp(round((p.x * 0.5 + 0.5) * 1023.0), 0.0, 1023.0)); let w = u32(clamp(round((p.y * 0.5 + 0.5) * 1023.0), 0.0, 1023.0));
  return code | (w << 10u) | u;
}
// whitewater slots are handed out in order (a ring), so until the ring wraps only the first sctl[0] can be alive: work over just those
@compute @workgroup_size(1)
fn wwArgs() { split((min(atomicLoad(&sctl[0]), P.smax) + 255u) / 256u, 28u); }
// an even sample of the whitewater slots for the live view, written after the water points
@compute @workgroup_size(256)
// The sample takes every stride-th slot of those handed out so far (the same slots from frame to frame, so a point stays shown all its life);
// the living ones are packed together, counted in sctl[2] (cleared by dispBegin).
fn sprayDisp(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = gid1(g); if (k >= P.sdMax) { return; }
  let used = min(atomicLoad(&sctl[0]), P.smax); let stride = max(1u, (used + P.sdMax - 1u) / P.sdMax);
  let j = k * stride; if (j >= used || sPos[j].w <= 0.0) { return; }
  let o = P.sdOff + atomicAdd(&sctl[2], 1u); if (o >= arrayLength(&disp)) { return; }
  disp[o] = vec4<f32>(sPos[j].xyz, bitcast<f32>(packSpray(sVel[j].xyz, u32(sVel[j].w + 0.5), sPos[j].w / max(P.wwFoamLife, 0.01))));
}
@compute @workgroup_size(1)
fn dispBegin() { atomicStore(&sctl[2], 0u); }
// The live view as a cache frame: every thread packs four points of one part (water, whitewater or deep water). Positions are 16 bits
// across the box (three per point, so four points fill six words), water gets a speed byte (16ths, 255 = gone) and a white-water byte,
// whitewater its 32-bit code (0 = none), deep water a speed byte. Word 0 and 1 hold how many whitewater and deep points there are.
fn q16s(p: vec3<f32>) -> vec3<u32> { return vec3<u32>(clamp(round((p - vec3<f32>(PK.sx0, PK.sy0, PK.sz0)) * vec3<f32>(PK.skx, PK.sky, PK.skz)), vec3<f32>(0.0), vec3<f32>(65535.0))); }
fn q16(p: vec3<f32>) -> vec3<u32> { return vec3<u32>(clamp(round((p - vec3<f32>(PK.x0, PK.y0, PK.z0)) * vec3<f32>(PK.kx, PK.ky, PK.kz)), vec3<f32>(0.0), vec3<f32>(65535.0))); }
fn put6(o: u32, q: array<vec3<u32>, 4>) {
  packOut[o] = q[0].x | (q[0].y << 16u); packOut[o + 1u] = q[0].z | (q[1].x << 16u); packOut[o + 2u] = q[1].y | (q[1].z << 16u);
  packOut[o + 3u] = q[2].x | (q[2].y << 16u); packOut[o + 4u] = q[2].z | (q[3].x << 16u); packOut[o + 5u] = q[3].y | (q[3].z << 16u);
}
@compute @workgroup_size(256)
fn packDisp(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = gid1(g);
  let gW = (PK.nW + 3u) / 4u; let gS = (PK.nS + 3u) / 4u; let gD = (PK.nD + 3u) / 4u;
  let nS = min(atomicLoad(&sctl[2]), PK.nS); let nD = min(atomicLoad(&ctl[14]), PK.nD);
  if (t == 0u) { packOut[0] = nS; packOut[1] = nD; packOut[2] = 0u; packOut[3] = 0u; }
  var q: array<vec3<u32>, 4>; var b0 = 0u; var b1 = 0u;
  if (t < gW) {
    for (var m = 0u; m < 4u; m++) {
      let i = t * 4u + m; var v = vec4<f32>(0.0, -1.0e6, 0.0, 0.0);
      if (i < PK.nW) { if (PK.wFromPos != 0u) { v = pos[i]; } else { v = disp[i]; } }
      var s = 255u; var f = 0u; q[m] = vec3<u32>(0u);
      if (v.y > DEADY) { q[m] = q16(v.xyz); let lv = floor(v.w / 64.0); s = u32(clamp((v.w - lv * 64.0) * 16.0 * PK.vs, 0.0, 191.0)); f = u32(clamp(lv, 0.0, 15.0)) * 17u; }
      b0 = b0 | (s << (8u * m)); b1 = b1 | (f << (8u * m));
    }
    put6(PK.oWp + t * 6u, q); packOut[PK.oWs + t] = b0; packOut[PK.oWf + t] = b1; return;
  }
  let ts = t - gW;
  if (ts < gS) {
    for (var m = 0u; m < 4u; m++) {
      let k = ts * 4u + m; var code = 0u; q[m] = vec3<u32>(0u);
      if (k < nS) { let v = disp[PK.srcS + k]; if (v.y > DEADY) { q[m] = q16s(v.xyz); code = bitcast<u32>(v.w); } }
      packOut[PK.oSk + k] = code;
    }
    put6(PK.oSp + ts * 6u, q); return;
  }
  let td = ts - gS;
  if (td < gD) {
    for (var m = 0u; m < 4u; m++) {
      let k = td * 4u + m; var s = 255u; q[m] = vec3<u32>(0u);
      if (k < nD) { let v = disp[PK.srcD + k]; if (v.y > DEADY) { q[m] = q16(v.xyz); s = u32(clamp((v.w - 4096.0) * 16.0 * PK.vs, 0.0, 191.0)); } }
      b0 = b0 | (s << (8u * m));
    }
    put6(PK.oDp + td * 6u, q); packOut[PK.oDs + td] = b0;
  }
}
// wet objects drip: points over each collider's surface stay wet while they are in water and dry over P.dripDry seconds once out;
// while drying they let go of drops (more from surfaces facing down), which fly as spray with the object's own velocity
@compute @workgroup_size(256)
fn dripStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = gid1(g); if (s >= P.ndrip) { return; }
  let a = drip[s * 2u]; let b = drip[s * 2u + 1u];
  let k = u32(a.w); if (k >= P.ncols) { return; }
  let r0 = cols[k * 8u + 2u].xyz; let r1 = cols[k * 8u + 3u].xyz; let r2 = cols[k * 8u + 4u].xyz;
  let wp = cols[k * 8u + 5u].xyz + r0 * a.x + r1 * a.y + r2 * a.z;
  let wn = normalize(r0 * b.x + r1 * b.y + r2 * b.z);
  let probe = wp + wn * P.h * 0.75;
  let here = wetAt(probe);
  if (here > 0.4) { drip[s * 2u + 1u].w = 1.0; return; }
  let wetness = max(0.0, b.w - P.dt / max(P.dripDry, 0.05));
  drip[s * 2u + 1u].w = wetness;
  if (wetness <= 0.0 || here > 0.1 || P.smax == 0u || P.dripRate <= 0.0) { return; }
  let down = clamp(-wn.y, 0.0, 1.0);
  let rate = P.dripRate * wetness * wetness * (0.15 + 0.85 * down);
  let h0 = s * 747796405u + P.seed * 2891336453u + 17u;
  if (hash1(h0) >= rate * P.dt) { return; }
  let slot = atomicAdd(&sctl[0], 1u) % P.smax;
  if (sPos[slot].w > 0.0) { return; }
  sPos[slot] = vec4<f32>(probe, P.sprLife * 2.0);
  sVel[slot] = vec4<f32>(colSurfVel(k, wp) + wn * P.h * 2.0 * hash1(h0 + 1u), 0.0);
}
// narrow band, look only: a point at the centre of deep water cells (water on the grid with no particles), for the live view and bakes,
// written after the spray points (offset in P.opad). Above DEEPMAX deep cells an even, fixed sample is kept, sized from last frame's count.
const DEEPMAX: u32 = 200000u;
@compute @workgroup_size(256)
fn deepClear(@builtin(global_invocation_id) g: vec3<u32>) { let k = gid1(g); if (k >= DEEPMAX) { return; } let o = u32(P.opad) + k; if (o < arrayLength(&disp)) { disp[o] = vec4<f32>(0.0, -1.0e6, 0.0, 0.0); } }
@compute @workgroup_size(256)
fn deepPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = acell(gid1(g)); if (!a.ok) { return; }
  if (!inDom(a.p) || (ctype[a.c] & 0xffu) != 1u || atomicLoad(&cnt[a.c]) > 0) { return; }
  atomicAdd(&ctl[11], 1u);
  let prev = atomicLoad(&ctl[12]);
  if (prev > DEEPMAX && hash1(a.c * 2654435761u + 7u) * f32(prev) >= f32(DEEPMAX)) { return; }
  let k = atomicAdd(&ctl[13], 1u); if (k >= DEEPMAX) { return; }
  let o = u32(P.opad) + k; if (o >= arrayLength(&disp)) { return; }
  let x = cellCenter(a.p.x, a.p.y, a.p.z);
  disp[o] = vec4<f32>(x, 4096.0 + min(length(velGVec(x)), 63.0));
}
@compute @workgroup_size(1)
fn deepFin() { atomicStore(&ctl[14], min(atomicLoad(&ctl[13]), DEEPMAX)); atomicStore(&ctl[12], atomicLoad(&ctl[11])); atomicStore(&ctl[11], 0u); atomicStore(&ctl[13], 0u); }
`;
