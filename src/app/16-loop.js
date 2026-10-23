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
    const n = clamp(Math.ceil(DT * vfast / (1.5 * hc)), lo, hi); S.lastSub = n;
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

  let last = performance.now(), acc = 0, fpsE = 60, uiT = 0, recUi = 0;
  const PREP = 'Preparing the GPU solver…';
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
      pmat.uniforms.uMax.value = S.vmax / (c.scale || 1); pmat.uniforms.uSize.value = S.psize * c.d; points.position.set((c.org || S.org).x, (c.org || S.org).y, (c.org || S.org).z);
      count = showCache(S.ct);
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
        pmat.uniforms.uMax.value = S.vmax / (LC.scale || 1); pmat.uniforms.uSize.value = S.psize * LC.d; points.position.set(LC.org.x, LC.org.y, LC.org.z);
        uiT += dt;
        if (uiT > 0.2) { uiT = 0; $('#frame').textContent = String(Math.floor((S.lcT / 60) * 24) + 1).padStart(4, '0'); updatePlayhead(); $('#count').textContent = count; $('#fps').textContent = Math.round(fpsE); $('#ms').textContent = '— (cache)'; }
      }
    } else {
      const prep = sim.ready === false;
      if (prep) { if (hudMsg !== PREP) flash(PREP); } else if (hudMsg === PREP) { hudMsg = ''; hud(); }
      if (S.playing && !S.baking && !prep) {
        if (isGpu()) {
          acc = Math.min(acc + dt, 3 * DT);
          if (acc >= DT && (sim.inflight || 0) < 2 * (S.lastSub || 1)) { acc -= DT; stepOnce(); }
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
          const fr = S.engine === 'flip' ? sim.outFrame : (sim.outN ? packFrameBuf(rawBuf, sim.outN, sim.b, []) : null);
          if (sim.gen !== lastGen) lcRecord(fr);
          lastCount = liveLoad(fr, sim.b, 'live').alive; lastGen = sim.gen; fresh = true;
          perf.build = performance.now() - t0 - perf.up;
        } else fresh = false;
        count = lastCount;
        S.ms = sim.lastMs;
      }
      else {
        count = liveLoad(packCpuFrame(sim.P, sim.S, sim.N, sim.b), sim.b, 'live').alive; fresh = true;
      }
      showSlots(liveI, liveI, 0); pmat.uniforms.uD.value = S.liveD; pmat.uniforms.uCR.value = S.cellRatio;
      pmat.uniforms.uMax.value = S.vmax / (S.scale || 1); pmat.uniforms.uSize.value = S.psize * S.liveD; points.position.set(S.simOrg.x, S.simOrg.y, S.simOrg.z);
      uiT += dt;
      if (uiT > 0.2) {
        uiT = 0;
        $('#frame').textContent = String(Math.floor((S.frame / 60) * 24) + 1).padStart(4, '0');
        updatePlayhead();
        const simN = isGpu() ? sim.N : count; $('#count').textContent = simN; $('#fps').textContent = Math.round(fpsE); $('#ms').textContent = prep ? 'preparing' : S.ms.toFixed(1) + ((S.lastSub || 1) > 1 ? ' ×' + S.lastSub : '');
        if (LC.frames.length && Math.random() < 0.25) lcUi();
        $('#meter').style.width = Math.min(100, (simN / S.cap) * 100) + '%';
      }
      recUi += dt; if (S.rec && recUi > 0.5) { recUi = 0; updateRecInfo(); updateEst(); }
    }
    vpT += dt; if (vpT > 0.25) { vpT = 0; try { vpInfo(); } catch (e) { /* not ready */ } }
    placeHandles();
    oceanUpdate(mode);
    const tr = performance.now(); renderer.render(scene, camera); perf.render = performance.now() - tr; perf.frame = performance.now() - fs;
    if (frameHook) frameHook(performance.now());
  }

