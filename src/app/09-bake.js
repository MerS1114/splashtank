  // ---------- baking ----------
  let worker = null, sharedSrc = '';
  function buildDesc() {
    const bk = Object.assign({}, S.bk, bakeRes());
    return {
      d: bk.d, maxN: bk.maxN, fps: bk.fps, substeps: bk.sub, frames: Math.round(bk.dur * bk.fps), g: S.g / (S.scale || 1), iters: bk.iters, visc: S.visc, flip: S.flip, comp: 6, cellRatio: S.cellRatio, fastAir: S.fastAir, sortP: S.sortP, maxSub: bk.maxSub, detail: S.bkDetail || 1, colMax: simPar().colMax, vmaxW: simPar().vmax, wind: simPar().wind, drag: simPar().drag, gust: simPar().gust, foamSens: simPar().foamSens, foamTau: S.foamTau,
      scale: S.scale || 1, tear: simPar().tear, spr: simPar().spr, air: simPar().air, drip: simPar().drip, nb: nbCfg(), ocean: oceanCfg(), sprayCap: S.sprOn && S.engine === 'flip' ? S.sprCap : 0, nbLook: !!(S.nbLook && nbActive()), size: [S.dom.w, S.dom.h, S.dom.d], open: openMask(),
      fills: resolveFills().map((f) => Object.assign({}, f)), events: S.events.map((e) => Object.assign({}, e)),
      objs: objs.map((o) => Object.assign(snap(o), { rec: o.rec && o.rec.arr.length >= 4 ? { start: o.rec.start, arr: Float32Array.from(o.rec.arr, (v, i) => v - (i % 4 === 0 ? S.org.x : i % 4 === 1 ? S.org.y : i % 4 === 2 ? S.org.z : 0)) } : null, keys: o.keys.length ? o.keys.map((k) => Object.assign({}, k, { x: k.x - S.org.x, y: k.y - S.org.y, z: k.z - S.org.z })) : null, smooth: S.tl.smooth }))
    };
  }
  function setBakeUI(running) {
    $('#btn-bake').disabled = running; $('#btn-cancel').hidden = !running; $('#bake-progress').hidden = !running;
    $('#seg-mode').querySelectorAll('button').forEach((x) => { x.disabled = running; });
    wwButtons();
  }
  function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function frameBytes(f) {
    const by = (o, ks) => (o ? ks.reduce((t, k) => t + (o[k] ? o[k].byteLength : 0), 0) : 0);
    return by(f, ['pos', 'p32', 'spd', 'sf', 'fm', 'objs']) + by(f.sp, ['pos', 'p32', 'pk']) + by(f.dp, ['pos', 'p32', 'spd', 'sf']);
  }
  function cacheBytes(c) { let n = 0; for (const f of c.frames) n += frameBytes(f); return n; }

  // the bake settings without the heavy parts (distance grids, recorded motion), for the cache file and the report
  function lightDesc(desc) {
    const d = Object.assign({}, desc);
    d.fills = (desc.fills || []).map((f) => (f.sdf ? Object.assign({}, f, { sdf: { dims: f.sdf.dims, cell: f.sdf.cell } }) : f));   // water volumes without their distance grids
    d.objs = desc.objs.map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, z: o.z, rx: o.rx, yaw: o.yaw, rz: o.rz, spin: o.spin, on: o.on, speed: o.speed, radius: o.radius, water: o.water, keys: o.keys, recFrames: o.rec ? o.rec.arr.length / 4 : 0, sdfCells: o.sdf ? o.sdf.dims : null }));
    return d;
  }
  function onBakeFrame(fr, info, cache) {
    if (cache.q === undefined) cache.q = compactBits(cache.b, cache.d);
    if (cache.q) fr = compactFrame(fr, cache.q);   // a quarter smaller in memory, on the GPU and in the file
    if (fr.sp && fr.sp.n) fr.wws = 1;   // whitewater that came with the water bake (2: made by Bake whitewater)
    cache.frames.push(fr);
    if (S.cache === cache && S.cfollow) S.ct = cache.frames.length - 1;
    if (S.cache === cache && (cache.frames.length < 4 || cache.frames.length % 6 === 0)) updateCacheInfo();
    if (info.diag) {   // the fastest water and the substeps against their limits, reported when the bake ends
      const d = info.diag, sc = cache.scale || 1;
      cache.vpeak = Math.max(cache.vpeak || 0, (d.fastestParticle || 0) * sc, (d.maxSpeed || 0) * sc);
      if (d.atWaterSpeedLimit > 0) cache.vcapFrames = (cache.vcapFrames || 0) + 1;
      if (d.sub && d.sub >= ((cache.desc && cache.desc.maxSub) || 16)) cache.subCapFrames = (cache.subCapFrames || 0) + 1;
    }
    if (info.diag && cache.diag) cache.diag.push(Object.assign({ f: info.f, t: info.f / cache.fps, n: info.n, elapsed: info.elapsed }, info.diag));
    cache.maxN = Math.max(cache.maxN, fr.n);
    const pct = (info.f / info.F) * 100; S.bakeT = info.f / cache.fps; lcUi();
    $('#bake-prog').style.width = pct + '%';
    const eta = info.f > 0 ? (info.elapsed / info.f) * (info.F - info.f) : 0;
    $('#bake-status').innerHTML = 'Frame <b>' + info.f + '</b> of ' + info.F + ' · <b>' + fmtN(info.n) + '</b> points · ' + fmtTime(info.elapsed) + ' elapsed, about ' + fmtTime(eta) + ' left' + (info.full ? '<br>Max points reached, emission stopped.' : '');
  }
  // the fastest water and the substeps against their limits during a bake: says which limit to raise when one held the water back
  function bakeLimits(c) {
    const vmax = (c.desc && c.desc.vmaxW ? c.desc.vmaxW * (c.scale || 1) : S.vmaxW), ms = (c.desc && c.desc.maxSub) || 16;
    let t = 'Fastest water ' + Math.round(c.vpeak || 0) + ' m/s (limit ' + Math.round(vmax) + ').';
    if (c.vcapFrames) t += ' <span class="warn">The water reached its speed limit in ' + c.vcapFrames + ' frames: raise Max water speed (Simulation, Physics).</span>';
    if (c.subCapFrames) t += ' <span class="warn">' + c.subCapFrames + ' frames needed the most substeps the bake allows (' + ms + '): raise its Max substeps.</span>';
    return t;
  }
  function finishBake(cache, cancelled) {
    S.baking = false; setBakeUI(false); S.bakeT = 0;
    if (worker) { worker.terminate(); worker = null; }
    cache.partial = false;
    if (cache.frames.length < 2) {   // nothing usable: the cache from before comes back
      S.cache = cache.prev || null; delete cache.prev;
      $('#bake-status').textContent = cancelled ? 'Bake cancelled before any frames were finished.' : 'Nothing was baked.';
      if (S.cache) buildTicks(); updateCacheInfo(); applyMode(); lcUi(); return;
    }
    delete cache.prev;
    if (cancelled) cache.cancelled = true;
    S.cache = cache; S.ct = cancelled ? Math.min(S.ct, cache.frames.length - 1) : 0; S.cfollow = false; setCPlay(!cancelled);
    buildTicks(); updateCacheInfo();
    $('#bake-status').innerHTML = cancelled ? 'Cancelled. Kept the <b>' + (cache.frames.length - 1) + '</b> frames baked so far (' + (cache.frames.length / cache.fps).toFixed(1) + ' s); they play and save like a full bake.'
      : 'Baked <b>' + (cache.frames.length - 1) + '</b> frames in ' + fmtTime(cache.seconds) + '.';
    $('#bake-status').innerHTML += ' ' + bakeLimits(cache);
    applyMode(); lcUi();
  }
  // waterOnly: the water without whitewater (faster); Bake whitewater makes it afterwards
  function startBake(waterOnly) {
    if (S.baking || S.wwPass) return;
    setPlaying(false);
    const desc = buildDesc();
    if (!desc.frames) return;
    if (waterOnly === true) { desc.spr = null; desc.sprayCap = 0; desc.air = null; desc.drip = null; }
    if (isGpu() && gridCost(desc.d, S.cellRatio, desc.maxN).biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27)) { $('#bake-status').textContent = 'That bake does not fit in one GPU buffer here. Pick less detail or lower Max points.'; flash('Bake too big for this GPU.'); return; }
    const cache = { b: { x0: -W / 2, x1: W / 2, y0: 0, y1: Hh, z0: -Dd / 2, z1: Dd / 2 }, org: Object.assign({}, S.org), fps: desc.fps, d: desc.d, frames: [], maxN: 0, ids: desc.objs.map((o) => o.id), seconds: 0, startedAt: Date.now(),
      engine: S.engine, scene: sceneData(), desc: lightDesc(desc), diag: [], stableIds: true, scale: S.scale || 1, spdMs: true };
    S.baking = true; setBakeUI(true); S.bakeT = 0;
    // the bake shows in the viewport as it goes: it becomes the cache straight away and the view follows the newest frame
    cache.partial = true; cache.total = desc.frames; cache.prev = S.cache; S.cache = cache; S.tab = 'bake'; S.ct = 0; S.cfollow = true; setCPlay(true);
    buildTicks(); applyMode(); lcUi();
    $('#bake-prog').style.width = '0%'; $('#bake-status').textContent = 'Starting…';
    const done = (cancelled) => { cache.seconds = (Date.now() - cache.startedAt) / 1000; finishBake(cache, cancelled); };
    if (isGpu()) {
      S.cancelPage = false;
      (S.engine === 'flip' ? runBakeFlipGpu : runBakeGpu)(desc, S.gpu, (fr, info) => onBakeFrame(fr, info, cache), () => S.cancelPage).then((ok) => done(!ok))
        .catch((err) => { (window.__errLog = window.__errLog || []).push({ t: new Date().toISOString(), msg: 'Bake failed: ' + (err && err.stack ? err.stack : err) }); S.baking = false; setBakeUI(false); $('#bake-status').textContent = 'The GPU bake failed: ' + (err && err.message ? err.message : err) + '. Try a larger spacing or a lower Max points.'; });
      return;
    }
    let usedWorker = false;
    try {
      const src = sharedSrc + '\nlet cancelled = false;\nself.onmessage = async (e) => { const m = e.data; if (m.type === "cancel") { cancelled = true; return; }' +
        ' if (m.type === "bake") { cancelled = false; const ok = await runBake(m.desc, (fr, info) => { self.postMessage({ type: "frame", fr, info }, [fr.pos.buffer, fr.spd.buffer, fr.objs.buffer]); }, () => cancelled); self.postMessage({ type: "done", cancelled: !ok }); } };';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url); usedWorker = true;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'frame') onBakeFrame(m.fr, m.info, cache);
        else if (m.type === 'done') done(m.cancelled);
      };
      worker.onerror = () => { worker = null; $('#bake-status').textContent = 'The worker failed. Trying again on the page itself, which will freeze the view while it runs.'; runOnPage(); };
      worker.postMessage({ type: 'bake', desc });
    } catch (err) { usedWorker = false; }
    if (!usedWorker) runOnPage();
    function runOnPage() {
      cache.frames = []; cache.maxN = 0; S.cancelPage = false;
      runBake(desc, (fr, info) => onBakeFrame(fr, info, cache), () => S.cancelPage).then((ok) => done(!ok));
    }
  }
  $('#btn-bake').addEventListener('click', () => startBake(false));
  $('#btn-cancel').addEventListener('click', () => { S.cancelPage = true; if (worker) worker.postMessage({ type: 'cancel' }); });

  function updateCacheInfo() {
    const c = S.cache, el = $('#cache-info');
    if (!c) { el.textContent = 'No cache yet.'; return; }
    if (!c.frames.length) { el.textContent = 'Baking…'; return; }
    const g = gpuKept();
    el.innerHTML = '<b>' + (c.frames.length - 1) + '</b> frames at ' + c.fps + ' fps, up to <b>' + fmtN(c.maxN) + '</b> points, spacing ' + c.d.toFixed(3) + ', <b>' + (cacheBytes(c) / 1048576).toFixed(0) + ' MB</b> in memory, ' + g.n + ' frames on the GPU (' + g.mb.toFixed(0) + ' MB).';
  }
  setInterval(() => { if (S.cache && viewMode() === 'cache') { updateCacheInfo(); lcUi(); } }, 1000);
  addSlider($('#g-cache'), { id: 'c-gpukeep', label: 'GPU memory', min: 256, max: 8192, step: 256, value: S.gpuKeepMB, def: dv('gpuKeepMB'), fmt: (v) => (v >= 1024 ? (v / 1024).toFixed(v % 1024 ? 2 : 0) + ' GB' : v + ' MB'), tip: 'How much GPU memory baked frames may keep. A bake that fits is sent to the GPU once (while it plays the first time, or while it is paused) and then plays smoothly without moving any data. Frames that do not fit are sent again each time they are shown. If the GPU runs out of memory first, fewer frames are kept.', onInput: (v) => { S.gpuKeepMB = v; } });
  // whitewater pass over the shown bake (runWhitewaterPass in flip/bake.js), with the scene's colliders and whitewater settings as they are now
  let wwStop = false;
  async function bakeWhitewater() {
    const c = S.cache, st = $('#ww-status');
    if (!c || c.partial || S.baking || S.wwPass) { flash(c ? 'Wait for the bake to finish.' : 'Bake something first.'); return; }
    if (!S.gpu) { st.textContent = 'This needs WebGPU.'; return; }
    const desc = buildDesc();
    if (!desc.spr) { st.textContent = 'Turn Whitewater on first (Simulation tab).'; return; }
    desc.sprayCap = S.sprCap;
    setPlaying(false); S.wwPass = true; wwStop = false; wwButtons();
    const t0 = performance.now();
    let ok = false;
    try {
      ok = await runWhitewaterPass(c, desc, S.gpu, (f, F) => {
        st.textContent = 'Whitewater: frame ' + f + ' of ' + (F - 1) + '…'; S.wwProg = f / (F - 1); if (f % 4 === 0) lcUi();
        const i = findSlot(slotKey(c, f)); if (i > 0) SLOTS[i].key = null;   // show the new whitewater as it comes
      }, () => wwStop);
      st.textContent = (ok ? 'Whitewater made for ' : 'Stopped: whitewater remade for the first frames of ') + (c.frames.length - 1) + ' frames in ' + fmtTime((performance.now() - t0) / 1000) + (ok ? '. Save the cache to keep it.' : '; the rest keep the old whitewater.');
    } catch (err) { st.textContent = 'The whitewater pass failed: ' + (err && err.message || err); }
    c.uid = ++cacheUid; S.wwPass = false; wwButtons(); updateCacheInfo(); lcUi();
  }
  function wwButtons() {
    const busy = S.baking || S.wwPass;
    for (const id of ['#c-ww', '#tb-bakeww', '#btn-bake', '#btn-bakew', '#tb-bakew']) { const b = $(id); if (b) b.disabled = busy; }
    $('#c-ww-stop').hidden = !S.wwPass;
  }
  $('#c-ww').addEventListener('click', (e) => { e.currentTarget.blur(); bakeWhitewater(); });
  $('#tb-bakeww').addEventListener('click', (e) => { e.currentTarget.blur(); S.tab = 'bake'; applyMode(); setPtab('bake'); bakeWhitewater(); });
  $('#btn-bakew').addEventListener('click', (e) => { e.currentTarget.blur(); startBake(true); });
  $('#tb-bakew').addEventListener('click', (e) => { e.currentTarget.blur(); S.tab = 'bake'; applyMode(); setPtab('bake'); startBake(true); });
  $('#c-ww-stop').addEventListener('click', () => { wwStop = true; });
  $('#c-loop').addEventListener('change', (e) => { S.cloop = e.target.checked; });
  seg('#seg-cspeed', (v) => { S.cspeed = +v; });
  $('#c-clear').addEventListener('click', () => { S.cache = null; for (const i of BAKE.slice(5)) slotFree(SLOTS[i]); BAKE.length = 5; updateCacheInfo(); applyMode(); lcUi(); });
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  }
  $('#c-save').addEventListener('click', (e) => {
    e.currentTarget.blur(); const c = S.cache; if (!c) { flash('Bake something first.'); return; }
    download(new Blob(writeCacheParts(c), { type: 'application/octet-stream' }), 'splashtank-bake.splc');
    flash('Saved splashtank-bake.splc (' + Math.round(cacheBytes(c) / 1048576) + ' MB) to your Downloads folder.');
  });
  // measurements from a stored frame, for bakes that did not record them while running
  function frameStats(fr, c) {
    const b = c.b || DEFB, qx = (b.x1 - b.x0) / 65535, qy = (b.y1 - b.y0) / 65535, qz = (b.z1 - b.z0) / 65535, H = 16, hist = new Array(H).fill(0);
    let alive = 0, sx = 0, sy = 0, sz = 0, ss = 0, smax = 0, fl = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < fr.n; i++) {
      const P = framePoint(fr, b, i); if (P[3] === 255) continue;
      alive++;
      const x = P[0], y = P[1], z = P[2], sp = P[3] / 16 / (c.spdMs ? c.scale || 1 : 1);
      sx += x; sy += y; sz += z; ss += sp; if (sp > smax) smax = sp; fl += P[4] / 15;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      hist[Math.max(0, Math.min(H - 1, Math.floor((y - b.y0) / ((b.y1 - b.y0) / H))))]++;
    }
    const a = Math.max(alive, 1);
    return { n: fr.n, alive, gone: fr.n - alive, meanSpeed: ss / a, maxSpeed: smax, meanFoam: fl / a, center: [sx / a, sy / a, sz / a], bbox: alive ? [x0, y0, z0, x1, y1, z1] : null, heightHist: hist };
  }
  $('#c-report').addEventListener('click', (e) => {
    e.currentTarget.blur(); const c = S.cache; if (!c) { flash('Bake something first.'); return; }
    const rnd = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(rnd) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, q]) => [k, rnd(q)])) : v);
    const per = c.diag && c.diag.length ? c.diag : c.frames.map((fr, f) => Object.assign({ f, t: f / c.fps }, frameStats(fr, c)));
    const names = {}; ((c.scene && c.scene.objs) || []).forEach((o) => { names[o.id] = o.name || o.shape; });
    // a sample of points at about ten frames: x, y, z, speed (m/s, stored up to about 12 m/s), white water 0..1
    const b = c.b || DEFB, qx = (b.x1 - b.x0) / 65535, qy = (b.y1 - b.y0) / 65535, qz = (b.z1 - b.z0) / 65535, F = c.frames.length, picks = new Set();
    for (let k = 0; k < 10; k++) picks.add(Math.round((k / 9) * (F - 1)));
    const snapshots = [...picks].map((f) => {
      const fr = c.frames[f], step = Math.max(1, Math.ceil(fr.n / 3000)), pts = [];
      for (let i = 0; i < fr.n; i += step) { const P = framePoint(fr, b, i); if (P[3] === 255) continue; pts.push([P[0], P[1], P[2], P[3] / 16 * (c.spdMs ? 1 : c.scale || 1), P[4] / 15]); }
      return { f, t: f / c.fps, points: fr.n, every: step, sample: pts };
    });
    const rep = {
      app: 'SplashTank bake report', version: 1, created: new Date().toISOString(), browser: navigator.userAgent, gpu: S.gpu ? { name: S.gpu.name, maxBuffer: S.gpu.maxBuf } : null,
      engine: c.engine || null, bakeSettings: c.desc || null,
      cache: { frames: F - 1, fps: c.fps, spacing: c.d, box: c.b, origin: c.org, maxPoints: c.maxN, seconds: c.seconds, megabytes: Math.round(cacheBytes(c) / 1048576) },
      objects: { ids: c.ids, names }, perFrame: per, objectPoses: { layout: 'per frame, per object: x y z rx yaw rz (solver coordinates)', frames: c.frames.map((fr) => Array.from(fr.objs)) },
      snapshots, errors: (window.__errLog || []).slice(-80), scene: c.scene || null
    };
    download(new Blob([JSON.stringify(rnd(rep))], { type: 'application/json' }), 'splashtank-bake-report.json');
    flash('Saved splashtank-bake-report.json to your Downloads folder. Attach it in the chat.');
  });

  function buildTicks() {
    const c = S.cache, F = Math.max(1, c.partial ? c.total : c.frames.length - 1), tk = $('#ticks'); tk.innerHTML = '';   // while baking, the bar covers the whole bake
    const sc = $('#scrub'); sc.max = F; sc.value = 0;
    $('#c-total').textContent = String(F + 1).padStart(4, '0');
    for (let k = 0; k <= F; k += c.fps) {
      const s = document.createElement('span'); s.style.left = (k / F) * 100 + '%'; s.textContent = k / c.fps + 's'; tk.appendChild(s);
    }
  }
  $('#scrub').addEventListener('input', (e) => { S.ct = +e.target.value; if (S.cache && S.cache.partial) S.cfollow = S.ct >= S.cache.frames.length - 1.5; });

  const DEFB = { x0: -1.5, x1: 1.5, y0: 0, y1: 2.6, z0: -1.5, z1: 1.5 };
  // Baked frames live in the BAKE slots: the frame at the playhead, the next one (to blend towards) and, while playing, up to two after
  // that, loaded ahead one per display frame that had nothing else to load, so crossing into a new frame never has to load at that moment.
  // Uploading is what limits dense playback (16 MB a frame took about 100 ms on Mer's UHD 730), so there are as many slots as the GPU memory
  // budget holds: a bake that fits is uploaded once (while playing, or while paused and idle) and then plays without moving any data.
  // perf.late counts frames that were needed before they were loaded ahead (what makes playback hitch).
  let useTick = 0, gpuCap = Infinity;   // gpuCap: slots that fit after the GPU ran out of memory
  function slotKey(c, k) { return c.uid + ':' + k + ':' + (S.showSpray !== false); }
  function findSlot(key) { for (const i of BAKE) if (SLOTS[i].key === key) { SLOTS[i].used = ++useTick; return i; } return -1; }
  // as many bake slots as the budget holds for this cache's biggest frame (at least five, at most one per frame)
  function bakeSlots(c) {
    let per = c.maxN * (c.q ? 6 : 8) + 65536; for (const i of BAKE) if (SLOTS[i].key && SLOTS[i].key.startsWith(c.uid + ':')) per = Math.max(per, slotBytes(SLOTS[i]));
    // while baking the view only follows the newest frame: five slots; finished, the frames are loaded at their exact size
    const want = c.partial ? 5 : Math.max(5, Math.min(c.frames.length, gpuCap, Math.floor((S.gpuKeepMB || 2048) * 1048576 / per)));
    while (BAKE.length < want) { SLOTS.push(newSlot()); BAKE.push(SLOTS.length - 1); }
    while (BAKE.length > want) {   // budget lowered: free the least recently used
      let v = 0; for (let j = 1; j < BAKE.length; j++) if (SLOTS[BAKE[j]].used < SLOTS[BAKE[v]].used) v = j;
      slotFree(SLOTS[BAKE[v]]); BAKE.splice(v, 1);
    }
  }
  function gpuKept() { let n = 0, b = 0; for (const i of BAKE) { if (SLOTS[i].key) n++; b += slotBytes(SLOTS[i]); } return { n, mb: b / 1048576 }; }
  function slotFor(c, k, keep, ahead) {
    const key = slotKey(c, k); let i = findSlot(key); if (i > 0) return i;
    if (!ahead && S.cplay) perf.late = (perf.late || 0) + 1;
    for (;;) {
      let v = -1; for (const j of BAKE) if (!keep.includes(j) && (v < 0 || SLOTS[j].used < SLOTS[v].used)) v = j;
      if (slotLoad(SLOTS[v], c.frames[k], c.b || DEFB, !c.partial && BAKE.length >= c.frames.length)) { SLOTS[v].key = key; SLOTS[v].used = ++useTick; loadedNow = true; return v; }
      // out of GPU memory: drop this slot, keep the budget to what fitted and use one that already has its textures
      slotFree(SLOTS[v]); BAKE.splice(BAKE.indexOf(v), 1); gpuCap = BAKE.length;
      if (!S.gpuWarned) { S.gpuWarned = true; flash('The GPU is out of memory: keeping ' + BAKE.length + ' frames on it.'); }
      if (BAKE.length <= keep.length) return keep[0] || BAKE[0];
    }
  }
  // paused and idle: fill free slots with the frames after the playhead, one per display frame, so playing starts from the GPU
  function idleFill(c, a, last) {
    if (S.cplay || loadedNow || benching || performance.now() - lastInput < 1000) return;
    const free = BAKE.find((j) => !SLOTS[j].key); if (free === undefined) return;
    for (let j = 1; j <= last; j++) { const nx = (a + j) % (last + 1); if (findSlot(slotKey(c, nx)) < 0) { slotFor(c, nx, [], true); return; } }
  }
  let cacheUid = 0, loadedNow = false;
  function showCache(t) {
    const c = S.cache, fr = c.frames, last = fr.length - 1; lastGen = -1;
    if (!c.uid) c.uid = ++cacheUid;
    if (last < 0) { hideSlots(); return 0; }   // a bake that has not finished its first frame yet
    t = clamp(t, 0, last); loadedNow = false; bakeSlots(c);
    // blend between frames only when the same slot is the same particle in both (older caches with sorting were not saved that way)
    const a = Math.floor(t), bi = Math.min(a + 1, last), w = c.stableIds && bi !== a ? t - a : 0, A = fr[a], B = fr[bi], og = c.org || { x: 0, y: 0, z: 0 };
    // when playback falls behind and neither frame is loaded, show the one at the playhead without blending rather than load two at once
    const behind = S.cplay && w > 0 && findSlot(slotKey(c, a)) < 0 && findSlot(slotKey(c, bi)) < 0;
    const sa = slotFor(c, a, []), sb = w > 0 && !behind ? slotFor(c, bi, [sa]) : sa;
    if (!loadedNow && S.cplay && last > 1) {   // nothing loaded this time: load the first of the next two frames that is not loaded yet
      const keep = [sa, sb];
      for (let j = 1; j <= 2; j++) {
        let nx = bi + j; if (nx > last) nx = S.cloop && !c.partial ? nx - last - 1 : -1;
        if (nx < 0) break;
        const have = findSlot(slotKey(c, nx));
        if (have < 0) { slotFor(c, nx, keep, true); break; }
        keep.push(have);
      }
    }
    if (!c.partial) idleFill(c, a, last);
    pmat.uniforms.uD.value = c.d; pmat.uniforms.uCR.value = (c.desc && c.desc.cellRatio) || 2; matW.uniforms.uFdt.value = 1 / c.fps;
    showSlots(sa, sb, sb === sa ? 0 : w);
    c.ids.forEach((id, k) => {
      const o = objs.find((q) => q.id === id); if (!o) return;
      const k4 = k * 6, ao = A.objs, bo = B.objs, L = (j) => ao[k4 + j] + (bo[k4 + j] - ao[k4 + j]) * w;
      o.group.position.set(L(0) + og.x, L(1) + og.y, L(2) + og.z);
      if (o.kind === 'mesh') o.group.rotation.set(L(3), L(4), L(5), 'ZYX');
    });
    return w < 0.5 ? SLOTS[sa].alive : SLOTS[sb].alive;
  }

  // ---------- load a cache file ----------
  $('#cache-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const st = $('#load-status'); st.classList.remove('warn'); st.textContent = 'Reading ' + file.name + '…';
    try {
      const buf = await file.arrayBuffer();
      const c = parseCache(buf);
      if (c.frames.length < 2) throw new Error('The file has no frames.');
      if (c.scene && (c.ids || []).some((id) => !objs.find((o) => o.id === id))) { try { applySceneData(c.scene); } catch (e2) { /* keep the current scene */ } }
      S.cache = c; S.ct = 0; setCPlay(true); buildTicks(); updateCacheInfo(); S.tab = 'bake'; applyMode(); lcUi();
      st.textContent = 'Loaded ' + file.name + '.';
    } catch (err) { st.classList.add('warn'); st.textContent = 'Could not load the file: ' + err.message; }
    e.target.value = '';
  });

