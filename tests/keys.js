// Keyframes by channel group, Scale, proportion lock, the deferred collider rebuild and Inset (asserts; exits non-zero on a failure).
//  - keys: a Location key does not pin Rotation, Scale keys interpolate, auto key keys only what a transform changed, Alt+I takes a group off
//  - scale: typing one Scale value with the lock on scales all three; Dimensions in metres
//  - collide: Dam break with the cube scaled 1.6: no water deep inside the scaled cube, while with Scale 1 the same region fills
//  - rebuild: an edit-mode change marks the shape out of date without rebuilding; the next step rebuilds it
//  - inset: I on one face (region) and I I on all faces (each face): point and face counts, new points stay in the faces' planes
// node tests/keys.js [keys,scale,collide,rebuild,inset]
const { open, done, wait } = require('./lib');
const CASES = (process.argv[2] || 'keys,scale,collide,rebuild,inset').split(',');
let fails = 0;
const check = (name, ok, info) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!ok) fails++; };
(async () => {
  const t = await open('Dam break', { spacing: 0.05 });
  const cube = () => t.ev(() => window.__splash.objs.findIndex((o) => o.shape === 'cube'));
  if (CASES.includes('keys')) {
    const r = await t.ev(() => {
      const s = window.__splash, S = s.S, o = s.objs.find((q) => q.shape === 'cube'); s.select(o); o.keys = [];
      o.target.set(0, 0.5, 0); o.pos.copy(o.target); s.addKey(o, 0, ['loc']);
      o.target.set(1, 0.5, 0); o.pos.copy(o.target); s.addKey(o, 2, ['loc']);
      o.yaw = 1.2; s.addKey(o, 1, ['rot']);
      o.sx = o.sy = o.sz = 1; s.addKey(o, 0, ['scale']); o.sx = o.sy = o.sz = 2; s.addKey(o, 2, ['scale']);
      const p0 = s.keyPose(o.keys, 0, true), p1 = s.keyPose(o.keys, 1, true);
      // auto key: a Scale change keys only Scale
      S.tl.auto = true; S.tl.t = 1.5; o.sx = 3; s.autoKey(o, ['scale']); const k15 = Object.keys(o.keys.find((k) => Math.abs(k.t - 1.5) < 0.02) || {}).sort();
      const altBefore = o.keys.length; s.clearKeyAt(o, 1.5, ['scale']); const altAfter = o.keys.length;
      S.tl.auto = false;
      s.applyKeysAt(1); const live = { x: o.target.x, yaw: o.yaw, sx: o.sx, gs: o.group.scale.x };
      return { p0, p1, k15, altBefore, altAfter, live, n: o.keys.length };
    });
    check('a Location key does not pin Rotation (rotation at 0 s is the one Rotation key)', Math.abs(r.p0.yaw - 1.2) < 1e-6, r.p0);
    check('Location interpolates between its own keys', Math.abs(r.p1.x - 0.5) < 0.02, r.p1.x);
    check('Scale interpolates (1 to 2: 1.5 at the middle)', Math.abs(r.p1.sx - 1.5) < 0.02, r.p1.sx);
    check('auto key keys only Scale', JSON.stringify(r.k15) === JSON.stringify(['sx', 'sy', 'sz', 't']), r.k15);
    check('Alt+I takes the Scale group off and drops the empty key', r.altAfter === r.altBefore - 1, [r.altBefore, r.altAfter]);
    check('scrubbing poses the object and its drawn size', Math.abs(r.live.x - 0.5) < 0.02 && Math.abs(r.live.sx - 1.5) < 0.02 && Math.abs(r.live.gs - 1.5) < 0.02, r.live);
    await t.ev(() => { const s = window.__splash, o = s.objs.find((q) => q.shape === 'cube'); o.keys = []; o.sx = o.sy = o.sz = 1; s.renderKF(); s.renderUI(); });
  }
  if (CASES.includes('scale')) {
    const r = await t.ev(() => {
      const s = window.__splash, o = s.objs.find((q) => q.shape === 'cube'); s.select(o); o.sx = o.sy = o.sz = 1;
      o.lockScale = true; s.setScaleAxis(o, 0, 2); const locked = [o.sx, o.sy, o.sz];
      o.lockScale = false; s.setScaleAxis(o, 1, 0.5); const free = [o.sx, o.sy, o.sz];
      s.renderUI(); const dimX = +document.getElementById('dim-x').value, sclY = +document.getElementById('scl-y').value;
      o.sx = o.sy = o.sz = 1; s.renderUI();
      return { locked, free, dimX, sclY, lockBtn: !!document.getElementById('btn-lockscale') };
    });
    check('lock on: X = 2 scales all three by 2', r.locked.every((v) => Math.abs(v - 2) < 1e-6), r.locked);
    check('lock off: Y alone', Math.abs(r.free[0] - 2) < 1e-6 && Math.abs(r.free[1] - 0.5) < 1e-6, r.free);
    check('Dimensions show metres (cube 0.7 m wide at Scale 2: 1.4)', Math.abs(r.dimX - 1.4) < 0.01 && Math.abs(r.sclY - 0.5) < 1e-6 && r.lockBtn, r);
  }
  if (CASES.includes('collide')) {
    const res = {};
    for (const sc of [1.6, 1]) {
      res[sc] = await t.ev(async (sc) => {
        const s = window.__splash, S = s.S, o = s.objs.find((q) => q.shape === 'cube'); o.keys = [];
        o.sx = o.sy = o.sz = sc; o.target.set(S.org.x + 0.2, S.org.y + 0.6, S.org.z); o.pos.copy(o.target); o.rx = 0; o.yaw = 0.3; o.rz = 0; s.syncMesh(o);
        s.resetSim(0); const sim = s.getSim();
        for (let f = 0; f < 90; f++) { s.stepOnce(); if (f % 10 === 9) await sim.dev.queue.onSubmittedWorkDone(); }
        await sim.dev.queue.onSubmittedWorkDone();
        const n = sim.N, b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(sim.bPos, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]);
        await b.mapAsync(GPUMapMode.READ); const a = new Float32Array(b.getMappedRange()).slice(); b.unmap(); b.destroy();
        // the region deep inside the cube scaled 1.6 (85% of its half sizes), whatever the cube's Scale in this run
        const hx = 0.35 * 1.6 * 0.85, hy = 0.45 * 1.6 * 0.85, hz = 0.35 * 1.6 * 0.85, cy = Math.cos(o.yaw), sy = Math.sin(o.yaw);
        const cx0 = o.pos.x - S.simOrg.x, cy0 = o.pos.y - S.simOrg.y, cz0 = o.pos.z - S.simOrg.z; let inside = 0, live = 0;
        for (let i = 0; i < n; i++) {
          const y = a[i * 4 + 1]; if (y < -1e4) continue; live++;
          const dx = a[i * 4] - cx0, dy = y - cy0, dz = a[i * 4 + 2] - cz0, lx = cy * dx - sy * dz, lz = sy * dx + cy * dz;
          if (Math.abs(lx) < hx && Math.abs(dy) < hy && Math.abs(lz) < hz) inside++;
        }
        o.sx = o.sy = o.sz = 1; s.syncMesh(o);
        return { inside, live };
      }, sc);
    }
    check('scaled cube keeps water out of its inside', res[1.6].inside <= Math.max(5, res[1.6].live * 0.0005), res[1.6]);
    check('at Scale 1 the same region has water (the test can see a leak)', res[1].inside > 50 * Math.max(1, res[1.6].inside), res[1]);
    await t.shot('keys_collide');
  }
  if (CASES.includes('rebuild')) {
    const r = await t.ev(async () => {
      const s = window.__splash, o = s.objs.find((q) => q.shape === 'cube'); s.select(o);
      const id0 = o.sdf.id; s.enterEdit(o);
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      fire('a'); fire('s'); fire('1'); fire('.'); fire('3'); fire('Enter');
      const afterEdit = { dirty: !!o.sdfDirty, same: o.sdf.id === id0 };
      fire('Tab');   // leaving edit mode starts the rebuild in the background
      const t0 = performance.now(); s.stepOnce(); const ms = performance.now() - t0;
      return { afterEdit, afterStep: { dirty: !!o.sdfDirty, changed: o.sdf.id !== id0 }, stepMs: Math.round(ms) };
    });
    check('an edit only marks the collision shape out of date', r.afterEdit.dirty && r.afterEdit.same, r.afterEdit);
    check('the next step uses the new shape', !r.afterStep.dirty && r.afterStep.changed, r);
    await t.ev(() => window.__splash.undo());
  }
  if (CASES.includes('inset')) {
    const r = await t.ev(() => {
      const s = window.__splash, o = s.objs.find((q) => q.shape === 'cube'); s.select(o); o.sx = 2; o.sy = 1; o.sz = 1; s.syncMesh(o);
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      s.enterEdit(o); fire('3'); s.ES.f.clear(); s.ES.f.add(4);
      fire('i'); fire('0'); fire('.'); fire('1'); fire('Enter');
      const one = { v: o.mesh.v.length, f: o.mesh.f.length };
      // the inner face is 0.1 m in from each edge of the face (in metres, so 0.05 in the shape's own units along x where Scale is 2)
      const inner = o.mesh.f[4].map((i) => o.mesh.v[i]);
      const xs = inner.map((q) => q[0]), ys = inner.map((q) => q[1]), zs = inner.map((q) => q[2]);
      s.undo(); let o2 = s.objs.find((q) => q.shape === 'cube'); if (!s.ES || document.querySelector('#seg-sel') === null) s.enterEdit(o2); fire('3'); fire('a');
      fire('i'); fire('i'); fire('0'); fire('.'); fire('0'); fire('5'); fire('Enter');
      o2 = s.objs.find((q) => q.shape === 'cube'); const each = { v: o2.mesh.v.length, f: o2.mesh.f.length };
      const onSurface = o2.mesh.v.every((q) => [0.35, 0.45, 0.35].some((h, k) => Math.abs(Math.abs(q[k]) - h) < 1e-5));
      s.undo(); s.exitEdit(); o2 = s.objs.find((q) => q.shape === 'cube'); o2.sx = o2.sy = o2.sz = 1; s.syncMesh(o2);
      return { one, ext: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)].map((v) => +v.toFixed(4)), each, onSurface };
    });
    check('inset one face: 4 new points, 4 new faces', r.one.v === 12 && r.one.f === 10, r.one);
    check('inset is 0.1 m in from the edges, with Scale taken into account', [-0.3, 0.3, -0.35, 0.35, -0.35, -0.35].every((w, k) => Math.abs(r.ext[k] - w) < 1e-3), r.ext);
    check('I twice insets each face: 24 new points, 24 new faces, all on the cube', r.each.v === 32 && r.each.f === 30 && r.onSurface, r);
  }
  check('no page errors', !t.errs.length, t.errs.slice(0, 4));
  await done(t);
  console.log(fails ? fails + ' failed' : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
