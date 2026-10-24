  // ---------- live loop ----------
  // positions and angles part way between two sets of object states
  function lerpStates(a, b, w) {
    return b.map((o, i) => {
      const p = a[i]; if (!p || p.id !== o.id) return o;
      const L = (k) => (p[k] || 0) + ((o[k] || 0) - (p[k] || 0)) * w;
      return Object.assign({}, o, { x: L('x'), y: L('y'), z: L('z'), rx: L('rx'), yaw: L('yaw'), rz: L('rz') });
    });
  }
  function stepOnce() {
    if (sim.ready === false) return;   // the FLIP pipelines are still compiling
    const maxMove = S.dragSpeed / (S.scale || 1) * DT, states = [], tn = (S.frame + 1) * DT;
    for (const o of objs) {
      if (o.keys.length) {
        const k = keyPose(o.keys, tn, S.tl.smooth);
        o.target.set(k.x, k.y, k.z); o.pos.copy(o.target); o.rx = k.rx || 0; o.yaw = k.yaw || 0; o.rz = k.rz || 0;
        if (o.kind === 'emitter') { if (k.on !== undefined) o.on = k.on; if (k.speed !== undefined) o.speed = k.speed; }
        states.push(snap(o)); continue;
      }
      const dx = o.target.x - o.pos.x, dy = o.target.y - o.pos.y, dz = o.target.z - o.pos.z, L = Math.hypot(dx, dy, dz);
      if (L > maxMove) { const k = maxMove / L; o.pos.x += dx * k; o.pos.y += dy * k; o.pos.z += dz * k; } else o.pos.copy(o.target);
      if (o.kind === 'mesh') o.yaw += o.spin * DT;
      states.push(snap(o));
    }
    if (S.rec) recordStep();
    // substeps for the whole scene: the fastest particle (from the GPU, a step or two old), source or object decides how many
    const prev = S.prevStates && S.prevStates.length === states.length ? S.prevStates : null;
    const vfast = Math.max(objSpeed(prev, states, DT, S.colMax / (S.scale || 1)), (sim.stats && sim.stats.vmax) || 0);
    const hc = S.engine === 'flip' ? sim.h : 2 * S.liveD, lo = Math.max(1, S.subMin | 0), hi = Math.max(lo, S.subMax | 0);
    // the speed comes back from the GPU only after the steps queued before it, so in a sudden splash it is behind: once a frame needed
    // more substeps, keep that many for a second rather than dropping back on an old reading (too few substeps tear the water)
    let n = clamp(Math.ceil(DT * vfast / (1.5 * hc)), lo, hi);
    const now = performance.now();
    if (n >= (S.subHold || 0) || now > (S.subHoldT || 0)) { S.subHold = n; S.subHoldT = now + 1000; } else n = S.subHold;
    S.lastSub = n;
    const par = simPar();
    const t0 = performance.now();
    for (let s = 1; s <= n; s++) { par.time = (S.frame + s / n) * DT; runner.step(DT / n, prev && s < n ? lerpStates(prev, states, s / n) : states, par); }
    S.prevStates = states; S.lastStates = states;
    const el = performance.now() - t0; S.ms = S.ms ? S.ms * 0.9 + el * 0.1 : el;
    S.frame++;
    for (const e of S.events) if (!e.done && e.t <= tn) { e.done = true; sim.fillSphere(e.x, e.y, e.z, e.r, 0, -1, 0); }
    S.tl.t = S.frame * DT;
    if (S.tl.t >= S.tl.dur) {
      if (S.tl.end === 'stop') { S.tl.t = S.tl.dur; setPlaying(false); }
      else if (S.tl.end === 'loop') lcRestart(0);
    }
  }

  // the fastest water and the substeps it needed, against their limits, so it shows when a limit is holding the water back
  function limitInfo() {
    const el = $('#vmax-info'); if (!el || S.engine !== 'flip' || !sim.stats) return;
    const v = sim.stats.vmax * (S.scale || 1); S.vpeak = Math.max(S.vpeak || 0, v); S.subPeak = Math.max(S.subPeak || 0, S.lastSub || 1);
    const atV = S.vpeak >= 0.97 * S.vmaxW, atS = S.subPeak >= S.subMax;
    const t = 'Fastest water ' + Math.round(v) + ' m/s now, ' + Math.round(S.vpeak) + ' m/s at most since the start (limit ' + Math.round(S.vmaxW) + '). Substeps up to ' + S.subPeak + ' of ' + S.subMax + '.' +
      (atV ? ' The water reached its speed limit: raise Max water speed.' : '') + (atS ? ' It needed the most substeps allowed: raise Max substeps for fast moments.' : '');
    if (el._t !== t) { el._t = t; el.textContent = t; el.classList.toggle('warn', atV || atS); }
  }
  let last = performance.now(), acc = 0, fpsE = 60, uiT = 0, recUi = 0;
  const PREP = 'Preparing the GPU solver…';
  // While the sim plays, the live view is redrawn only when something changed: a new frame from the sim, the camera moving, or any input in the last moments
  // (and at least twice a second). Drawing shares the GPU with the solver: on Mer's Intel UHD 730 not drawing made a step about 40% faster,
  // and redrawing the same water 33 times a second while the sim delivered 8 new frames only slowed the sim down.
  // Smooth (auto) bake playback: frames drawn slower than the bake's rate step the look down (S.pbLvl 1: half the look-only points,
  // 2: none, 3: also fewer far copies); comfortably fast steps it back up. Hysteresis keeps it from flickering between levels.
  let pbIv = 0, pbSlow = 0, pbFast = 0, pbUid = -1;
  function pbAuto(dt, c) {
    if (pbUid !== c.uid) { pbUid = c.uid; S.pbLvl = 0; pbIv = 0; }
    if (S.pbQ !== 'smooth' || !S.cplay || c.partial) { pbSlow = pbFast = 0; return; }
    pbIv = pbIv ? pbIv * 0.85 + dt * 0.15 : dt;
    const need = 1 / Math.min(30, c.fps * S.cspeed);
    if (pbIv > need * 1.15) { pbSlow += dt; pbFast = 0; } else if (pbIv < need * 0.55) { pbFast += dt; pbSlow = 0; } else { pbSlow = Math.max(0, pbSlow - dt); pbFast = 0; }
    if (pbSlow > 0.6 && S.pbLvl < 3) { S.pbLvl++; pbSlow = 0; pbIv = need; }
    else if (pbFast > 3 && S.pbLvl > 0) { S.pbLvl--; pbFast = 0; pbIv = need; }
  }
  // performance overlay (P): where the time goes, updated twice a second
  let ovT = 0, ovDraws = 0, ovSimT = 0, ovUp = 0;
  S.perfOv = lsGet('perfOv') === '1';
  function perfOv(span) {
    const el = $('#perf-ov'); if (!el) return;
    el.hidden = !S.perfOv; if (!S.perfOv) { ovDraws = perf.draws || 0; ovSimT = S.tl.t; ovUp = perf.upN; return; }
    const mode = viewMode(), draws = ((perf.draws || 0) - ovDraws) / span, ups = (perf.upN - ovUp) / span, L = [];
    const rt = mode === 'live' && S.playing && !S.lcPlay ? Math.max(0, S.tl.t - ovSimT) / span : null;
    ovDraws = perf.draws || 0; ovSimT = S.tl.t; ovUp = perf.upN;
    const f1 = (v) => (v == null || !isFinite(v) ? '-' : v.toFixed(1));
    L.push('<b>Drawing</b>  ' + Math.round(draws) + ' a second, ' + f1(perf.render) + ' ms each, ' + fmtN(shownN) + ' points');
    L.push('Page work ' + f1(perf.frame) + ' ms a frame, uploads ' + f1(ups) + ' a second (' + f1(perf.up) + ' ms, ' + (perf.upBytes / 1048576).toFixed(1) + ' MB)');
    if (mode === 'live' && isGpu() && sim) {
      L.push('<b>Solver</b>   step ' + f1(sim.lastMs) + ' ms' + (sim.gpuMs ? ', GPU busy ' + f1(sim.gpuMs) + ' ms' : '') + ', ' + (S.lastSub || 1) + ' substeps, ' + (sim.inflight || 0) + ' queued');
      if (rt !== null) L.push((rt < 0.5 ? '<span class="w">' : '<span>') + 'Running at ' + Math.round(rt * 100) + '% of real time</span>');
      L.push(fmtN(sim.N || 0) + ' particles' + (S.sprOn && sim.sprayCap ? ', whitewater pool ' + fmtN(sim.sprayCap) : ''));
    }
    if (mode === 'cache' && S.cache) {
      const g = gpuKept(), lv = S.cplay ? (S.pbQ === 'fast' ? 'fast' : S.pbQ === 'smooth' ? ['full look', 'half the look-only points', 'no look-only points', 'fewest points'][S.pbLvl | 0] : 'full look') : 'paused, full look';
      const fr = S.cache.frames[Math.round(S.ct)] || {};
      L.push('<b>Bake</b>     ' + g.n + ' of ' + (S.cache.frames.length) + ' frames on the GPU (' + g.mb.toFixed(0) + ' MB), ' + (perf.late || 0) + ' loaded late');
      L.push('Playback: ' + lv + (fr.hid ? ', ' + fmtN(fr.hid) + ' buried points skipped' + (S.hideIn ? '' : ' (off)') : ''));
    }
    if (S.baking || S.wwPass) L.push('<span class="w">' + (S.baking ? 'Baking' : 'Baking whitewater') + ': the view redraws only twice a second</span>');
    L.push('<span style="color:#8a8a8a">P hides this</span>');
    const h = L.join('\n'); if (el._h !== h) { el._h = h; el.innerHTML = h; }
  }
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'p' || e.key === 'P') && !typing() && !e.ctrlKey && !e.metaKey && !e.altKey && !tf) { S.perfOv = !S.perfOv; lsSet('perfOv', S.perfOv ? '1' : '0'); perfOv(1); }
  });
  let lastInput = 0, lastDraw = 0; const camWas = new Float64Array(17);   // 64-bit: a 32-bit copy never equals the matrix, so every frame looked like a camera move
  ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'resize'].forEach((ev) => window.addEventListener(ev, () => { lastInput = performance.now(); }, { capture: true, passive: true }));
  function camMoved() {
    const m = camera.matrixWorld.elements, p = camera.projectionMatrix.elements; let moved = camWas[16] !== p[0] + p[5];
    for (let i = 0; i < 16; i++) if (camWas[i] !== m[i]) { moved = true; camWas[i] = m[i]; }
    camWas[16] = p[0] + p[5]; return moved;
  }
  function frame(now) {
    const fs = performance.now();   // page work is timed from here, not from the rAF timestamp (which includes the wait before the callback)
    requestAnimationFrame(frame); stepCam();
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    fpsE = fpsE * 0.92 + (1 / Math.max(dt, 1e-3)) * 0.08;
    const mode = viewMode();
    let count = 0, fresh = true;
    if (mode === 'cache') {
      const c = S.cache, lastF = c.frames.length - 1;
      if (c.partial) {   // still baking: show the newest frame, or play up to it and wait there
        if (S.cfollow) S.ct = Math.max(0, lastF);
        else if (S.cplay) { S.ct = Math.min(S.ct + dt * c.fps * S.cspeed, lastF); if (S.ct >= lastF) S.cfollow = true; }
      } else if (S.cplay && lastF > 0) {
        S.ct += dt * c.fps * S.cspeed;
        if (S.ct >= lastF) { if (S.cloop) S.ct = S.ct % lastF; else { S.ct = lastF; setCPlay(false); } }
      }
      { const vs = c.spdMs ? c.scale || 1 : 1; pmat.uniforms.uVs.value = vs; pmat.uniforms.uMax.value = S.vmax * vs / (c.scale || 1); } pmat.uniforms.uSize.value = S.psize * c.d; points.position.set((c.org || S.org).x, (c.org || S.org).y, (c.org || S.org).z);
      count = showCache(S.ct);
      pbAuto(dt, c);
      updatePlayhead();
      uiT += dt;
      if (uiT > 0.2) {
        uiT = 0; const fi = Math.round(S.ct);
        $('#frame').textContent = String(fi + 1).padStart(4, '0'); $('#count').textContent = count; $('#fps').textContent = Math.round(fpsE);
        const sc = $('#scrub'); if (document.activeElement !== sc) sc.value = fi;
      }
    } else if (S.lcPlay) {
      if (S.playing) {
        S.lcT += dt * 60;
        const end = LC.fnum[LC.fnum.length - 1];
        if (S.tl.end === 'loop' && S.lcT >= S.tl.dur * 60) S.lcT = 0;
        else if (S.tl.end === 'stop' && S.lcT >= S.tl.dur * 60) { S.lcT = S.tl.dur * 60; setPlaying(false); }
        else if (S.lcT >= end) lcExit();
      }
      if (S.lcPlay) {
        count = lcShow(); S.tl.t = S.lcT / 60;
        pmat.uniforms.uVs.value = LC.scale || 1; pmat.uniforms.uMax.value = S.vmax; pmat.uniforms.uSize.value = S.psize * LC.d; points.position.set(LC.org.x, LC.org.y, LC.org.z);
        uiT += dt;
        if (uiT > 0.2) { uiT = 0; $('#frame').textContent = String(Math.floor((S.lcT / 60) * 24) + 1).padStart(4, '0'); updatePlayhead(); $('#count').textContent = count; $('#fps').textContent = Math.round(fpsE); $('#ms').textContent = '— (cache)'; }
      }
    } else {
      const prep = sim.ready === false;
      if (prep) { if (hudMsg !== PREP) flash(PREP); } else if (hudMsg === PREP) { hudMsg = ''; hud(); }
      if (S.playing && !S.baking && !prep) {
        if (isGpu()) {
          // Steps stay queued until the browser reports them done, which can take far longer than the GPU work itself (seen on Mer's Intel
          // UHD 730), so more than one frame may wait. But keep the queue to about 0.3 s of steps at the rate they really finish
          // (lastMs): a longer one made Stop take effect seconds late and kept the GPU busy after it (20 steps of 0.47 s each at spacing 0.02).
          const sub = S.lastSub || 1, svc = Math.max(sim.lastMs || 0, sim.gpuMs || 0);
          const lim = svc ? Math.max(sub, Math.min(8 * sub, Math.floor(300 / svc))) : 2 * sub;
          acc = Math.min(acc + dt, 3 * DT);
          for (let k = 0; k < 3 && acc >= DT && (sim.inflight || 0) < lim; k++) { acc -= DT; stepOnce(); sim.maxQ = Math.max(sim.maxQ || 0, sim.inflight || 0); }
        } else {
          acc += dt; let n = 0;
          while (acc >= DT && n < 2) { stepOnce(); acc -= DT; n++; }
          if (n === 2) acc = 0;
        }
      } else { acc = 0; for (const o of objs) o.pos.copy(o.target); }
      for (const o of objs) poseGroup(o);
      if (tf) refreshFields();
      if (isGpu()) {
        if (sim.setDeepLook) sim.setDeepLook(S.nbLook && nbActive());
        sim.pump();
        if (sim.gen !== lastGen || SLOTS[liveI].key !== 'live') {
          const t0 = performance.now();
          const fr = S.engine === 'flip' ? sim.outFrame : (sim.outN ? packFrameBuf(rawBuf, sim.outN, sim.b, [], S.scale) : null);
          if (sim.gen !== lastGen) lcRecord(fr);
          lastCount = liveLoad(fr, sim.b, 'live').alive; lastGen = sim.gen; fresh = true;
          perf.build = performance.now() - t0 - perf.up;
        } else fresh = false;
        count = lastCount;
        S.ms = sim.lastMs;
      }
      else {
        count = liveLoad(packCpuFrame(sim.P, sim.S, sim.N, sim.b, S.scale), sim.b, 'live').alive; fresh = true;
      }
      showSlots(liveI, liveI, 0); pmat.uniforms.uD.value = S.liveD; pmat.uniforms.uCR.value = S.cellRatio;
      pmat.uniforms.uVs.value = S.scale || 1; pmat.uniforms.uMax.value = S.vmax; pmat.uniforms.uSize.value = S.psize * S.liveD; points.position.set(S.simOrg.x, S.simOrg.y, S.simOrg.z);
      uiT += dt;
      if (uiT > 0.2) {
        uiT = 0;
        $('#frame').textContent = String(Math.floor((S.frame / 60) * 24) + 1).padStart(4, '0');
        updatePlayhead();
        const simN = isGpu() ? sim.N : count; $('#count').textContent = simN; $('#fps').textContent = Math.round(fpsE); $('#ms').textContent = prep ? 'preparing' : S.ms.toFixed(1) + ((S.lastSub || 1) > 1 ? ' ×' + S.lastSub : '');
        if (LC.frames.length && Math.random() < 0.25) lcUi();
        limitInfo();
        $('#meter').style.width = Math.min(100, (simN / S.cap) * 100) + '%';
      }
      recUi += dt; if (S.rec && recUi > 0.5) { recUi = 0; updateRecInfo(); updateEst(); }
    }
    vpT += dt; if (vpT > 0.25) { vpT = 0; try { vpInfo(); } catch (e) { /* not ready */ } }
    ovT += dt; if (ovT > 0.5) { perfOv(ovT); ovT = 0; }
    placeHandles();
    oceanUpdate(mode);
    camera.updateMatrixWorld();
    const moved = camMoved(), t1 = performance.now();
    // while the live sim plays, or a bake runs on the GPU (drawing shares it: three times the cost in the benchmark), redraw only when something changed
    const quiet = isGpu() && ((mode === 'live' && S.playing && !S.lcPlay && !fresh) || ((S.baking || S.wwPass) && !S.cplay));
    const draw = !noDraw && (!quiet || moved || t1 - lastInput < 400 || t1 - lastDraw > 500 || tf);
    if (draw) { const tr = performance.now(); renderer.render(scene, camera); lastDraw = performance.now(); perf.render = lastDraw - tr; perf.draws = (perf.draws || 0) + 1; }
    perf.frame = performance.now() - fs;
    if (frameHook && draw) frameHook(performance.now());
  }

