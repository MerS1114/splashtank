  // ---------- three.js ----------
  const stage = $('#stage'), canvas = $('#gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const perspCam = new THREE.PerspectiveCamera(40, 1, 0.1, 60), orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  let camera = perspCam, viewAspect = 1, viewH = 1;
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(2, 5, 3); scene.add(sun);

  const cam = { theta: 0.8, phi: 1.0, r: 6.2, target: new THREE.Vector3(0, 0.7, 0) };
  function updateCam() {
    const sp = Math.sin(cam.phi), dx = sp * Math.sin(cam.theta), dy = Math.cos(cam.phi), dz = sp * Math.cos(cam.theta);
    perspCam.position.set(cam.target.x + cam.r * dx, cam.target.y + cam.r * dy, cam.target.z + cam.r * dz); perspCam.lookAt(cam.target);
    // orthographic: the same view, as wide as the perspective view is at the target, seen from far away so nothing is cut off
    const hh = cam.r * Math.tan(20 * Math.PI / 180), D = 150;
    orthoCam.left = -hh * viewAspect; orthoCam.right = hh * viewAspect; orthoCam.top = hh; orthoCam.bottom = -hh; orthoCam.updateProjectionMatrix();
    orthoCam.position.set(cam.target.x + D * dx, cam.target.y + D * dy, cam.target.z + D * dz); orthoCam.lookAt(cam.target);
    try { pmat.uniforms.uOrtho.value = S.ortho ? viewH / (2 * hh) : 0; } catch (e) { /* the point material is made a few lines later */ }
  }
  function setOrtho(on) { S.ortho = !!on; camera = S.ortho ? orthoCam : perspCam; updateCam(); }

  const LKMAX = 16;   // the most copies of a point (itself and 15 look-only extras)
  // ---- integer textures for the frames, made with WebGL directly (three.js r128 cannot update part of a texture) and handed to three.js
  // by setting the WebGL texture of an empty THREE.Texture, which three.js then only binds ----
  const gl = renderer.getContext();
  // [format, values per point, texels per point]. Positions are one-channel 16-bit, three texels per point (a texture 3 x TEXW wide):
  // three-channel textures have no native format on D3D (Chrome on Windows), so each upload of them was converted to four channels on the CPU.
  const TFMT = { p: [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, 3, 3], s: [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 1, 1], f: [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 1, 1], k: [gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, 1, 1],
    q: [gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, 1, 1], w: [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, 1, 1] };   // q, w: compact frames (compactFrame)
  // each texture of a slot sized to what it holds (rows of TEXW points: positions for all, speed for water and deep, white water for water,
  // whitewater codes for whitewater only), grown with 25% to spare. False when the GPU is out of memory (the slot is then left empty).
  const TBYTES = { p: 6, s: 1, f: 1, k: 4, q: 4, w: 2 }, OLDK = { p: 0, s: 0, f: 0, k: 0 };
  // exact: no room to spare (a finished bake that is all kept on the GPU never puts a bigger frame into the slot)
  function slotAlloc(sl, need, exact) {
    if (!sl.gl) { sl.gl = {}; sl.T = sl.T || {}; sl.rows = {}; }
    need = need || OLDK;
    for (const k in sl.gl) if (sl.gl[k] && !(k in need)) { gl.deleteTexture(sl.gl[k]); sl.gl[k] = null; sl.rows[k] = 0; }   // the other layout's textures
    for (const k in need) {
      const want = Math.max(exact ? 1 : 16, need[k] || 0); if (sl.gl[k] && sl.rows[k] >= want && (!exact || sl.rows[k] <= want)) continue;
      const rows = Math.min(exact ? want : Math.ceil(want * 1.25 / 16) * 16, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      if (sl.gl[k]) { gl.deleteTexture(sl.gl[k]); sl.gl[k] = null; sl.rows[k] = 0; }
      sl.key = null;
      const t = gl.createTexture(); renderer.state.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, TFMT[k][0], TEXW * TFMT[k][4], rows);
      if (gl.getError() === gl.OUT_OF_MEMORY) { gl.deleteTexture(t); return false; }
      sl.gl[k] = t; if (!sl.T[k]) sl.T[k] = new THREE.Texture();
      renderer.properties.get(sl.T[k]).__webglTexture = t; sl.rows[k] = rows;
    }
    return true;
  }
  function slotBytes(sl) { let b = 0; if (sl.gl) for (const k in TBYTES) if (sl.gl[k]) b += sl.rows[k] * TEXW * TBYTES[k]; return b; }
  function slotFree(sl) { if (sl.gl) for (const k in sl.gl) if (sl.gl[k]) gl.deleteTexture(sl.gl[k]); sl.gl = null; sl.rows = {}; sl.key = null; sl.nW = sl.nD = sl.nS = 0; }
  // n values of a frame array into rows from row0: the whole rows, then the part of the last one
  function upTex(t, k, row0, data, n) {
    if (!n) return 0;
    const f = TFMT[k], c = f[3], tp = f[4], full = Math.floor(n / TEXW), rem = n - full * TEXW;
    renderer.state.bindTexture(gl.TEXTURE_2D, t);
    if (full) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row0, TEXW * tp, full, f[1], f[2], data, 0);
    if (rem) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row0 + full, rem * tp, 1, f[1], f[2], data, full * TEXW * c);
    return n * c * data.BYTES_PER_ELEMENT;
  }
  // a frame into a slot, as it is (no per-point work on the CPU)
  function slotLoad(sl, fr, b, exact) {
    const t0 = performance.now(), show = S.showSpray !== false;
    const nW = fr ? fr.n : 0, nD = fr && fr.dp ? fr.dp.n : 0, nS = fr && show && fr.sp ? fr.sp.n : 0;
    const rW = Math.ceil(nW / TEXW), rD = Math.ceil(nD / TEXW), rS = Math.ceil(nS / TEXW);
    const cq = !!(fr && fr.p32);   // compact frame: positions in q, speed and white water in w
    if (!slotAlloc(sl, cq ? { q: rW + rD + rS, w: rW + rD, k: rS } : { p: rW + rD + rS, s: rW + rD, f: fr && fr.fm ? rW : 0, k: rS }, exact)) { perf.oom = (perf.oom || 0) + 1; return false; }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    let by = 0;
    if (cq) {
      if (nW) by += upTex(sl.gl.q, 'q', 0, fr.p32, nW) + upTex(sl.gl.w, 'w', 0, fr.sf, nW);
      if (nD) by += upTex(sl.gl.q, 'q', rW, fr.dp.p32, nD) + upTex(sl.gl.w, 'w', rW, fr.dp.sf, nD);
      if (nS) by += upTex(sl.gl.q, 'q', rW + rD, fr.sp.p32, nS) + upTex(sl.gl.k, 'k', 0, fr.sp.pk, nS);
    } else {
      if (nW) { by += upTex(sl.gl.p, 'p', 0, fr.pos, nW) + upTex(sl.gl.s, 's', 0, fr.spd, nW); if (fr.fm) by += upTex(sl.gl.f, 'f', 0, fr.fm, nW); }
      if (nD) by += upTex(sl.gl.p, 'p', rW, fr.dp.pos, nD) + upTex(sl.gl.s, 's', rW, fr.dp.spd, nD);
      if (nS) by += upTex(sl.gl.p, 'p', rW + rD, fr.sp.pos, nS) + upTex(sl.gl.k, 'k', 0, fr.sp.pk, nS);   // whitewater codes from row 0 of their own texture
    }
    Object.assign(sl, { q: cq ? fr.q : null, nW, nD, nS, rowD: rW, rowS: rW + rD, fm: !!(fr && fr.fm), b: (fr && fr.b) || b || DEFB, sb: (fr && fr.sb) || null, alive: fr ? frameAlive(fr, show) : 0 });
    perf.up = performance.now() - t0; perf.upBytes = by; perf.upN++;
    return true;
  }
  // three draws: water (blended between two frames), deep water and whitewater (from the nearer frame). The vertex count is points x copies;
  // the only vertex attribute is a dummy that three.js needs to know how many vertices to draw.
  let dummyPos = new THREE.BufferAttribute(new Uint8Array(1 << 16), 1);
  const geoW = new THREE.BufferGeometry(), geoD = new THREE.BufferGeometry(), geoS = new THREE.BufferGeometry();
  [geoW, geoD, geoS].forEach((g) => { g.setAttribute('position', dummyPos); g.setDrawRange(0, 0); });
  let shownN = 0;
  const TYPE_COL = { water: [0.16, 0.46, 0.96], churn: [0.55, 0.85, 0.97], foam: [0.98, 0.98, 0.98], spray: [1.0, 0.6, 0.16], mist: [0.86, 0.56, 1.0], deep: [0.07, 0.2, 0.52], bubble: [0.25, 0.85, 0.6] };
  const v3 = (c) => 'vec3(' + c.map((x) => x.toFixed(3)).join(',') + ')';
  const U = { uSize: { value: 0.1 }, uScale: { value: 600 }, uMax: { value: S.vmax }, uFoam: { value: S.foam }, uOrtho: { value: 0 }, uMode: { value: 0 },
    uD: { value: 0.04 }, uCR: { value: 2 }, uKw: { value: 0 }, uKs: { value: 4 }, uStreak: { value: 0.02 }, uVs: { value: 1 }, uCull: { value: 2 }, uSzK: { value: 1 } };
  const tex = () => ({ value: null }), num = (v) => ({ value: v || 0 }), vec = () => ({ value: new THREE.Vector3() });
  const VHEAD = 'uniform float uSize; uniform float uScale; uniform float uFoam; uniform float uOrtho; uniform float uD; uniform float uCR; uniform float uKw; uniform float uKs; uniform float uStreak; uniform float uK1; uniform float uVs; uniform float uCull;' +
    ' varying float vS; varying float vF; varying float vK; varying float vL; varying vec3 vMV; varying float vRad; uniform float uSzK;' +
    ' uint hsh(uint x) { x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }' +
    ' vec3 ball(uint s) { vec3 r = vec3(float(hsh(s) & 65535u), float(hsh(s + 7919u) & 65535u), float(hsh(s + 104729u) & 65535u)) / 32767.5 - 1.0; float l = length(r); return l > 1.0 ? r / l : r; }' +
    ' void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vK = 0.0; vS = 0.0; vF = 0.0; vL = 0.0; }' +
    ' ivec2 tcOf(int i) { return ivec2(i % ' + TEXW + ', i / ' + TEXW + '); }' +
    // a position on 0..65535 across the box: three 16-bit texels, or (qb.x > 0, compact frames) one 32-bit texel with qb bits an axis
    ' vec3 pAt(highp usampler2D t, ivec2 tc, vec3 qb) { if (qb.x < 0.5) { int x = tc.x * 3; return vec3(uvec3(texelFetch(t, ivec2(x, tc.y), 0).r, texelFetch(t, ivec2(x + 1, tc.y), 0).r, texelFetch(t, ivec2(x + 2, tc.y), 0).r)); }' +
    '  uint v = texelFetch(t, tc, 0).r; uint bx = uint(qb.x + 0.5); uint by = uint(qb.y + 0.5); uint bz = uint(qb.z + 0.5); uint mx = (1u << bx) - 1u; uint my = (1u << by) - 1u; uint mz = (1u << bz) - 1u;' +
    '  return vec3(float(v & mx) / float(mx), float((v >> bx) & my) / float(my), float((v >> (bx + by)) & mz) / float(mz)) * 65535.0; }' +
    // look-only copies smaller than uCull pixels on screen add nothing a viewer can see: far away they are left out
    ' float pxAt(vec3 p, float sz) { vec4 mv = modelViewMatrix * vec4(p, 1.0); return (uOrtho > 0.0 ? uSize * uOrtho : uSize * uScale / max(-mv.z, 1e-4)) * sz; }' +
    // Surface drawing, anisotropic shapes: a coarse grid of how many water points each cell holds (tAtlas, its z slices tiled across a 2D
    // texture: uA0 corner, uAh cell size, uAn cells per side, uAt slices per row) gives every point the direction out of the water. SPLAT
    // draws each point into its cell; ANISO flattens points at the surface along that direction (vN, vFl) so they melt into a smooth skin.
    '\n#if defined(SPLAT) || defined(ANISO)\n uniform vec3 uA0; uniform float uAh; uniform vec3 uAn; uniform float uAt; uniform vec2 uAs;' +
    ' ivec2 atl(ivec3 c) { int t = int(uAt + 0.5); return ivec2((c.z % t) * int(uAn.x + 0.5) + c.x, (c.z / t) * int(uAn.y + 0.5) + c.y); }\n#endif\n' +
    '\n#ifdef SPLAT\n void splatAt(vec3 p) { ivec3 c = clamp(ivec3(floor((p - uA0) / uAh)), ivec3(0), ivec3(uAn) - 1); vec2 px = vec2(atl(c)) + 0.5;' +
    '  gl_Position = vec4(px / uAs * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 1.0; }\n#endif\n' +
    '\n#ifdef ANISO\n uniform sampler2D tAtlas; varying vec3 vN; varying float vFl;' +
    ' float aDen(vec3 g) { vec3 f = g - 0.5; vec3 b = floor(f); vec3 w = f - b; ivec3 c0 = ivec3(b); float s = 0.0; ivec3 hi = ivec3(uAn) - 1;' +
    '  for (int k = 0; k < 8; k++) { ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1); ivec3 c = c0 + o; if (any(lessThan(c, ivec3(0))) || any(greaterThan(c, hi))) continue;' +
    '   vec3 ww = mix(1.0 - w, w, vec3(o)); s += ww.x * ww.y * ww.z * texelFetch(tAtlas, atl(c), 0).r; } return s; }' +
    ' void aniso(vec3 p) { vec3 g = (p - uA0) / uAh; float d0 = aDen(g);' +
    '  vec3 gr = vec3(aDen(g + vec3(1, 0, 0)) - aDen(g - vec3(1, 0, 0)), aDen(g + vec3(0, 1, 0)) - aDen(g - vec3(0, 1, 0)), aDen(g + vec3(0, 0, 1)) - aDen(g - vec3(0, 0, 1))) * 0.5;' +
    '  float full = pow(uAh / uD, 3.0); float s = length(gr) / full; float f = smoothstep(0.08, 0.3, s) * smoothstep(0.3, 0.55, d0 / full);' +
    // squashed to 0.35 along the normal and widened 1.7 times along the surface (about the same volume): flat discs only as wide as
    // a point left gaps between neighbours when seen at an angle, which the smoothing turned into grain
    '  float tg = mix(1.0, 1.7, f); vFl = mix(1.0, 0.35, f) / tg; vRad *= tg; gl_PointSize *= tg;' +
    '  vN = length(gr) > 1e-6 ? normalize(mat3(modelViewMatrix) * (-gr)) : vec3(0.0, 0.0, 1.0); }\n#endif\n' +
    // vMV and vRad (the point's centre in view space and its radius) are for the surface's depth pass; uSzK enlarges the points there
    ' void place(vec3 p, float sz, float minPx) { vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; sz *= uSzK; vMV = mv.xyz; vRad = 0.5 * uSize * sz; gl_PointSize = max((uOrtho > 0.0 ? uSize * uOrtho : uSize * uScale / (-mv.z)) * sz, minPx); }';
  // water: blended between frame A and frame B (the same particle has the same number in both). A particle only in B shows at once;
  // one only in A shows until halfway.
  const VW = VHEAD + ' uniform highp usampler2D tPA; uniform highp usampler2D tSA; uniform highp usampler2D tFA; uniform highp usampler2D tPB; uniform highp usampler2D tSB; uniform highp usampler2D tFB;' +
    ' uniform float uHide; uniform float uNA; uniform float uNB; uniform float uFmA; uniform float uFmB; uniform float uBlend; uniform float uFdt; uniform vec3 uB0A; uniform vec3 uQA; uniform vec3 uB0B; uniform vec3 uQB; uniform vec3 uQbA; uniform vec3 uQbB;' +
    ' void main() { int k1 = int(uK1 + 0.5); int bi = gl_VertexID / k1; float lk = float(gl_VertexID - bi * k1); ivec2 tc = tcOf(bi); bool bl = uBlend > 0.0;' +
    // compact frames hold speed | white-water level << 8 in one texel; the others a speed texel and a white-water texel (level x 17)
    '  uint ra = bi < int(uNA + 0.5) ? texelFetch(tSA, tc, 0).r : 255u; uint rb = (bl && bi < int(uNB + 0.5)) ? texelFetch(tSB, tc, 0).r : 255u;' +
    '  bool cA = uQbA.x > 0.5; bool cB = uQbB.x > 0.5; uint sa = cA ? (ra & 255u) : ra; uint sb = cB ? (rb & 255u) : rb;' +
    '  bool va = sa != 255u; bool vb = sb != 255u; vec3 p; float spd; float lv;' +
    '  float la = !va ? 0.0 : cA ? float((ra >> 8u) & 15u) : uFmA > 0.5 ? floor(float(texelFetch(tFA, tc, 0).r) / 17.0 + 0.5) : 0.0;' +
    '  float lb = !vb ? 0.0 : cB ? float((rb >> 8u) & 15u) : uFmB > 0.5 ? floor(float(texelFetch(tFB, tc, 0).r) / 17.0 + 0.5) : 0.0;' +
    // buried water (compact bake frames mark it, bit 12): no view can see it, so only 1 in 16 is drawn, twice the size and without
    // copies, as a backstop behind gaps between surface points (with none the inside was hollow and the gaps showed as dark specks)
    '  bool bur = uHide > 0.5 && (!va || !cA || ((ra >> 12u) & 1u) == 1u) && (!vb || !cB || ((rb >> 12u) & 1u) == 1u) && (va || vb) && (cA || cB);' +
    '\n#ifndef SPLAT\n if (bur && ((hsh(uint(bi)) & 15u) != 0u || lk > 0.5)) { hide(); return; }\n#endif\n' +
    // a slot can be a different particle in the next frame (narrow band reseeding reuses slots): if it is further than it could have moved,
    // it is not blended but switches halfway, so nothing streaks across the water
    '  vec3 pa = va ? pAt(tPA, tc, uQbA) * uQA + uB0A : vec3(0.0); vec3 pb = vb ? pAt(tPB, tc, uQbB) * uQB + uB0B : vec3(0.0);' +
    '  float sm = max(float(sa), float(sb)); if (va && vb && sm < 191.0 && length(pb - pa) > sm / 16.0 / uVs * 2.0 * uFdt + 3.0 * uD) { if (uBlend < 0.5) vb = false; else va = false; }' +
    '  if (va && vb) { p = mix(pa, pb, uBlend); spd = mix(float(sa), float(sb), uBlend) / 16.0; lv = floor(mix(la, lb, uBlend) + 0.5); }' +
    '  else if (va && uBlend < 0.5) { p = pa; spd = float(sa) / 16.0; lv = la; }' +
    '  else if (vb) { p = pb; spd = float(sb) / 16.0; lv = lb; }' +
    '  else { hide(); return; }' +
    '  vK = 0.0; vS = spd; vL = lv / 15.0; vF = vL * uFoam;' +
    '\n#ifdef SPLAT\n if (lk > 0.5) { hide(); return; } splatAt(p); return;\n#endif\n' +
    '  if (lk > uKw + 0.5) { hide(); return; }' +
    '  if (lk > 0.5) { p += ball(uint(bi) * 16u + uint(lk)) * 0.5 * uD; if (pxAt(p, 1.0) < uCull) { hide(); return; } }' +
    '  place(p, (1.0 - 0.3 * vF) * (bur ? 2.0 : 1.0), 1.5);' +
    '\n#ifdef ANISO\n aniso(p);\n#endif\n }';
  // deep water (narrow band, look only): the centre of each deep cell and four extras spread over the cell
  const VD = VHEAD + ' uniform highp usampler2D tP; uniform highp usampler2D tS; uniform float uBase; uniform float uN; uniform vec3 uB0; uniform vec3 uQ; uniform vec3 uQb;' +
    ' void main() { int k1 = int(uK1 + 0.5); int bi = gl_VertexID / k1; float lk = float(gl_VertexID - bi * k1); if (bi >= int(uN + 0.5)) { hide(); return; }' +
    '  int idx = int(uBase + 0.5) + bi; ivec2 tc = tcOf(idx); uint s = texelFetch(tS, tc, 0).r & 255u; if (s == 255u) { hide(); return; }' +
    '  vec3 p = pAt(tP, tc, uQb) * uQ + uB0; vK = 3.0; vS = float(s) / 16.0; vL = 0.0; vF = 0.0;' +
    '  if (lk > 0.5) { p += ball(uint(idx) * 16u + uint(lk)) * 0.5 * uD * uCR; if (pxAt(p, 1.3) < uCull) { hide(); return; } }' +
    '  place(p, 1.3, 1.5); }';
  // whitewater from its 32-bit code: spray (its copies trail back along its motion as a short streak), mist (a soft cloud), foam (flat on the
  // surface, fading with its life) and bubbles
  const VS = VHEAD + ' uniform highp usampler2D tP; uniform highp usampler2D tK; uniform float uBase; uniform float uN; uniform vec3 uB0; uniform vec3 uQ; uniform vec3 uQb;' +
    ' void main() { int k1 = int(uK1 + 0.5); int bi = gl_VertexID / k1; float lk = float(gl_VertexID - bi * k1); if (bi >= int(uN + 0.5)) { hide(); return; }' +
    '  int idx = int(uBase + 0.5) + bi; ivec2 tc = tcOf(idx); uint pk = texelFetch(tK, tcOf(bi), 0).r; if (pk == 0u) { hide(); return; }' +
    '  vec3 p = pAt(tP, tc, uQb) * uQ + uB0; uint kc = (pk >> 29u) & 3u; float spd = float((pk >> 21u) & 255u) / 4.0; float life = float(pk & 1023u) / 1023.0;' +
    // mist, foam and bubbles carry a seed from their slot (packSpray), so their extras stay put; older caches without one use the point number
    '  uint sd = kc == 2u ? (pk & 0xFFFFFu) : kc == 0u ? 0u : ((pk >> 10u) & 2047u);' +
    '  vF = 0.0; vL = 0.0; uint hs = (sd != 0u ? sd + 1048576u : uint(idx)) * 16u + uint(lk);' +
    '  if (kc == 0u) { vK = 1.0; vS = spd; if (lk > uKs + 0.5) { hide(); return; }' +
    '   float u = float(pk & 1023u) / 1023.0 * 2.0 - 1.0; float w = float((pk >> 10u) & 1023u) / 1023.0 * 2.0 - 1.0; vec3 n = vec3(u, w, 1.0 - abs(u) - abs(w));' +
    '   if (n.z < 0.0) n.xy = vec2((1.0 - abs(w)) * (u >= 0.0 ? 1.0 : -1.0), (1.0 - abs(u)) * (w >= 0.0 ? 1.0 : -1.0)); n = normalize(n);' +
    '   if (lk > 0.5) p += -n * min(spd * uStreak, 0.6) * lk / max(uKs, 1.0) + ball(hs) * 0.2 * uD;' +
    '   place(p, 0.42, 1.0); return; }' +
    '  if (kc == 2u) { vK = 2.0; vS = spd; if (lk > uKs + 0.5) { hide(); return; } if (lk > 0.5) p += ball(hs) * 1.6 * uD; place(p, 0.6, 1.0); return; }' +
    '  vS = life * 63.0;' +
    '  if (kc == 1u) { vK = 4.0; if (lk > ceil(uKs * 0.5) + 0.5) { hide(); return; } if (lk > 0.5) { vec3 o = ball(hs); o.y *= 0.12; p += o * uD * (0.5 + 0.5 * life); } place(p, 0.5 * (0.6 + 0.4 * life), 1.0); return; }' +
    '  vK = 5.0; if (lk > min(uKs, 2.0) + 0.5) { hide(); return; } if (lk > 0.5) p += ball(hs) * 0.25 * uD; place(p, 0.32, 1.0); }';
  const FRAG = 'uniform float uMax; uniform float uMode; varying float vS; varying float vF; varying float vK; varying float vL;' +
    'vec3 ramp(float t){ vec3 a = vec3(0.03,0.12,0.95); vec3 b = vec3(0.0,0.82,0.98); vec3 c = vec3(1.0); return t < 0.5 ? mix(a,b,t*2.0) : mix(b,c,(t-0.5)*2.0); }' +
    'void main(){ vec2 p = gl_PointCoord*2.0-1.0; float r2 = dot(p,p); if(r2 > 1.0) discard;\n' +
    '#ifdef WW\n' +
    // whitewater is drawn see-through and soft-edged, so many points build up into white masses instead of hard dots
    ' float edge = 1.0 - smoothstep(0.45, 1.0, r2); float life = clamp(vS / 63.0, 0.0, 1.0); vec3 c; float a;' +
    ' if (vK > 4.5) { c = uMode > 0.5 ? ' + v3(TYPE_COL.bubble) + ' : vec3(0.74,0.89,0.97); a = 0.55; }' +
    ' else if (vK > 3.5) { c = uMode > 0.5 ? ' + v3(TYPE_COL.foam) + ' : vec3(0.95,0.97,0.99); a = 0.85 * (0.35 + 0.65 * life); }' +
    ' else if (vK > 1.5) { c = uMode > 0.5 ? ' + v3(TYPE_COL.mist) + ' : vec3(0.86,0.9,0.95); a = 0.22; }' +
    ' else { c = uMode > 0.5 ? ' + v3(TYPE_COL.spray) + ' : vec3(0.96,0.98,1.0); a = 0.9; }' +
    ' gl_FragColor = vec4(c, a * edge);\n' +
    '#else\n' +
    ' float sh = 0.78+0.22*(1.0-r2);' +
    ' if (uMode > 0.5) { vec3 c = vK > 2.5 ? ' + v3(TYPE_COL.deep) + ' : (vL > 0.3 ? ' + v3(TYPE_COL.churn) + ' : ' + v3(TYPE_COL.water) + '); gl_FragColor = vec4(c*sh,1.0); return; }' +
    ' float t = clamp(vS/uMax,0.0,1.0); vec3 col = vK > 2.5 ? ramp(t)*0.82 : mix(ramp(t), vec3(0.97,0.99,1.0), vF); gl_FragColor = vec4(col*sh,1.0);\n' +
    '#endif\n }';
  const matW = new THREE.ShaderMaterial({ uniforms: Object.assign({}, U, { tPA: tex(), tSA: tex(), tFA: tex(), tPB: tex(), tSB: tex(), tFB: tex(), uNA: num(), uNB: num(), uFmA: num(), uFmB: num(), uBlend: num(), uFdt: num(1 / 24), uK1: num(1), uHide: num(1), uB0A: vec(), uQA: vec(), uB0B: vec(), uQB: vec(), uQbA: vec(), uQbB: vec() }), vertexShader: VW, fragmentShader: FRAG });
  const matD = new THREE.ShaderMaterial({ uniforms: Object.assign({}, U, { tP: tex(), tS: tex(), uBase: num(), uN: num(), uK1: num(5), uB0: vec(), uQ: vec(), uQb: vec() }), vertexShader: VD, fragmentShader: FRAG });
  const matS = new THREE.ShaderMaterial({ uniforms: Object.assign({}, U, { tP: tex(), tK: tex(), uBase: num(), uN: num(), uK1: num(1), uB0: vec(), uQ: vec(), uQb: vec() }), vertexShader: VS, fragmentShader: FRAG,
    defines: { WW: 1 }, transparent: true, depthWrite: false });
  const pmat = matW;   // the shared uniforms (size, colours, ...) are the same objects in all three materials
  const boxU = (b0, q, b) => { b0.value.set(b.x0, b.y0, b.z0); q.value.set((b.x1 - b.x0) / 65535, (b.y1 - b.y0) / 65535, (b.z1 - b.z0) / 65535); };
  // show slot a (and slot bi to blend the water towards, by w)
  let lastBox = null;   // the box of the water drawn last (the surface's count grid covers it)
  function showSlots(a, bi, w) {
    const A = SLOTS[a], B = SLOTS[bi], N = w < 0.5 ? A : B, uw = matW.uniforms;
    // while the live sim runs, drawing shares the GPU with the solver (on Mer's UHD 730 a redraw cost more than half a step), so the
    // look-only copies are left out then: none for the water, at most one for whitewater
    // a bake playing: Fast always draws the lite look; Smooth steps down (S.pbLvl, set by the frame loop) while frames come late
    const bakePlay = viewMode() === 'cache' && S.cplay, lvl = bakePlay ? (S.pbQ === 'fast' ? 2 : S.pbQ === 'smooth' ? S.pbLvl | 0 : 0) : 0;
    const lite = (S.liteRun && viewMode() === 'live' && S.playing && !S.lcPlay) || lvl >= 2;
    const dW = lite || S.surface ? 0 : lvl === 1 ? (S.detail | 0) >> 1 : S.detail | 0, dS = lite ? Math.min(S.sprDetail | 0, 1) : lvl === 1 ? (S.sprDetail | 0) >> 1 : S.sprDetail | 0;
    U.uCull.value = lvl >= 3 ? 4 : 2; uw.uHide.value = S.hideIn ? 1 : 0;
    const kW = 1 + Math.min(dW, LKMAX - 1), kS = 1 + Math.min(dS, LKMAX - 1), kD = lite || S.surface ? 1 : 5;
    const vW = (w > 0 ? Math.max(A.nW, B.nW) : A.nW) * kW, vD = N.nD * kD, vS = N.nS * kS, need = Math.max(vW, vD, vS);
    if (dummyPos.count < need) { dummyPos = new THREE.BufferAttribute(new Uint8Array(Math.ceil(need * 1.25)), 1); [geoW, geoD, geoS].forEach((g) => g.setAttribute('position', dummyPos)); }
    U.uKw.value = dW; U.uKs.value = Math.min(dS, LKMAX - 1); U.uStreak.value = S.streak;
    // compact slots: positions in T.q, speed and white water in T.w (also bound as the unused white-water texture)
    const tp = (X) => (X.q ? X.T.q : X.T.p), ts = (X) => (X.q ? X.T.w : X.T.s), tff = (X) => (X.q ? X.T.w : X.T.f), qb = (v, X) => (X.q ? v.set(X.q[0], X.q[1], X.q[2]) : v.set(0, 0, 0));
    uw.tPA.value = tp(A); uw.tSA.value = ts(A); uw.tFA.value = tff(A); uw.tPB.value = tp(B); uw.tSB.value = ts(B); uw.tFB.value = tff(B); qb(uw.uQbA.value, A); qb(uw.uQbB.value, B);
    uw.uNA.value = A.nW; uw.uNB.value = w > 0 ? B.nW : 0; uw.uFmA.value = A.fm ? 1 : 0; uw.uFmB.value = B.fm ? 1 : 0; uw.uBlend.value = w; uw.uK1.value = kW;
    boxU(uw.uB0A, uw.uQA, A.b || DEFB); boxU(uw.uB0B, uw.uQB, B.b || DEFB); lastBox = A.b || DEFB;
    const ud = matD.uniforms; ud.tP.value = tp(N); ud.tS.value = ts(N); qb(ud.uQb.value, N); ud.uBase.value = N.rowD * TEXW; ud.uN.value = N.nD; ud.uK1.value = kD; boxU(ud.uB0, ud.uQ, N.b || DEFB);
    const us = matS.uniforms; us.tP.value = tp(N); us.tK.value = N.T.k; qb(us.uQb.value, N); us.uBase.value = N.rowS * TEXW; us.uN.value = N.nS; us.uK1.value = kS; boxU(us.uB0, us.uQ, N.sb || N.b || DEFB);   // whitewater is quantized across the whitewater area
    geoW.setDrawRange(0, vW); geoD.setDrawRange(0, vD); geoS.setDrawRange(0, vS); shownN = N.nW + N.nD + N.nS;
  }
  function hideSlots() { geoW.setDrawRange(0, 0); geoD.setDrawRange(0, 0); geoS.setDrawRange(0, 0); shownN = 0; }
  SLOTS.forEach((sl) => slotAlloc(sl, null));
  const points = new THREE.Group(), pointsW = new THREE.Points(geoW, matW), pointsD = new THREE.Points(geoD, matD), pointsS = new THREE.Points(geoS, matS);
  [pointsW, pointsD, pointsS].forEach((q) => { q.frustumCulled = false; points.add(q); }); scene.add(points);

  // ---------- water drawn as a surface (Display > Draw water: Surface) ----------
  // Screen-space fluid surface: the water points are drawn as spheres into a depth target (the nearest wins), the depth is smoothed
  // with a bilateral filter so neighbouring spheres melt into one surface but separate sheets stay apart, then one full-screen pass shades
  // it (normals from the smoothed depth, sky reflection by Fresnel, a highlight, the speed colours) and writes its depth, so objects and
  // whitewater (still points, drawn after it) sit in it correctly.
  const fsVert = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  // a sphere per point, or with ANISO an ellipsoid squashed to vFl of its radius along vN: the view ray through this pixel meets it where
  // |M (x - centre)| = radius, M stretching the vN direction by 1 / vFl
  const SPH = 'uniform mat4 projectionMatrix; varying float vS; varying float vF; varying float vK; varying float vL; varying vec3 vMV; varying float vRad;' +
    '\n#ifdef ANISO\n varying vec3 vN; varying float vFl;\n#endif\n' +
    'void main() { vec2 c = gl_PointCoord * 2.0 - 1.0; c.y = -c.y; float r2 = dot(c, c); if (r2 > 1.0) discard; vec3 e = vMV + vec3(c, sqrt(1.0 - r2)) * vRad;' +
    '\n#ifdef ANISO\n if (vFl < 0.99) { vec3 pp = vMV + vec3(c * vRad, 0.0); bool persp = projectionMatrix[3][3] < 0.5;' +
    '  vec3 ro = persp ? vec3(0.0) : vec3(pp.xy, vMV.z + 4.0 * vRad); vec3 rd = persp ? normalize(pp) : vec3(0.0, 0.0, -1.0); float a1 = 1.0 / vFl - 1.0;' +
    '  vec3 oc = ro - vMV; vec3 mo = oc + a1 * dot(vN, oc) * vN; vec3 md = rd + a1 * dot(vN, rd) * vN;' +
    '  float A = dot(md, md); float B = dot(mo, md); float C = dot(mo, mo) - vRad * vRad; float D = B * B - A * C; if (D < 0.0) discard;' +
    '  e = ro + rd * ((-B - sqrt(D)) / A); }\n#endif\n' +
    ' vec4 cl = projectionMatrix * vec4(e, 1.0); gl_FragDepthEXT = cl.z / cl.w * 0.5 + 0.5; gl_FragColor = vec4(-e.z, vS, vF, vRad); }';
  const ext = { fragDepth: true };
  Object.assign(matW.uniforms, { tAtlas: tex(), uA0: vec(), uAh: num(1), uAn: vec(), uAt: num(1), uAs: { value: new THREE.Vector2(1, 1) } });
  const matWS = new THREE.ShaderMaterial({ uniforms: matW.uniforms, vertexShader: VW, fragmentShader: SPH, extensions: ext, defines: { ANISO: 1 } });
  const matWS0 = new THREE.ShaderMaterial({ uniforms: matW.uniforms, vertexShader: VW, fragmentShader: SPH, extensions: ext });   // round, when Surface shapes is off
  const matSplat = new THREE.ShaderMaterial({ uniforms: matW.uniforms, vertexShader: VW, fragmentShader: 'void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }', defines: { SPLAT: 1 },
    depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true });
  const aScene = new THREE.Scene(), aGroup = new THREE.Group(), aW = new THREE.Points(geoW, matSplat); aW.frustumCulled = false; aGroup.add(aW); aScene.add(aGroup);
  let atlasRT = null; const aCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // the coarse count grid for the anisotropic shapes, over the box the water is drawn in, cells of 2 spacings (coarser if it would not fit)
  function atlasPass(box) {
    const u = matW.uniforms, d = u.uD.value || 0.05, E = [box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0];
    let h = 2 * d, n, tx, W, H;
    for (let k = 0; k < 12; k++, h *= 1.25) {
      n = E.map((e) => Math.max(2, Math.ceil(e / h) + 1)); tx = Math.max(1, Math.floor(4096 / n[0])); W = tx * n[0]; H = Math.ceil(n[2] / tx) * n[1];
      if (H <= 4096 && n[0] <= 4096) break;
    }
    if (!atlasRT || atlasRT.width !== W || atlasRT.height !== H) {
      if (atlasRT) atlasRT.dispose();
      atlasRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false });
      atlasRT.texture.generateMipmaps = false;
    }
    u.uA0.value.set(box.x0, box.y0, box.z0); u.uAh.value = h; u.uAn.value.set(n[0], n[1], n[2]); u.uAt.value = tx; u.uAs.value.set(W, H);
    aGroup.position.copy(points.position); aGroup.updateMatrixWorld();
    renderer.setRenderTarget(atlasRT); renderer.clear(); renderer.render(aScene, aCam);
    u.tAtlas.value = atlasRT.texture;
  }
  const matDS = new THREE.ShaderMaterial({ uniforms: matD.uniforms, vertexShader: VD, fragmentShader: SPH, extensions: ext });
  const sScene = new THREE.Scene(), sGroup = new THREE.Group(), sW = new THREE.Points(geoW, matWS), sD = new THREE.Points(geoD, matDS);
  [sW, sD].forEach((q) => { q.frustumCulled = false; sGroup.add(q); }); sScene.add(sGroup);
  // separable bilateral blur of the depth: the radius follows the point size on screen; samples much nearer or further are left out
  const blurMat = new THREE.ShaderMaterial({ uniforms: { tD: { value: null }, uDir: { value: new THREE.Vector2() }, uScale: U.uScale, uOrtho: U.uOrtho, uK: { value: 1 }, uCap: { value: 28 }, uNrf: { value: 1 } }, vertexShader: fsVert, depthTest: false, depthWrite: false,
    fragmentShader: 'uniform sampler2D tD; uniform vec2 uDir; uniform float uScale; uniform float uOrtho; uniform float uK; uniform float uCap; uniform float uNrf; varying vec2 vUv;' +
      'void main() { vec4 c = texture2D(tD, vUv); if (c.r <= 0.0) { gl_FragColor = c; return; }' +
      ' float rpx = clamp((uOrtho > 0.0 ? c.a * uOrtho : c.a * uScale / c.r) * 4.0 * uK, 1.0, uCap); float st = max(1.0, rpx / 10.0); float sr = c.a * 3.0;' +
      ' float sum = 0.0; float ws = 0.0; for (int i = -10; i <= 10; i++) { float x = float(i) * st; vec4 q = texture2D(tD, vUv + uDir * x); if (q.r <= 0.0) continue;' +
      // narrow-range filter (Truong and Yuksel 2018): a sample far behind is another surface and is left out; one far in front is pulled
      // to just in front, so the edge of a nearer sheet still smooths this one a little instead of being ignored or dragging it forward
      '  float qd = q.r; float w = exp(-x * x / (2.0 * rpx * rpx * 0.25));' +
      '  if (uNrf > 0.5) { if (qd > c.r + sr) continue; qd = max(qd, c.r - sr); } else { float dz = (qd - c.r) / (c.a * 4.0); w *= exp(-dz * dz); }' +   // uNrf 0: the older bilateral weight
      '  sum += qd * w; ws += w; }' +
      ' gl_FragColor = vec4(sum / max(ws, 1e-6), c.gba); }' });
  const fsScene = new THREE.Scene(), fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), fsQuad = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), blurMat);
  fsQuad.frustumCulled = false; fsScene.add(fsQuad);
  const compMat = new THREE.ShaderMaterial({ uniforms: { uDbg: { value: 0 }, tD: { value: null }, uTex: { value: new THREE.Vector2() }, uProj: { value: new THREE.Matrix4() }, uPersp: { value: 1 }, uMax: U.uMax, uFoam: U.uFoam, uMode: U.uMode, uVs: U.uVs },
    vertexShader: fsVert, extensions: ext,
    fragmentShader: 'uniform float uDbg; uniform sampler2D tD; uniform vec2 uTex; uniform mat4 uProj; uniform float uPersp; uniform float uMax; uniform float uFoam; uniform float uMode; varying vec2 vUv;' +
      'vec3 ramp(float t){ vec3 a = vec3(0.03,0.12,0.95); vec3 b = vec3(0.0,0.82,0.98); vec3 c = vec3(1.0); return t < 0.5 ? mix(a,b,t*2.0) : mix(b,c,(t-0.5)*2.0); }' +
      'vec3 eyeAt(vec2 uv) { float d = texture2D(tD, uv).r; vec2 n = uv * 2.0 - 1.0; if (d <= 0.0) return vec3(0.0, 0.0, 1.0);' +
      ' if (uPersp > 0.5) return vec3((n.x + uProj[2][0]) * d / uProj[0][0], (n.y + uProj[2][1]) * d / uProj[1][1], -d);' +
      ' return vec3((n.x - uProj[3][0]) / uProj[0][0], (n.y - uProj[3][1]) / uProj[1][1], -d); }' +
      'vec3 side(vec3 e, vec3 a, vec3 b) { bool ga = a.z <= 0.0; bool gb = b.z <= 0.0; if (ga && (!gb || abs(a.z - e.z) < abs(e.z - b.z))) return a - e; if (gb) return e - b; return vec3(0.0); }' +
      'void main() { vec4 t = texture2D(tD, vUv); if (t.r <= 0.0) discard; vec3 e = eyeAt(vUv);' +
      // normals over two pixels each way: one-pixel differences magnify what little noise the blur leaves
      ' vec3 dx = side(e, eyeAt(vUv + vec2(2.0 * uTex.x, 0.0)), eyeAt(vUv - vec2(2.0 * uTex.x, 0.0))); vec3 dy = side(e, eyeAt(vUv + vec2(0.0, 2.0 * uTex.y)), eyeAt(vUv - vec2(0.0, 2.0 * uTex.y)));' +
      ' vec3 n = normalize(cross(dx, dy)); if (dot(dx, dx) * dot(dy, dy) == 0.0 || any(isnan(n))) n = vec3(0.0, 0.0, 1.0);' +
      ' vec3 v = uPersp > 0.5 ? normalize(-e) : vec3(0.0, 0.0, 1.0); if (dot(n, v) < 0.0) n = -n;' +
      ' float foam = clamp(t.b, 0.0, 1.0); vec3 base = uMode > 0.5 ? (foam > 0.3 ? vec3(0.55,0.85,0.97) : vec3(0.16,0.46,0.96)) : mix(ramp(clamp(t.g / uMax, 0.0, 1.0)), vec3(0.97,0.99,1.0), foam);' +
      ' vec3 L = normalize(vec3(0.35, 0.75, 0.55)); float dif = 0.45 + 0.55 * max(dot(n, L), 0.0); float fr = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);' +
      ' float sp = pow(max(dot(n, normalize(L + v)), 0.0), 90.0); vec3 sky = vec3(0.78, 0.86, 0.95);' +
      ' vec3 col = mix(base * dif, sky, fr * 0.7) + sp * 0.55 * (1.0 - foam); gl_FragColor = vec4(col, 1.0);' +
      // uDbg (tests): 1 shows the smoothed depth as bands, 2 the normals
      ' if (uDbg > 0.5) gl_FragColor = vec4(uDbg > 1.5 ? n * 0.5 + 0.5 : vec3(fract(t.r * 4.0)), 1.0);' +
      ' vec4 cl = uProj * vec4(e, 1.0); gl_FragDepthEXT = cl.z / cl.w * 0.5 + 0.5; }' });
  const surfQuad = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), compMat); surfQuad.frustumCulled = false; surfQuad.visible = false; surfQuad.renderOrder = -1; scene.add(surfQuad);
  const surfType = renderer.extensions.get('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType, surfSz = new THREE.Vector2(), clr = new THREE.Color();
  let surfA = null, surfB = null;
  function surfTargets(w, h) {
    if (surfA && surfA.width === w && surfA.height === h) return;
    [surfA, surfB].forEach((r) => r && r.dispose());
    const mk = () => { const r = new THREE.WebGLRenderTarget(w, h, { type: surfType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false }); r.texture.generateMipmaps = false; return r; };
    surfA = mk(); surfB = mk();
  }
  // draws the view: water as points, or as a surface when Display > Draw water is Surface
  function renderView(cam) {
    const on = S.surface && points.visible && (geoW.drawRange.count > 0 || geoD.drawRange.count > 0);
    if (!on) { renderer.render(scene, cam); return; }
    renderer.getDrawingBufferSize(surfSz); surfTargets(surfSz.x, surfSz.y);
    renderer.getClearColor(clr); const ca = renderer.getClearAlpha();
    sGroup.position.copy(points.position); sGroup.updateMatrixWorld();
    if (S.surfAniso && geoW.drawRange.count > 0) { renderer.setClearColor(0x000000, 0); atlasPass(lastBox || DEFB); sW.material = matWS; } else sW.material = matWS0;
    U.uSzK.value = 1.25;   // a little larger than drawn as points, so neighbours overlap into one surface
    renderer.setClearColor(0x000000, 0); renderer.setRenderTarget(surfA); renderer.clear(); renderer.render(sScene, cam);
    U.uSzK.value = 1;
    blurMat.uniforms.uK.value = S.surfSmooth; blurMat.uniforms.uNrf.value = S.surfNrf ? 1 : 0;   // the bilateral weight looked smoother on Mer's card than the narrow-range filter
    blurMat.uniforms.uCap.value = 28 * Math.max(1, surfSz.y / 720);   // 28 pixels on a 720-pixel-high picture, more on bigger or sharper screens
    for (let it = 0; it < 2; it++) {
      blurMat.uniforms.tD.value = surfA.texture; blurMat.uniforms.uDir.value.set(1 / surfSz.x, 0); renderer.setRenderTarget(surfB); renderer.render(fsScene, fsCam);
      blurMat.uniforms.tD.value = surfB.texture; blurMat.uniforms.uDir.value.set(0, 1 / surfSz.y); renderer.setRenderTarget(surfA); renderer.render(fsScene, fsCam);
    }
    renderer.setRenderTarget(null); renderer.setClearColor(clr, ca);
    const cu = compMat.uniforms; cu.tD.value = surfA.texture; cu.uTex.value.set(1 / surfSz.x, 1 / surfSz.y); cu.uProj.value.copy(cam.projectionMatrix); cu.uPersp.value = cam.isPerspectiveCamera ? 1 : 0;
    pointsW.visible = false; pointsD.visible = false; surfQuad.visible = true;
    renderer.render(scene, cam);
    pointsW.visible = true; pointsD.visible = true; surfQuad.visible = false;
  }

  // the ocean around the box: a grid of look-only points on the wave surface, worked out on the GPU from the same waves the solver uses.
  // It covers the boundary at the sides (which holds no particles) and runs out past the box; the inside of the box is the simulated water.
  const OV_RES = 400;
  const oceanGeo = new THREE.BufferGeometry();
  { const a = new Float32Array(OV_RES * OV_RES * 3); for (let j = 0; j < OV_RES; j++) for (let i = 0; i < OV_RES; i++) { const k = (j * OV_RES + i) * 3; a[k] = i; a[k + 2] = j; } oceanGeo.setAttribute('position', new THREE.BufferAttribute(a, 3)); }
  const oceanMat = new THREE.ShaderMaterial({
    uniforms: { uW: { value: Array.from({ length: 48 }, () => new THREE.Vector4()) }, uN: { value: 0 }, uT: { value: 0 }, uLevel: { value: 0 }, uBox: { value: new THREE.Vector4() }, uLayer: { value: 0 },
      uOrg: { value: new THREE.Vector2() }, uStep: { value: 0.1 }, uRes: { value: 2 }, uSize: { value: 0.1 }, uScale: { value: 600 }, uOrtho: { value: 0 }, uMax: { value: 5 } },
    vertexShader: 'uniform vec4 uW[48]; uniform float uN; uniform float uT; uniform float uLevel; uniform vec4 uBox; uniform float uLayer; uniform vec2 uOrg; uniform float uStep; uniform float uRes;' +
      ' uniform float uSize; uniform float uScale; uniform float uOrtho; varying float vS;' +
      ' void main(){ if (position.x >= uRes || position.z >= uRes) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }' +
      ' vec2 xz = uOrg + position.xz * uStep;' +
      ' float dw = min(min(xz.x - uBox.x, uBox.y - xz.x), min(xz.y - uBox.z, uBox.w - xz.y));' +
      ' if (dw > 0.5 * uLayer) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }' +
      ' float eta = uLevel; vec3 v = vec3(0.0);' +
      ' for (int k = 0; k < 24; k++) { if (float(k) >= uN) break; vec4 A = uW[2 * k]; vec4 B = uW[2 * k + 1];' +
      '  float th = A.x * xz.x + A.y * xz.y - A.w * uT + B.x; float c = cos(th); float s = sin(th); eta += A.z * c; float aw = A.z * A.w; v.xz += aw * c * A.xy / max(B.y, 1e-4); v.y += aw * s; }' +
      ' vec4 mv = modelViewMatrix * vec4(xz.x, eta, xz.y, 1.0); gl_Position = projectionMatrix * mv; vS = length(v);' +
      ' gl_PointSize = max(uOrtho > 0.0 ? uSize * uOrtho : uSize * uScale / (-mv.z), 1.5); }',
    fragmentShader: 'uniform float uMax; varying float vS;' +
      'vec3 ramp(float t){ vec3 a = vec3(0.03,0.12,0.95); vec3 b = vec3(0.0,0.82,0.98); vec3 c = vec3(1.0); return t < 0.5 ? mix(a,b,t*2.0) : mix(b,c,(t-0.5)*2.0); }' +
      'void main(){ vec2 p = gl_PointCoord*2.0-1.0; float r2 = dot(p,p); if(r2 > 1.0) discard; float t = clamp(vS/uMax,0.0,1.0); gl_FragColor = vec4(ramp(t)*(0.74+0.2*(1.0-r2)),1.0); }'
  });
  const oceanPts = new THREE.Points(oceanGeo, oceanMat); oceanPts.frustumCulled = false; oceanPts.visible = false; scene.add(oceanPts);
  let oceanViewKey = '', oceanViewW = null;
  function oceanUpdate(mode) {
    let cfg = null, t = 0, b = null, org = null, d = S.liveD, g = S.g / (S.scale || 1), sc = S.scale || 1;
    if (mode === 'cache') { const c = S.cache; cfg = c.desc && c.desc.ocean; t = S.ct / c.fps; b = c.b; org = c.org || S.org; d = c.d; if (c.desc && c.desc.g) g = c.desc.g; sc = c.scale || 1; }
    else if (S.lcPlay) { cfg = oceanCfg(); t = S.lcT / 60; b = LC.b; org = LC.org; d = LC.d; }
    else { cfg = oceanCfg(); t = S.frame * DT; b = sim && sim.b; org = S.simOrg; }
    const on = !!(cfg && cfg.on && S.oceanView && b && org);
    oceanPts.visible = on; if (!on) return;
    const key = JSON.stringify(cfg) + '|' + g + '|' + b.y0;
    if (key !== oceanViewKey) { oceanViewKey = key; oceanViewW = oceanWaves(cfg, g, cfg.level - b.y0); }
    const W = oceanViewW, u = oceanMat.uniforms;
    for (let k = 0; k < 24; k++) { const j = k * 8; u.uW.value[2 * k].set(W.w[j], W.w[j + 1], W.w[j + 2], W.w[j + 3]); u.uW.value[2 * k + 1].set(W.w[j + 4], W.w[j + 5], 0, 0); }
    const bw = b.x1 - b.x0, bd = b.z1 - b.z0, ext = 0.75 * Math.max(bw, bd), L = Math.max(bw, bd) + 2 * ext;
    const res = clamp(Math.ceil(L / (1.4 * d)), 64, OV_RES), step = L / (res - 1);
    u.uN.value = W.n; u.uT.value = t; u.uLevel.value = cfg.level; u.uBox.value.set(b.x0, b.x1, b.z0, b.z1); u.uLayer.value = cfg.layer;
    u.uOrg.value.set((b.x0 + b.x1) / 2 - L / 2, (b.z0 + b.z1) / 2 - L / 2); u.uStep.value = step; u.uRes.value = res;
    u.uSize.value = step * 1.25 * S.psize; u.uScale.value = pmat.uniforms.uScale.value; u.uOrtho.value = pmat.uniforms.uOrtho.value;
    u.uMax.value = S.vmax / sc;
    oceanGeo.setDrawRange(0, OV_RES * res);
    oceanPts.position.set(org.x, org.y, org.z);
  }

  const lineMat = new THREE.LineBasicMaterial({ color: 0x8a949e, transparent: true, opacity: 0.5 });
  const b = { x0: -1.5, x1: 1.5, y0: 0, y1: 2.6, z0: -1.5, z1: 1.5 };
  let W = 3, Hh = 2.6, Dd = 3;
  const tank = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), lineMat);
  scene.add(tank);
  const gridGeo = new THREE.BufferGeometry();
  const gridMat = new THREE.LineBasicMaterial({ color: 0x8a949e, transparent: true, opacity: 0.2 });
  scene.add(new THREE.LineSegments(gridGeo, gridMat));
  // the whitewater area (dashed): spray and mist fly on past the tank walls up to here; the water itself stays in the tank
  const areaMat = new THREE.LineDashedMaterial({ color: 0xb8c4d0, transparent: true, opacity: 0.45, dashSize: 0.1, gapSize: 0.08 });
  const areaBox = new THREE.LineSegments(new THREE.BufferGeometry(), areaMat); areaBox.frustumCulled = false; areaBox.visible = false; scene.add(areaBox);
  function updateAreaViz() {
    const a = wwArea(), on = S.sprOn && S.engine === 'flip' && (a.k > 1 || a.up > 1);
    areaBox.visible = on; if (!on) return;
    const A = wwAreaBox(b, a), X = [A.x0, A.x1], Y = [A.y0, A.y1], Z = [A.z0, A.z1], p = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      p.push(X[0], Y[i], Z[j], X[1], Y[i], Z[j]); p.push(X[i], Y[0], Z[j], X[i], Y[1], Z[j]); p.push(X[i], Y[j], Z[0], X[i], Y[j], Z[1]);
    }
    areaBox.geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); areaBox.computeLineDistances();
    const ds = Math.max(A.x1 - A.x0, A.z1 - A.z0) * 0.015; areaMat.dashSize = ds; areaMat.gapSize = ds * 0.8;
  }
  // the detail region (dashed, Bake > Detail): a box given as shares of the tank (S.det centre and size), shown while the Bake tab is open
  const detMat = new THREE.LineDashedMaterial({ color: 0x7fd0ff, transparent: true, opacity: 0.8, dashSize: 0.1, gapSize: 0.06 });
  const detBox = new THREE.LineSegments(new THREE.BufferGeometry(), detMat); detBox.frustumCulled = false; detBox.visible = false; scene.add(detBox);
  function detShare() {   // the region as shares of the tank, 0-1 on each axis
    const d = S.det, c = (v) => Math.max(0, Math.min(1, v));
    return { x0: c(d.cx - d.sx / 2), x1: c(d.cx + d.sx / 2), y0: c(d.cy - d.sy / 2), y1: c(d.cy + d.sy / 2), z0: c(d.cz - d.sz / 2), z1: c(d.cz + d.sz / 2) };
  }
  function detIn(B) {   // the region in a box (the scene's or a cache's)
    const s = detShare(), L = (a, b, t) => a + (b - a) * t;
    return { x0: L(B.x0, B.x1, s.x0), x1: L(B.x0, B.x1, s.x1), y0: L(B.y0, B.y1, s.y0), y1: L(B.y0, B.y1, s.y1), z0: L(B.z0, B.z1, s.z0), z1: L(B.z0, B.z1, s.z1) };
  }
  function updateDetViz() {
    const on = S.tab === 'bake' && S.engine === 'flip';
    detBox.visible = on; if (!on) return;
    const A = detIn(b), X = [A.x0, A.x1], Y = [A.y0, A.y1], Z = [A.z0, A.z1], p = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      p.push(X[0], Y[i], Z[j], X[1], Y[i], Z[j]); p.push(X[i], Y[0], Z[j], X[i], Y[1], Z[j]); p.push(X[i], Y[j], Z[0], X[i], Y[j], Z[1]);
    }
    detBox.geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); detBox.computeLineDistances();
    const ds = Math.max(A.x1 - A.x0, A.z1 - A.z0, 0.01) * 0.03; detMat.dashSize = ds; detMat.gapSize = ds * 0.6;
  }
  const openMat = new THREE.LineBasicMaterial({ color: 0xe0a030 });
  const openLines = [];
  for (let i = 0; i < 6; i++) { const l = new THREE.LineLoop(new THREE.BufferGeometry(), openMat); l.frustumCulled = false; l.visible = false; scene.add(l); openLines.push(l); }
  // face handles: an arrow on every face of the sim box that slides the face along its axis
  const FACES = [
    { k: 'x0', ax: 'x', sgn: -1, col: 0xe0554a }, { k: 'x1', ax: 'x', sgn: 1, col: 0xe0554a },
    { k: 'y0', ax: 'y', sgn: -1, col: 0x6cc24a }, { k: 'y1', ax: 'y', sgn: 1, col: 0x6cc24a },
    { k: 'z0', ax: 'z', sgn: -1, col: 0x4a8fe0 }, { k: 'z1', ax: 'z', sgn: 1, col: 0x4a8fe0 }
  ];
  const handleGrp = new THREE.Group(); scene.add(handleGrp);
  const handleMeshes = [];
  FACES.forEach((f) => {
    const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: f.col, depthTest: false, transparent: true, opacity: 0.95 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 8), mat); shaft.position.y = 0.17;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.32, 14), mat); cone.position.y = 0.5;
    [shaft, cone].forEach((m) => { m.renderOrder = 20; m.userData.face = f; g.add(m); handleMeshes.push(m); });
    const dv = new THREE.Vector3(f.ax === 'x' ? f.sgn : 0, f.ax === 'y' ? f.sgn : 0, f.ax === 'z' ? f.sgn : 0);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dv); f.dir = dv; f.group = g; f.mat = mat; handleGrp.add(g);
  });
  function faceCoord(k) { return b[k]; }
  // coloured lines through the pivot for the axis (or the two axes of a plane) a transform is locked to
  const AXCOL = { x: 0xff3352, y: 0x8bdc00, z: 0x2890ff, n: 0xf0d050 };
  const tfLines = [0, 1].map(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 })); l.renderOrder = 30; l.frustumCulled = false; l.visible = false; scene.add(l); return l; });
  function setTfLine(l, p, d, col) { const a = p.clone().addScaledVector(d, -300), c = p.clone().addScaledVector(d, 300), arr = l.geometry.attributes.position.array; arr.set([a.x, a.y, a.z, c.x, c.y, c.z]); l.geometry.attributes.position.needsUpdate = true; l.material.color.setHex(col); l.visible = true; }
  function updateTfLines() {
    tfLines[0].visible = tfLines[1].visible = false;
    if (!tf || !tf.axis) return;
    const ax = curAxis();
    if (!tf.plane) { setTfLine(tfLines[0], tf.pivot, ax, AXCOL[tf.axis]); return; }
    const others = ['x', 'y', 'z'].filter((q) => q !== tf.axis);
    others.forEach((q, i) => setTfLine(tfLines[i], tf.pivot, axisDir(q), AXCOL[q]));
  }
  // where a snapped move lands
  const snapMark = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffb02e, depthTest: false, transparent: true, opacity: 0.95, wireframe: true }));
  snapMark.renderOrder = 31; snapMark.visible = false; scene.add(snapMark);
  // optional 3D gizmo on the selection: arrows move along an axis, rings rotate about it, small cubes scale along it, the centre ball moves freely
  const gizmo = new THREE.Group(); gizmo.visible = false; scene.add(gizmo);
  const gizParts = [];
  {
    const mk = (geo, col, part, hit) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: hit ? 0 : 0.95, depthWrite: false }));
      m.renderOrder = hit ? 24 : 25; m.userData.part = part; m.userData.col = col; gizmo.add(m); if (hit) gizParts.push(m); else part.vis.push(m); return m;
    };
    const up = new THREE.Vector3(0, 1, 0);
    for (const a of ['x', 'y', 'z']) {
      const dir = new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0), q = new THREE.Quaternion().setFromUnitVectors(up, dir), col = AXCOL[a];
      const mv = { type: 'g', axis: a, vis: [] }, sc = { type: 's', axis: a, vis: [] }, ro = { type: 'r', axis: a, vis: [] };
      const sh = mk(new THREE.CylinderGeometry(0.018, 0.018, 0.78, 8), col, mv); sh.quaternion.copy(q); sh.position.copy(dir).multiplyScalar(0.53);
      const cn = mk(new THREE.ConeGeometry(0.07, 0.2, 14), col, mv); cn.quaternion.copy(q); cn.position.copy(dir).multiplyScalar(1.0);
      const hm = mk(new THREE.CylinderGeometry(0.08, 0.08, 0.95, 6), col, mv, true); hm.quaternion.copy(q); hm.position.copy(dir).multiplyScalar(0.6);
      const cb = mk(new THREE.BoxGeometry(0.09, 0.09, 0.09), col, sc); cb.quaternion.copy(q); cb.position.copy(dir).multiplyScalar(0.4);
      const ch = mk(new THREE.BoxGeometry(0.17, 0.17, 0.17), col, sc, true); ch.quaternion.copy(q); ch.position.copy(dir).multiplyScalar(0.4);
      const rq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      const rg = mk(new THREE.TorusGeometry(1.25, 0.012, 6, 64), col, ro); rg.quaternion.copy(rq);
      const rh = mk(new THREE.TorusGeometry(1.25, 0.07, 6, 48), col, ro, true); rh.quaternion.copy(rq);
    }
    const fr = { type: 'g', axis: null, vis: [] };
    mk(new THREE.SphereGeometry(0.07, 12, 8), 0xf2f2f2, fr); mk(new THREE.SphereGeometry(0.14, 8, 6), 0xf2f2f2, fr, true);
  }
  let gizHover = null;
  function gizPivot() {
    if (uiMode === 'edit' && editO) { const vs = [...selVerts()]; if (!vs.length) return null; const pl = [0, 0, 0]; vs.forEach((i) => { for (let k = 0; k < 3; k++) pl[k] += editO.mesh.v[i][k] / vs.length; }); editO.group.updateMatrixWorld(true); return worldOfLocal(editO, pl); }
    const list = [...selSet]; if (!list.length) return null;
    const p = new THREE.Vector3(); list.forEach((o) => p.add(o.pos)); return p.multiplyScalar(1 / list.length);
  }
  function placeGizmo() {
    const p = S.gizmo && viewMode() === 'live' && !S.baking && !tf ? gizPivot() : null;
    gizmo.visible = !!p; if (!p) return;
    gizmo.position.copy(p);
    // a fixed size on screen: the arrows are about 64 px long whatever the zoom
    const hpx = Math.max(200, canvas.clientHeight || 600), worldPerPx = S.ortho ? (camera.top - camera.bottom) / (camera.zoom || 1) / hpx : 2 * Math.tan(camera.fov * Math.PI / 360) * camera.position.distanceTo(p) / hpx;
    gizmo.scale.setScalar(Math.max(1e-4, worldPerPx * 64));
    const fo = uiMode === 'edit' ? editO : (selSet.size === 1 && selected && selected.kind === 'mesh' ? selected : null);
    if (S.orient === 'local' && fo) gizmo.rotation.set(fo.rx || 0, fo.yaw || 0, fo.rz || 0, 'ZYX'); else gizmo.rotation.set(0, 0, 0);
  }
  function pickGizmo(cx, cy) {
    if (!gizmo.visible) return null;
    gizmo.updateMatrixWorld(true); setNdc(cx, cy);
    const hits = ray.intersectObjects(gizParts.filter((m) => m.visible), false);
    if (!hits.length) return null;
    const order = { s: 0, g: 1, r: 2 }; hits.sort((p, q) => (order[p.object.userData.part.type] - order[q.object.userData.part.type]) || (p.distance - q.distance));
    return hits[0].object.userData.part;
  }
  function hoverGizmo(part) {
    if (part === gizHover) return;
    if (gizHover) gizHover.vis.forEach((m) => m.material.color.setHex(m.userData.col));
    gizHover = part; if (part) part.vis.forEach((m) => m.material.color.setHex(0xffd34a));
  }
  function placeHandles() {
    placeGizmo(); updateTfLines(); drawAxisWidget();
    if (!(tf && tf.type === 'g' && tf.snapAt)) snapMark.visible = false;
    const show = S.handles && viewMode() === 'live' && uiMode === 'object' && !S.baking && !tf;
    handleGrp.visible = show; if (!show) return;
    const sc = Math.max(0.3, cam.r * 0.055), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
    for (const f of FACES) {
      f.group.position.set(f.ax === 'x' ? b[f.k] : cx, f.ax === 'y' ? b[f.k] : cy, f.ax === 'z' ? b[f.k] : cz);
      f.group.scale.setScalar(sc);
    }
  }
  function updateDomainViz() {
    W = S.dom.w; Hh = S.dom.h; Dd = S.dom.d;
    const m = S.min;
    b.x0 = m.x; b.x1 = m.x + W; b.y0 = m.y; b.y1 = m.y + Hh; b.z0 = m.z; b.z1 = m.z + Dd;
    S.org.x = m.x + W / 2; S.org.y = m.y; S.org.z = m.z + Dd / 2;
    tank.scale.set(W, Hh, Dd); tank.position.set(b.x0 + W / 2, b.y0 + Hh / 2, b.z0 + Dd / 2);
    const gp = [], nx = Math.max(2, Math.round(W / 0.2)), nz = Math.max(2, Math.round(Dd / 0.2)), gy = b.y0 + 0.002;
    for (let i = 0; i <= nx; i++) { const t = b.x0 + (W / nx) * i; gp.push(t, gy, b.z0, t, gy, b.z1); }
    for (let i = 0; i <= nz; i++) { const t = b.z0 + (Dd / nz) * i; gp.push(b.x0, gy, t, b.x1, gy, t); }
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    const face = (a) => new THREE.Float32BufferAttribute(a, 3), yl = b.y0 + 0.004;
    const quad = {
      x0: [b.x0, b.y0, b.z0, b.x0, b.y1, b.z0, b.x0, b.y1, b.z1, b.x0, b.y0, b.z1], x1: [b.x1, b.y0, b.z0, b.x1, b.y1, b.z0, b.x1, b.y1, b.z1, b.x1, b.y0, b.z1],
      y0: [b.x0, yl, b.z0, b.x1, yl, b.z0, b.x1, yl, b.z1, b.x0, yl, b.z1], y1: [b.x0, b.y1, b.z0, b.x1, b.y1, b.z0, b.x1, b.y1, b.z1, b.x0, b.y1, b.z1],
      z0: [b.x0, b.y0, b.z0, b.x1, b.y0, b.z0, b.x1, b.y1, b.z0, b.x0, b.y1, b.z0], z1: [b.x0, b.y0, b.z1, b.x1, b.y0, b.z1, b.x1, b.y1, b.z1, b.x0, b.y1, b.z1]
    };
    const names = ['x0', 'x1', 'y0', 'y1', 'z0', 'z1'];
    names.forEach((nm, i) => { openLines[i].geometry.setAttribute('position', face(quad[nm])); openLines[i].visible = !!S.open[nm]; });
    updateAreaViz(); updateDetViz();
  }
  updateDomainViz();

  function resize() {
    const w = Math.max(stage.clientWidth, 10), h = Math.max(stage.clientHeight, 10);   // the timeline sits under the viewport now, not over it
    renderer.setSize(w, h, false); try { ovRes(); } catch (e) { /* edit overlay not made yet */ }
    perspCam.aspect = w / h; perspCam.updateProjectionMatrix(); viewAspect = w / h; viewH = renderer.domElement.height;
    pmat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((perspCam.fov * Math.PI / 180) / 2));
    updateCam();
  }
  const ro = new ResizeObserver(() => resize()); ro.observe(stage);

