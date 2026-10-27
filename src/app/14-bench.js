  // ---------- benchmark ----------
  let benching = false;
  const bout = $('#bench-out');
  async function runBenchmark() {
    if (benching || S.baking) return;
    if (S.engine !== 'flip') { bout.value = 'The benchmark times the FLIP solver. Pick FLIP in the Live solver panel first.'; return; }
    benching = true; const wasPlaying = S.playing, endMode = S.tl.end, opt0 = Object.assign({}, sim.opt), sub0 = [S.subMin, S.subMax];
    // the moment measured: the playhead, so the timeline can be put just before the action (a meteor's impact); at the start, 2.5 s in
    const atHead = S.tl.t > 0.05, W = atHead ? Math.round(S.tl.t * 60) : (window.__benchW || 150);
    S.subMin = 1; S.subMax = 1;   // one solver step per measured step
    setPlaying(false); S.tl.end = 'hold';
    const lines = [], say = (t) => { lines.push(t); bout.value = lines.join('\n'); bout.scrollTop = bout.scrollHeight; };
    const settle = () => sim.dev.queue.onSubmittedWorkDone();
    try {
      // every run starts again from the start and simulates up to the measured moment, so each variant times the same part of the scene
      const warmTo = async () => { resetSim(0); for (let i = 0; i < W; i++) { stepOnce(); if (i % 10 === 9) await settle(); } await settle(); };
      say('Simulating up to ' + (W / 60).toFixed(2) + ' s, the moment to measure' + (atHead ? ' (the playhead)' : '') + '...');
      await sim.whenReady; await warmTo();
      const N = sim.N, M = window.__benchM || 24, ST = ['sort', 'blocks', 'clear', 'p2g', 'narrow band', 'classify', 'normFaces', 'divergence', 'pressure', 'project', 'g2p', 'ballistic', 'air', 'ww sample', 'ww move', 'ww emit', 'reseed'];
      const f1 = (v) => v.toFixed(2), mb = (v) => Math.round(v / 1048576);
      const BASE = { noFoam: false, noCull: false, noSolidCache: false, fastAir: false, sort: true, sortAuto: true, subgroups: true, ballistic: S.ballistic !== false, settle: S.settle !== false, sortEvery: 16, iters: 0 };
      let lastSum = null;
      const measure = async (label, opt, quiet) => {
        Object.assign(sim.opt, BASE); await warmTo();
        const { noDraw: nd, ...so } = opt; Object.assign(sim.opt, BASE, so); noDraw = !!nd;
        const sum = {}; lastSum = sum; let cpu = 0, tot = 0, onGpu = false;
        for (let r = 0; r < M; r++) {
          let cap = null; sim.step = (dt, o) => { cap = { dt, o }; };
          const t0 = performance.now(); stepOnce(); cpu += performance.now() - t0; delete sim.step;
          const t = await sim.stepTimed(cap.dt, cap.o); onGpu = !!t.gpu; for (const k in t) if (k !== 'gpu') sum[k] = (sum[k] || 0) + t[k];
        }
        sim.gpuSteps = []; sim.gpuMs = 0;   // GPU busy time of the timed steps only, not the run up to the moment
        for (let r = 0; r < M; r++) { const t0 = performance.now(); stepOnce(); await settle(); tot += performance.now() - t0; }
        noDraw = false;
        if (quiet) return tot / M;
        let s = 0; const parts = ST.filter((k) => sum[k] !== undefined).map((k) => { const v = (sum[k] || 0) / M; s += v; return k + ' ' + f1(v); });
        say('');
        say(label);
        say('  whole step ' + f1(tot / M) + ' ms from start until the browser reports it done (about ' + Math.round(1000 / (tot / M)) + ' steps/s), JS side ' + f1(cpu / M) + ' ms' + (sim.gpuMs ? ', GPU busy ' + f1(sim.gpuMs) + ' ms of it' : ''));
        say('  stages' + (onGpu ? ', timed on the GPU itself: ' : ', each timed alone: ') + parts.join(', ') + '  (sum ' + f1(s) + ')');
        return tot / M;
      };
      await settle();
      const active = await sim.activeCells();
      const denseF = (sim.nx + 1) * sim.ny * sim.nz + sim.nx * (sim.ny + 1) * sim.nz + sim.nx * sim.ny * (sim.nz + 1);
      say('SplashTank benchmark');
      say('GPU: ' + (S.gpu && S.gpu.name) + '   Browser: ' + navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 90));
      say('Measured from ' + (W / 60).toFixed(2) + ' s to ' + ((W + 2 * M) / 60).toFixed(2) + ' s of the scene' + (atHead || W !== 150 ? '' : ' (put the playhead just before the moment you want measured, then run it again)') + '; every run below starts again from the beginning, so they all time the same moment.');
      say('FLIP, ' + N + ' particles, spacing ' + sim.d.toFixed(3) + ', grid cell ' + sim.ratio.toFixed(1) + '× spacing');
      say('Box ' + sim.nx + ' × ' + sim.ny + ' × ' + sim.nz + ' = ' + sim.ncell + ' cells, ' + active + ' hold water (' + (100 * active / sim.ncell).toFixed(1) + '%)');
      { const gridMB = sim.scap * (512 * 40 + 12) / 1048576; say('Sparse grid: ' + sim.blocksUsed + ' blocks of 8×8×8 in use (' + (100 * sim.blocksUsed * 512 / sim.ncell).toFixed(1) + '% of the box), room for ' + sim.scap + ' = ' + gridMB.toFixed(gridMB < 10 ? 1 : 0) + ' MB. As a full grid it would be ' + mb(denseF * 8 + sim.ncell * 24) + ' MB. Everything on the GPU: about ' + mb(sim.memBytes()) + ' MB'); }
      say('Pressure iterations ' + S.iters + ', wind ' + S.wind.speed + ', air drag ' + S.airDrag + ', air turbulence ' + S.gust + ', look-only points ×' + (S.detail + 1) + '. Subgroups: ' + (sim.sg ? 'yes (lists built a subgroup at a time)' : 'not offered by this GPU or browser'));
      await measure('', {}, true);   // warm-up, lets the GPU clock up before anything is timed
      say(sim.tsq ? '(stage times and GPU busy times come from GPU timestamps, so they leave out the wait for the browser to report back)' : '(this GPU or browser gives no timestamps: stage times each include a fixed cost for submitting and waiting on one stage alone)');
      // The GPU can slow down during a long test, so every variant is measured right after a short rest, between two reference runs, and compared with their average.
      const rest = (ms) => new Promise((r) => setTimeout(r, ms));
      const trio = async (label, opt) => {
        // a short pause only: after a 6 s one the first reference run was slow every time on Mer's NVIDIA card (65-115 ms against 10-65)
        await settle(); await rest(window.__benchRest === undefined ? 1000 : window.__benchRest);
        const r1 = await measure('', {}, true);
        const v = await measure(label, opt);
        const r2 = await measure('', {}, true);
        // one reference run now and then is disturbed (seen at 49 and 70 ms against 10): then the lower one is the fair comparison
        const odd = Math.max(r1, r2) > 1.3 * Math.min(r1, r2), ref = odd ? Math.min(r1, r2) : (r1 + r2) / 2, pc = (v / ref - 1) * 100;
        say('  reference before ' + f1(r1) + ' ms and after ' + f1(r2) + ' ms, so this is ' + (pc <= 0 ? Math.abs(pc).toFixed(0) + '% faster' : pc.toFixed(0) + '% slower') + ' than ' + (odd ? 'the lower one (the other was disturbed)' : 'their average'));
        return { ref, v, pc };
      };
      await measure('A. reference: everything on (particles sorted in z-order when they have moved about two cells)', {});
      if (sim.stats && sim.stats.fluid) say('  settled water (left out of the pressure solve, keeps its pressure): ' + Math.round(100 * (sim.stats.settled || 0) / sim.stats.fluid) + '% of the ' + fmtN(sim.stats.fluid) + ' water cells');
      await trio('S. particles not sorted', { sort: false });
      if (sim.sg) await trio('U. lists built one item at a time instead of by subgroups', { subgroups: false });
      await trio('F. particles sorted every 16th step whether they moved or not', { sortAuto: false });
      await trio('G. grouped transfer ' + (S.p2gWin ? 'off' : 'on') + ' (p2g and g2p through workgroup memory; Speed-ups)', { p2gWin: !S.p2gWin });
      await trio('Z. settled water ' + (S.settle !== false ? 'relaxed like the rest (not left out of the pressure solve)' : 'left out of the pressure solve'), { settle: S.settle === false });
      const pi = S.iters > 20 ? 20 : 40;
      await trio('P. ' + pi + ' pressure iterations instead of ' + S.iters, { iters: pi });
      await trio('C. all whitewater (spray, mist, foam, bubbles, air field), white water and air drag skipped (for comparison)', { noFoam: true });
      await trio('D. viewport not drawn (is drawing the points taking GPU time from the solver?)', { noDraw: true });
      say('');
      say('Blocks: at most ' + (sim.peak || sim.blocksUsed) + ' in use during the test, room for ' + sim.scap + (sim.grew ? ', the pool grew ' + sim.grew + ' times' : ''));
      Object.assign(sim.opt, opt0);
      // moving particles to the CPU for drawing
      const tmp = new Float32Array(sim.MAXN * 4 + 4); await sim.readbackInto(tmp);
      let rb = 0; for (let r = 0; r < 6; r++) { const t0 = performance.now(); await sim.readbackInto(tmp); rb += performance.now() - t0; }
      say('');
      say('Copying all particles to the CPU: ' + f1(rb / 6) + ' ms each (bakes do this every frame; the live view copies a packed sample in the background)');
      if (sim.outFrame) { const fr = sim.outFrame; let t = 0; for (let r = 0; r < 5; r++) { const t0 = performance.now(); slotLoad(SLOTS[0], fr, sim.b); t += performance.now() - t0; } say('Handing the live view to the drawing: ' + f1(t / 5) + ' ms for ' + fmtN(fr.n + (fr.sp ? fr.sp.n : 0) + (fr.dp ? fr.dp.n : 0)) + ' points (' + (perf.upBytes / 1048576).toFixed(1) + ' MB)'); SLOTS[0].key = null; }
      say('');
      say('Done. Press Copy results and paste it back.');
    } catch (e) { say('Benchmark failed: ' + (e && e.message || e)); }
    noDraw = false; delete sim.step; Object.assign(sim.opt, opt0); S.tl.end = endMode; S.subMin = sub0[0]; S.subMax = sub0[1]; resetSim(0); renderUI(); renderKF(); setPlaying(wasPlaying); benching = false;
  }
  $('#btn-bench').addEventListener('click', (e) => { e.currentTarget.blur(); runBenchmark(); });
  // ---------- smoothness test: what Mer feels (hitches, slow playback), measured frame by frame on her computer ----------
  let frameHook = null, noDraw = false;   // noDraw: the benchmark's run without drawing the viewport
  async function runSmooth() {
    if (benching || S.baking || tf) return;
    benching = true;
    const lines = [], say = (t) => { lines.push(t); bout.value = lines.join('\n'); bout.scrollTop = bout.scrollHeight; };
    const f1 = (v) => (v || 0).toFixed(1), f0 = (v) => String(Math.round(v || 0)), avg = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
    const pctl = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
    const record = (secs) => new Promise((res) => {
      const rec = { gaps: [], js: [], up: [], upMB: [], render: [], unpack: [], t0: performance.now(), frame0: S.frame, ct0: S.ct, wrapped: 0 };
      let upN = perf.upN, prev = performance.now(), lastCt = S.ct, lastG = sim ? sim.gen : 0; rec.late0 = perf.late || 0;
      frameHook = (now) => {
        rec.gaps.push(now - prev); prev = now; rec.js.push(perf.frame); rec.render.push(perf.render);
        if (perf.upN !== upN) { upN = perf.upN; rec.up.push(perf.up); rec.upMB.push(perf.upBytes / 1048576); }
        if (sim && sim.gen !== lastG && viewMode() === 'live') { lastG = sim.gen; if (sim.unpackMs) rec.unpack.push(sim.unpackMs); }
        if (S.ct < lastCt) rec.wrapped++; lastCt = S.ct;
        if (now - rec.t0 > secs * 1000) { frameHook = null; rec.secs = (now - rec.t0) / 1000; rec.late = (perf.late || 0) - rec.late0; res(rec); }
      };
    });
    const report = (rec) => {
      const g = rec.gaps, slow = g.slice().sort((x, y) => y - x).slice(0, 5).map(f0).join(', ');
      say('  ' + f1(g.length / rec.secs) + ' frames a second drawn' + (rec.live ? ' (the live view is only redrawn when something changed, so these are the times between new pictures)' : '') + '. Typical frame ' + f0(pctl(g, 0.5)) + ' ms, 1 in 20 slower than ' + f0(pctl(g, 0.95)) + ' ms, slowest ' + slow + ' ms. Frames over 50 ms: ' + g.filter((v) => v > 50).length + ', over 100 ms: ' + g.filter((v) => v > 100).length + '.');
      say('  Page work per frame ' + f1(avg(rec.js)) + ' ms on average (' + f1(pctl(rec.js, 0.95)) + ' ms for 1 in 20), of which handing it to the drawing ' + f1(avg(rec.render)) + ' ms.');
      if (rec.up.length) say('  New points sent to the drawing ' + rec.up.length + ' times, ' + f1(avg(rec.up)) + ' ms each (slowest ' + f1(Math.max(...rec.up)) + ' ms), about ' + f1(avg(rec.upMB)) + ' MB each.');
      if (rec.unpack.length) say('  Copying the GPU\'s points for the view: ' + f1(avg(rec.unpack)) + ' ms each.');
    };
    const wasTab = S.tab, wasPlaying = S.playing, wasC = S.cplay, wasCt = S.ct;
    try {
      const cv = renderer.domElement;
      say('SplashTank smoothness test');
      say('GPU: ' + (S.gpu && S.gpu.name) + '. Browser: ' + navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 90));
      say('Scene: ' + $('#scene').value + ', ' + S.engine.toUpperCase() + ', spacing ' + S.liveD.toFixed(3) + ', max points ' + fmtN(S.cap) + ', whitewater ' + (S.sprOn ? 'on (pool ' + fmtN(S.sprCap) + ')' : 'off') + ', narrow band ' + (nbActive() ? 'on' : 'off') + '. View ' + cv.width + ' × ' + cv.height + ' pixels, look-only copies ' + (1 + (S.detail | 0)) + ' water, ' + (1 + (S.sprDetail | 0)) + ' whitewater' + (S.liteRun ? ' (1 and at most 2 while the sim runs: Lighter while running is on)' : '') + '.');
      // 1. the live sim from the start
      S.tab = 'live'; applyMode(); setCPlay(false); setPlaying(false); lcClear(); resetSim(0);
      if (sim.whenReady) {
        const sh = S.engine === 'flip' ? flipPipes(sim.dev) : null, t0 = performance.now();
        await sim.whenReady;
        if (sh) say('GPU solver prepared (' + Object.keys(FLIP_L).length + ' shaders compiled at once, shared by every scene) in ' + f1(sh.ms / 1000) + ' s' + (performance.now() - t0 > 50 ? ', ' + f1((performance.now() - t0) / 1000) + ' s of it during this test' : ' when the page started') + '.');
      }
      await new Promise((r) => setTimeout(r, 400));
      if (sim.stepMs) sim.stepMs.length = 0; sim.slowMs = 0; sim.maxQ = 0; sim.idleMs = 0; sim.idleFrom = 0; sim.nSent = 0; S.subMost = 0; const tq0 = performance.now();
      // the timeline's end must not stop or loop the sim while it is timed (Meteor lake ends at 6 s: it read as 60% of real time)
      const tl0 = { dur: S.tl.dur, end: S.tl.end }; S.tl.dur = 1e6; S.tl.end = 'hold';
      setPlaying(true);
      say(''); say('Live sim, ' + (window.__smoothSecs || 10) + ' seconds from the start:');
      const L = await record(window.__smoothSecs || 10); L.live = true;
      const tq = performance.now() - tq0, idle = (sim.idleMs || 0) + (sim.idleFrom ? performance.now() - sim.idleFrom : 0), nSent = sim.nSent || 0;
      setPlaying(false); S.tl.dur = tl0.dur; S.tl.end = tl0.end;
      const simS = (S.frame - L.frame0) / 60;
      say('  The sim got through ' + f1(simS) + ' s of its time (' + Math.round(100 * simS / L.secs) + '% of real time). ' + fmtN(sim.N) + ' particles now, solver step about ' + f1(sim.lastMs) + ' ms from start until the browser reports it done (mean of the last 31, slowest ' + f0(sim.slowMs) + ' ms)' + (sim.gpuMs ? ', of which the GPU was busy ' + f1(sim.gpuMs) + ' ms' : '') + (sim.maxQ ? ', up to ' + sim.maxQ + ' steps queued' : '') + ', ' + fmtN(shownN) + ' points drawn.');
      if (sim.track) say('  ' + nSent + ' solver steps sent (' + f1(nSent / Math.max(1, S.frame - L.frame0)) + ' substeps a frame on average, at most ' + (S.subMost || 1) + '), ' + f1(nSent / (tq / 1000)) + ' a second; nothing queued for ' + Math.round(100 * idle / tq) + '% of the time' + (sim.latMs ? ', and a step sent to an empty queue was reported done after ' + f1(sim.latMs) + ' ms' : '') + '.');
      report(L);
      { const t0 = performance.now(); if (sim.dev) await sim.dev.queue.onSubmittedWorkDone(); const w = performance.now() - t0;
        if (w > 100) say('  After Stop the GPU was still busy for ' + f1(w / 1000) + ' s with steps that were queued.'); }
      // 2. the bake, if there is one (after the live sim's queued steps are done, so they do not slow the playback down)
      if (S.cache && S.cache.frames.length > 2) {
        const c = S.cache;
        S.tab = 'bake'; applyMode(); S.ct = 0; S.cfollow = false; setCPlay(true);
        await new Promise((r) => setTimeout(r, 400));
        say(''); say('Bake playback, ' + (window.__smoothSecs || 10) + ' seconds (' + (c.frames.length - 1) + ' frames at ' + c.fps + ' a second, up to ' + fmtN(c.maxN) + ' water points):');
        const P = await record(window.__smoothSecs || 10);
        report(P);
        say('  Frames needed before they had been loaded ahead: ' + P.late + (P.late ? ' (each of those loads during the frame that shows it)' : '') + '. The playback went round ' + (P.wrapped + 1) + ' times.');
        { const g = gpuKept(); say('  Frames kept on the GPU: ' + g.n + ' of ' + c.frames.length + ' (' + f0(g.mb) + ' MB, budget ' + S.gpuKeepMB + ' MB' + (perf.oom ? ', the GPU ran out of memory' : '') + ').'); }
        // the same bake paused: drawing alone, nothing uploaded
        setCPlay(false); S.ct = Math.floor(c.frames.length / 2) + 0.5; await new Promise((r) => setTimeout(r, 400));
        const Q = await record(3);
        say('  Drawing alone (paused between two frames, nothing sent): ' + f1(Q.gaps.length / Q.secs) + ' frames a second, typical ' + f0(pctl(Q.gaps, 0.5)) + ' ms.');
      } else { say(''); say('No bake to play (bake something first to test playback).'); }
      // 3. collision shapes
      const ms = objs.filter((o) => o.kind === 'mesh');
      if (ms.length) {
        say(''); say('Rebuilding collision shapes (done after scaling or reshaping; it now runs in the background, so this is how long the water waits for the new shape):');
        const parts = [];
        for (const o of ms.slice(0, 8)) { const t0 = performance.now(); const sd = buildSDF(o.mesh, 0.025, 0.16); parts.push(o.name + ' ' + f0(performance.now() - t0) + ' ms (' + sd.dims.join('×') + ')'); await new Promise((r) => setTimeout(r, 0)); }
        say('  ' + parts.join(', ') + (ms.length > 8 ? ', and ' + (ms.length - 8) + ' more' : '') + '.');
      }
      say(''); say('Done. Press Copy results and paste it into the chat.');
    } catch (e) { say('The test failed: ' + (e && e.message || e)); }
    frameHook = null;
    S.tab = wasTab; applyMode(); S.ct = wasCt; setCPlay(wasC && viewMode() === 'cache'); setPlaying(false); if (wasPlaying) setPlaying(true); renderUI(); renderKF();
    benching = false;
  }
  $('#btn-smooth').addEventListener('click', (e) => { e.currentTarget.blur(); runSmooth(); });
  $('#btn-bench-copy').addEventListener('click', (e) => {
    e.currentTarget.blur(); bout.select();
    try { navigator.clipboard.writeText(bout.value).catch(() => document.execCommand('copy')); } catch (er) { try { document.execCommand('copy'); } catch (e2) { /* ignore */ } }
  });

  // box face arrows
  let fdrag = null, hoverF = null;
  function pickHandle(cx, cy) {
    if (!handleGrp.visible) return null;
    handleGrp.updateMatrixWorld(true); setNdc(cx, cy); const hits = ray.intersectObjects(handleMeshes, false);
    return hits.length ? hits[0].object.userData.face : null;
  }
  function hoverHandle(e) {
    if (tf || viewMode() === 'cache') return;
    const f = pickHandle(e.clientX, e.clientY);
    if (f !== hoverF) { if (hoverF) hoverF.mat.color.setHex(hoverF.col); hoverF = f; if (f) f.mat.color.setHex(ACCENT); canvas.style.cursor = f ? 'grab' : 'default'; }
  }
  function startFaceDrag(f, e) {
    const axis = f.dir.clone(), P = new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2); P[f.ax] = b[f.k];
    const t0 = lineParam(P, axis, rayAtClient(e.clientX, e.clientY));
    fdrag = { f, axis, P, t0: t0 === null ? 0 : t0, orig: b[f.k], changed: false }; f.mat.color.setHex(ACCENT); canvas.style.cursor = 'grabbing';
  }
  function moveFaceDrag(e) {
    const d = fdrag; if (!d) return;
    const t = lineParam(d.P, d.axis, rayAtClient(e.clientX, e.clientY)); if (t === null) return;
    let v = d.orig + (t - d.t0) * d.f.sgn; v = Math.round(v / (e.ctrlKey ? 0.5 : 0.05)) * (e.ctrlKey ? 0.5 : 0.05);
    if (Math.abs(v - b[d.f.k]) < 1e-6) return;
    setFaceCoord(d.f.k, v); d.changed = true;
    const inp = document.getElementById('face-' + d.f.k); if (inp) inp.value = +b[d.f.k].toFixed(3);
    const sz = document.getElementById('box-size'); if (sz) sz.innerHTML = 'size <b>' + S.dom.w.toFixed(2) + '</b> × <b>' + S.dom.h.toFixed(2) + '</b> × <b>' + S.dom.d.toFixed(2) + '</b> m. Changing the box restarts the particles.';
  }
  function endFaceDrag() {
    const d = fdrag; fdrag = null; if (!d) return;
    d.f.mat.color.setHex(d.f.col); canvas.style.cursor = 'default';
    if (d.changed) commitBox();
  }
  function orbit(dx, dy) { if (S.ortho) setOrtho(false); cam.theta -= dx * 0.007; cam.phi = clamp(cam.phi - dy * 0.007, 0.02, Math.PI - 0.02); updateCam(); }
  function pan(dx, dy) {
    camera.updateMatrixWorld(); const m = camera.matrixWorld.elements, k = cam.r * 0.0012;
    cam.target.x += (-m[0] * dx + m[4] * dy) * k; cam.target.y += (-m[1] * dx + m[5] * dy) * k; cam.target.z += (-m[2] * dx + m[6] * dy) * k; updateCam();
  }
  function trackMouse(e) { lastM.x = e.clientX; lastM.y = e.clientY; lastM.ctrl = e.ctrlKey || e.metaKey; }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    trackMouse(e);
    if (!addMenu.hidden) closeAddMenu();
    if (e.button === 1) e.preventDefault();
    if (tf) { e.preventDefault(); if (e.button === 0) confirmTf(); else if (e.button === 2) cancelTf(); else if (e.button === 1) midAxis(); return; }
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { press = null; const [a, c] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - c.x, a.y - c.y); r0 = cam.r; mid0 = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }; camGoal = null; return; }
    if (ptrs.size > 2) return;
    const cache = viewMode() === 'cache', touch = e.pointerType === 'touch';
    press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, mode: 'click', shift: e.shiftKey, hit: null };
    if (e.button === 1 || (e.button === 0 && e.altKey) || e.button === 2 || cache) { press.mode = e.shiftKey && (e.button === 1 || e.button === 2 || e.altKey) ? 'pan' : (e.ctrlKey && (e.button === 1 || e.altKey) ? 'zoom' : 'orbit'); camGoal = null; return; }
    if (e.button !== 0) return;
    { const gp = pickGizmo(e.clientX, e.clientY); if (gp) { press = null; startTf(gp.type, { axis: gp.axis, fromDrag: true }); if (tf) { tf.m0 = { x: e.clientX, y: e.clientY }; const pv = toScreen(tf.pivot); tf.prevA = Math.atan2(e.clientY - pv.y, e.clientX - pv.x); evalTf(); } return; } }
    if (uiMode === 'object' && S.handles) { const fh = pickHandle(e.clientX, e.clientY); if (fh) { startFaceDrag(fh, e); press.mode = 'face'; return; } }
    if (uiMode === 'edit') { const h = editPick(e.clientX, e.clientY); press.hit = h; press.hitSel = editIsSelected(h); }
    else { const o = pickObject(e.clientX, e.clientY); press.hit = o; press.hitSel = !!o && selSet.has(o); if (touch && !o) press.mode = 'orbit'; }
  });
  canvas.addEventListener('pointermove', (e) => {
    trackMouse(e);
    if (tf) { evalTf(); return; }
    const p = ptrs.get(e.pointerId);
    if (!p) { const gp = pickGizmo(e.clientX, e.clientY); hoverGizmo(gp); if (gp) { canvas.style.cursor = 'pointer'; return; } hoverHandle(e); return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) {
      const [a, c] = [...ptrs.values()]; const dist = Math.hypot(a.x - c.x, a.y - c.y);
      if (pinch0 > 0) { cam.r = clamp(r0 * pinch0 / dist, 1.2, 40); updateCam(); }
      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2; if (mid0) pan(mx - mid0.x, my - mid0.y); mid0 = { x: mx, y: my };
      return;
    }
    if (!press || press.id !== e.pointerId) return;
    const far = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
    if (press.mode === 'orbit') { orbit(dx, dy); return; }
    if (press.mode === 'pan') { pan(dx, dy); return; }
    if (press.mode === 'face') { moveFaceDrag(e); return; }
    if (press.mode === 'zoom') { cam.r = clamp(cam.r * Math.exp(dy * 0.01), 1.2, 40); updateCam(); return; }
    if (press.mode === 'click' && far > 4) { press.moved = true; press.mode = 'box'; }   // dragging never moves things: it draws a selection box (move with G or the gizmo)
    if (press.mode === 'box') {
      const r = stage.getBoundingClientRect(), x0 = Math.min(press.x0, e.clientX), x1 = Math.max(press.x0, e.clientX), y0 = Math.min(press.y0, e.clientY), y1 = Math.max(press.y0, e.clientY);
      boxEl.hidden = false; boxEl.style.left = x0 - r.left + 'px'; boxEl.style.top = y0 - r.top + 'px'; boxEl.style.width = x1 - x0 + 'px'; boxEl.style.height = y1 - y0 + 'px';
      press.rect = { x0, x1, y0, y1 };
    }
  });
  function endPtr(e) {
    trackMouse(e);
    ptrs.delete(e.pointerId);
    if (tf && tf.fromDrag) { confirmTf(); }
    else if (press && press.id === e.pointerId) {
      const pr = press; press = null;
      if (pr.mode === 'face') { endFaceDrag(); boxEl.hidden = true; return; }
      if (pr.mode === 'box' && pr.rect) {
        if (uiMode === 'edit') editBox(pr.rect, pr.shift);
        else {
          if (!pr.shift) { selSet.clear(); selected = null; }
          objs.forEach((o) => { const s = toScreen(o.pos); if (s.x >= pr.rect.x0 && s.x <= pr.rect.x1 && s.y >= pr.rect.y0 && s.y <= pr.rect.y1) { selSet.add(o); selected = o; } });
          objs.forEach(syncMesh); renderUI(); hud();
        }
      } else if (pr.mode === 'click' && !pr.moved) {
        if (uiMode === 'edit') editClick(e.clientX, e.clientY, pr.shift);
        else if (pr.hit) select(pr.hit, pr.shift);
        else if (!pr.shift) select(null);
      }
    }
    boxEl.hidden = true;
    if (ptrs.size === 0 && !tf) { press = null; canvas.style.cursor = 'default'; }
  }
  canvas.addEventListener('pointerup', endPtr); canvas.addEventListener('pointercancel', endPtr);
  window.addEventListener('pointermove', (e) => { if (tf && e.target !== canvas) { trackMouse(e); evalTf(); } });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); camGoal = null; cam.r = clamp(cam.r * Math.exp(e.deltaY * 0.001), 1.2, 40); updateCam(); }, { passive: false });

