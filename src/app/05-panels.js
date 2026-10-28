  // ---------- UI helpers ----------
  function addSlider(parent, o) {
    const row = document.createElement('div'); row.className = 'row';
    // a log slider spends more of its length on small values: position 0..1000 maps to min..max exponentially
    const lg = !!o.log, lr = lg ? Math.log(o.max / o.min) : 0, rd = o.round || 0.001;
    const pos0 = lg ? Math.round(1000 * Math.log(Math.max(o.value, o.min) / o.min) / lr) : o.value;
    row.innerHTML = '<label for="' + o.id + '">' + o.label + '</label><div class="num"><input type="range" id="' + o.id + '" min="' + (lg ? 0 : o.min) + '" max="' + (lg ? 1000 : o.max) + '" step="' + (lg ? 1 : o.step) + '" value="' + pos0 + '"><output for="' + o.id + '"></output></div>';
    const inp = row.querySelector('input'), out = row.querySelector('output'), lab = row.querySelector('label'), box = row.querySelector('.num');
    const fmt = o.fmt || ((v) => String(v));
    const get = () => lg ? Math.min(o.max, Math.max(o.min, +(Math.round(o.min * Math.exp(+inp.value / 1000 * lr) / rd) * rd).toFixed(5))) : +inp.value;
    const tol = (lg ? rd : (o.step || rd)) * 0.5 + 1e-9;
    // a label in bold means the value is not the default (as in Houdini)
    const mark = (v) => { if (o.def !== undefined) row.classList.toggle('nd', Math.abs(v - o.def) > Math.max(tol, Math.abs(o.def) * 1e-4)); };
    const fillP = () => { const a = +inp.min, z = +inp.max; inp.style.setProperty('--p', (z > a ? clamp((+inp.value - a) / (z - a), 0, 1) * 100 : 0) + '%'); };
    const show = () => { const v = get(); out.textContent = fmt(v); mark(v); fillP(); };
    show();
    // Blender style: drag sideways to change the value (from where it was, not where the mouse is), Shift for fine steps; a click without dragging types a value
    inp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); inp.focus({ preventScroll: true });
      const a = +inp.min, z = +inp.max, w = Math.max(80, box.clientWidth), st = +inp.step || 0;
      const d0 = { x: e.clientX, v: +inp.value, moved: false, id: e.pointerId };
      try { inp.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      box.classList.add('dragging');
      const mv = (ev) => {
        if (ev.pointerId !== d0.id) return;
        const dx = ev.clientX - d0.x; if (!d0.moved && Math.abs(dx) < 3) return;
        d0.moved = true;
        let v = d0.v + dx * (z - a) / w * (ev.shiftKey ? 0.1 : 1);
        if (st > 0) v = Math.round((v - a) / st) * st + a;
        v = clamp(v, a, z);
        if (String(v) !== inp.value) { inp.value = String(v); inp.dispatchEvent(new Event('input', { bubbles: true })); }
      };
      const up = (ev) => {
        if (ev.pointerId !== d0.id) return;
        inp.removeEventListener('pointermove', mv); inp.removeEventListener('pointerup', up); inp.removeEventListener('pointercancel', up);
        box.classList.remove('dragging');
        if (d0.moved) inp.dispatchEvent(new Event('change', { bubbles: true })); else out.click();
      };
      inp.addEventListener('pointermove', mv); inp.addEventListener('pointerup', up); inp.addEventListener('pointercancel', up);
    });
    inp.addEventListener('input', () => { show(); if (o.onPreview) o.onPreview(get()); if (!o.onChange) o.onInput(get()); });
    if (o.onChange) inp.addEventListener('change', () => o.onChange(get()));
    // set an exact value (typed, pasted or reset), kept inside the slider's range
    const commit = (c) => {
      c = Math.min(o.max, Math.max(o.min, c));
      inp.value = lg ? String(Math.round(1000 * Math.log(c / o.min) / lr)) : String(c);
      out.textContent = fmt(c); mark(c); fillP();
      row.dispatchEvent(new Event('input', { bubbles: true }));   // lets the panel know something changed (clears the live cache)
      if (o.onPreview) o.onPreview(c);
      if (o.onChange) o.onChange(c); else o.onInput(c);
    };
    lab.dataset.tip = o.tip || '';
    // click the value to type an exact number
    box.title = 'Drag to change, click to type a value';
    out.addEventListener('click', () => {
      if (row.querySelector('input.typed')) return;
      const t = document.createElement('input'); t.type = 'text'; t.className = 'typed'; t.value = String(+get().toFixed(4)); t.setAttribute('aria-label', o.label);
      out.hidden = true; box.appendChild(t); t.focus(); t.select();
      let fin = false;
      const done = (ok) => {
        if (fin || !t.isConnected) return; fin = true;
        const v = parseFloat(t.value.replace(',', '.'));
        t.remove(); out.hidden = false;
        if (ok && isFinite(v)) commit(v);
      };
      t.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      t.addEventListener('blur', () => done(true));
    });
    row._st = { label: o.label.replace(/<[^>]*>/g, ''), get, def: o.def, min: o.min, max: o.max, fmt, commit, type: () => out.click() };
    parent.appendChild(row); return inp;
  }
  // a collapsible sub-panel (like Blender's); whether it is open is remembered in this browser
  let searching = false;
  function sub(parent, key, title, open, tip) {
    const d = document.createElement('details'); d.className = 'sub'; d.dataset.k = key;
    const st = lsGet('open.' + key); d.open = st === null ? !!open : st === '1';
    const sm = document.createElement('summary'); sm.textContent = title; if (tip) sm.dataset.tip = tip; d.appendChild(sm);
    const body = document.createElement('div'); body.className = 'sub-body'; d.appendChild(body);
    d.addEventListener('toggle', () => { if (!searching) lsSet('open.' + key, d.open ? '1' : '0'); });
    parent.appendChild(d); return body;
  }
  // a checkbox row with a tooltip
  function addCheck(parent, id, label, on, tip, cb, def) {
    const row = document.createElement('div'); row.className = 'row plain';
    row.innerHTML = '<label for="' + id + '">' + label + '</label><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '>';
    const lab = row.querySelector('label'); if (tip) lab.dataset.tip = tip;
    const mark = (v) => { if (def !== undefined) row.classList.toggle('nd', v !== def); };
    mark(on);
    row.querySelector('input').addEventListener('change', (e) => { mark(e.target.checked); cb(e.target.checked); });
    parent.appendChild(row); return row;
  }
  // a drop-down row
  function addSelect(parent, id, label, opts, val, tip, cb) {
    const row = document.createElement('div'); row.className = 'row plain sel';
    row.innerHTML = '<label for="' + id + '">' + label + '</label><select id="' + id + '">' + opts.map(([v, l]) => '<option value="' + v + '"' + (v === val ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
    const lab = row.querySelector('label'); if (tip) lab.dataset.tip = tip;
    row.querySelector('select').addEventListener('change', (e) => { e.target.blur(); cb(e.target.value); });
    parent.appendChild(row); return row;
  }
  function setColorBy(v) {
    S.colorBy = v === 'type' ? 'type' : 'speed'; pmat.uniforms.uMode.value = S.colorBy === 'type' ? 1 : 0;
    document.querySelectorAll('#d-colby, #vh-colby').forEach((el) => { el.value = S.colorBy; });
    const lg = $('#legend'); if (lg) lg.hidden = S.colorBy !== 'type';
  }
  const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2), f3 = (v) => v.toFixed(3), f0 = (v) => String(Math.round(v));
  function seg(id, cb) {
    const el = $(id);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      setSeg(el, btn.dataset.v); cb(btn.dataset.v);
    });
  }
  function setSeg(el, v) { el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === String(v) ? 'true' : 'false')); }
  const fmtN = (n) => n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);

  // what a given spacing needs on the GPU, so a setting that cannot work is caught before the buffers are made
  function gridCost(d, ratio, maxN) {
    const h = d * ratio, nx = Math.max(4, Math.round(S.dom.w / h)), ny = Math.max(4, Math.round(S.dom.h / h)), nz = Math.max(4, Math.round(S.dom.d / h));
    const ncell = nx * ny * nz, ntiles = Math.ceil((nx + 1) / 8) * Math.ceil((ny + 1) / 8) * Math.ceil((nz + 1) / 8);
    // FLIP stores the grid in 8x8x8 blocks only near particles, about 20 KB a block (cells and faces). Particles: position, velocity,
    // fluid cell lists, plus the sort copy when sorting is on; the live view reads back at most about 300k points through a ring of three.
    const sm = Math.min(maxN, 300001), perP = 16 + 16 + 8 + (S.sortP ? 32 : 0), block = 512 * 40 + 12;
    const start = Math.max(64, Math.ceil(maxN / 1024)), compact = Math.ceil(maxN / ratio / ratio / ratio / 512 * 2.5);   // blocks when all points sit in solid water
    const particles = maxN * perP + sm * 16 * 4 + ntiles * 16;
    const biggest = Math.max(maxN * 16, start * 6144, ntiles * 8), total = particles + start * block;
    return { nx, ny, nz, ncell, biggest, total, particles, block, compact };
  }
  function resInfoText(d, ratio) {
    const c = gridCost(d, ratio, S.cap), lim = S.gpu ? S.gpu.maxBuf : 1 << 27, mb = (v) => Math.max(1, Math.round(v / 1048576));
    let t = 'Box ' + c.nx + ' × ' + c.ny + ' × ' + c.nz + ' = ' + (c.ncell / 1e6).toFixed(2) + 'M cells.';
    if (S.engine === 'flip') t += ' Particles about ' + mb(c.particles) + ' MB, grid about ' + mb(c.compact * c.block) + ' MB when full.';
    else t += ' About ' + mb(c.total) + ' MB on the GPU.';
    if (S.engine === 'flip' && S.cap > 300000) t += ' The live view shows a sample of about 300k points; every point is still simulated.';
    if (c.biggest > lim) t += ' TOO BIG for this GPU (one buffer would need ' + mb(c.biggest) + ' MB, the limit is ' + mb(lim) + ' MB). Lower Max points or raise the spacing.';
    return { text: t, bad: c.biggest > lim };
  }
  // live solver group, rebuilt when the engine changes
  const gs = $('#g-sim');
  function setSpacing(v) {
    const P = PRESET[S.engine], old = S.liveD; v = clamp(v, P.dMin, 0.16);
    const cap = v < old ? Math.min(P.capMax, Math.round(S.cap * Math.pow(old / v, 3) / 1000) * 1000) : S.cap;   // keep the same fill proportions when the spacing shrinks
    const c = gridCost(v, S.cellRatio, cap), lim = S.gpu ? S.gpu.maxBuf : 1 << 27;
    if (S.engine !== 'cpu' && c.biggest > lim) { flash('That spacing is too big for this GPU. Raise Grid cell size or shrink the box first.'); buildLiveUI(); return; }
    S.liveD = v; S.cap = cap; makeSim(); resetSim(S.tl.t); buildLiveUI();
  }
  // whitewater looks (Whitewater > Look); Impact is the defaults
  const WW_KEYS = ['sprAmt', 'sprMin', 'sprLife', 'sprMist', 'sprDrag', 'mistDrag', 'wwCrest', 'wwEdge', 'wwImpact', 'wwLand', 'wwTrail', 'wwSpin', 'wwFoamLife', 'wwErode', 'wwRise'];
  const WW_LOOKS = {
    calm: { sprAmt: 0.6, sprMin: 4, sprLife: 1, sprMist: 0.2, sprDrag: 1, mistDrag: 5, wwCrest: 0.6, wwEdge: 60, wwImpact: 0.15, wwLand: 0.5, wwTrail: 0.3, wwSpin: 0.3, wwFoamLife: 5, wwErode: 0.4, wwRise: 0.4 },
    waves: { sprAmt: 1.5, sprMin: 3, sprLife: 1.2, sprMist: 0.35, sprDrag: 1, mistDrag: 5, wwCrest: 1.5, wwEdge: 75, wwImpact: 0.4, wwLand: 1, wwTrail: 0.8, wwSpin: 0.8, wwFoamLife: 10, wwErode: 0.25, wwRise: 0.4 },
    impact: Object.fromEntries(WW_KEYS.map((k) => [k, dv(k)])),
    storm: { sprAmt: 3, sprMin: 2, sprLife: 1.6, sprMist: 0.5, sprDrag: 0.8, mistDrag: 4, wwCrest: 2, wwEdge: 85, wwImpact: 0.6, wwLand: 1.5, wwTrail: 2, wwSpin: 1, wwFoamLife: 14, wwErode: 0.2, wwRise: 0.5 }
  };
  function wwLookNow() { for (const [n, L] of Object.entries(WW_LOOKS)) if (WW_KEYS.every((k) => Math.abs(S[k] - L[k]) < 1e-6)) return n; return 'custom'; }
  function wwLookMark() { const el = $('#seg-wwlook'); if (el) setSeg(el, wwLookNow()); }
  function buildLiveUI() {
    [...gs.children].forEach((n) => { if (n.tagName !== 'H2') n.remove(); });
    const P = PRESET[S.engine], flip = S.engine === 'flip';
    const subt = $('#subtitle'); if (subt) subt.textContent = flip ? 'FLIP · GPU' : S.engine === 'gpu' ? 'PBF · GPU' : 'PBF · CPU';
    const er = document.createElement('div'); er.className = 'row plain';
    er.innerHTML = '<label>Solver</label><div class="seg" id="seg-engine" role="group" aria-label="Solver"><button type="button" data-v="flip" aria-pressed="' + flip + '"' + (S.gpu ? '' : ' disabled') + '>FLIP</button><button type="button" data-v="gpu" aria-pressed="' + (S.engine === 'gpu') + '"' + (S.gpu ? '' : ' disabled') + '>PBF GPU</button><button type="button" data-v="cpu" aria-pressed="' + (S.engine === 'cpu') + '">PBF CPU</button></div>';
    er.querySelector('label').dataset.tip = flip ? 'FLIP on ' + S.gpu.name + ': a pressure solve on a grid with particles carrying the motion. Real water behaviour, incompressible, with splashes.' : S.engine === 'gpu' ? 'Position based fluids on ' + S.gpu.name + '. Fast and splashy, less exact than FLIP.' : (S.gpu ? 'CPU solver. Slower, but works anywhere.' : 'WebGPU is not available in this browser, so the CPU solver is in use. Chrome or Edge on Windows normally have it.');
    gs.appendChild(er);
    er.querySelector('.seg').addEventListener('click', (e) => { const bt = e.target.closest('button'); if (bt && !bt.disabled && bt.dataset.v !== S.engine) setEngine(bt.dataset.v); });

    // resolution
    const rs = sub(gs, 'res', 'Resolution', true);
    const qr = document.createElement('div'); qr.className = 'row plain';
    qr.innerHTML = '<label data-tip="Quick spacing presets, from coarse and fast to fine and slow.">Preset</label><div class="seg" id="seg-prev" role="group" aria-label="Resolution preset"><button type="button" data-v="1.6">Draft</button><button type="button" data-v="1">Normal</button><button type="button" data-v="0.7">Fine</button><button type="button" data-v="0.5">Ultra</button></div>';
    qr.querySelector('.seg').addEventListener('click', (e) => {
      const bt = e.target.closest('button'); if (!bt) return;
      setSpacing(Math.round(P.liveD * parseFloat(bt.dataset.v) * 1000) / 1000);
    });
    rs.appendChild(qr);
    addSlider(rs, { id: 's-res', label: 'Spacing', min: P.dMin, max: 0.16, log: true, value: S.liveD, def: dv('liveD'), fmt: (v) => v.toFixed(3) + ' m', tip: 'Distance between particles. Smaller is finer and slower: halving it means about eight times the particles. The grid is only stored in 8×8×8 blocks near the water, so a big box costs almost nothing.', onInput: () => {}, onPreview: (v) => { const r = resInfoText(v, S.cellRatio), el = $('#res-info'); if (el) { el.textContent = r.text; el.classList.toggle('warn', r.bad); } }, onChange: (v) => { setSpacing(v); } });
    if (flip) addSlider(rs, { id: 's-ratio', label: 'Grid cell', min: 1.6, max: 3.2, step: 0.1, value: S.cellRatio, def: dv('cellRatio'), fmt: (v) => v.toFixed(1) + '×', tip: 'Size of a pressure-grid cell, as a multiple of the particle spacing. Bigger cells are faster but blur small detail.', onInput: () => {}, onPreview: (v) => { const r = resInfoText(S.liveD, v), el = $('#res-info'); if (el) { el.textContent = r.text; el.classList.toggle('warn', r.bad); } }, onChange: (v) => { if (gridCost(S.liveD, v, S.cap).biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27)) { flash('That grid is too big for this GPU.'); buildLiveUI(); return; } S.cellRatio = v; makeSim(); resetSim(S.tl.t); buildLiveUI(); } });
    addSlider(rs, { id: 's-cap', label: 'Max points', min: 1000, max: P.capMax, step: P.capMax > 400000 ? 5000 : P.capMax > 20000 ? 1000 : 500, value: S.cap, def: dv('cap'), fmt: fmtN, tip: 'The most particles the sim may hold. Sources stop emitting when it is full.', onPreview: (v) => { $('#capshow').textContent = fmtN(v); }, onChange: (v) => {
      S.cap = v;
      if (v <= sim.MAXN || S.engine === 'cpu') { sim.setCap(v); return; }
      if (gridCost(S.liveD, S.cellRatio, v).biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27)) { S.cap = sim.MAXN; flash('That many points does not fit in one GPU buffer here.'); buildLiveUI(); return; }
      makeSim(); resetSim(S.tl.t);
    } });
    { const ri = document.createElement('div'); ri.className = 'pos'; ri.id = 'res-info'; const r = resInfoText(S.liveD, S.cellRatio); ri.textContent = r.text; ri.classList.toggle('warn', r.bad); rs.appendChild(ri); }

    // physics
    const ph = sub(gs, 'phys', 'Physics', true);
    addSlider(ph, { id: 's-grav', label: 'Gravity', min: 0, max: 20, step: 0.1, value: S.g, def: dv('g'), fmt: (v) => v.toFixed(1) + ' m/s²', tip: 'Downward pull. 9.8 is Earth.', onInput: (v) => { S.g = v; } });
    if (flip) {
      {   // velocity transfer between particles and grid: FLIP (with the FLIP ratio) or APIC (g2pA in wgsl-solver.js)
        const r = document.createElement('div'); r.className = 'row plain';
        r.innerHTML = '<label data-tip="How particles and the grid hand velocity to each other. FLIP (Houdini: Splashy) keeps each particle\'s own motion and adds the grid\'s change: lively and splashy, but noisy. APIC (Houdini: Swirly) takes the grid motion and keeps, per particle, how the flow turns and stretches around it: swirls and rotation last, the surface is calmer and less grainy, splashes a little softer. With APIC the FLIP ratio is not used and particle sorting is off.">Velocity transfer</label><div class="seg" id="seg-xfer" role="group" aria-label="Velocity transfer"><button type="button" data-v="flip">FLIP</button><button type="button" data-v="apic">APIC</button></div>';
        ph.appendChild(r); setSeg($('#seg-xfer'), S.xfer); seg('#seg-xfer', (v) => { S.xfer = v; if (S.engine === 'flip' && sim && sim.opt) sim.opt.apic = v === 'apic'; r.classList.toggle('nd', v !== 'flip'); });
        r.classList.toggle('nd', S.xfer !== 'flip');
      }
      addSlider(ph, { id: 's-flip', label: 'FLIP ratio', min: 0, max: 1, step: 0.01, value: S.flip, def: dv('flip'), fmt: f2, tip: 'How much particles keep their own motion (1, splashy and lively) versus taking the smoothed grid motion (0, calm and thick).', onInput: (v) => { S.flip = v; } });
      addSlider(ph, { id: 's-sep', label: 'Particle separation', min: 0, max: 40, step: 1, value: S.sep, def: dv('sep'), fmt: (v) => String(Math.round(v)), tip: 'Keeps the water from losing volume by moving crowded particles apart, about this many times a second. It moves particles rather than pushing their velocity, so waves keep their height (the older way, used at 0, worked like friction: a standing wave lost a third of its height each swing). Around 10 holds the volume of a long, violent slosh.', onInput: (v) => { S.sep = v; if (S.engine === 'flip' && sim && sim.opt) sim.opt.sep = v; } });
      addSlider(ph, { id: 's-iters', label: 'Pressure iters', min: 5, max: 150, step: 5, value: S.iters, def: dv('iters'), fmt: f0, tip: 'Passes of the pressure solve each step. More keeps the volume better (less squashing at the bottom) but costs time.', onInput: (v) => { S.iters = v; } });
    } else {
      addSlider(ph, { id: 's-visc', label: 'Viscosity', min: 0, max: 0.3, step: 0.005, value: S.visc, def: dv('visc'), fmt: f2, tip: 'Thickness. 0 is water, higher is more like syrup.', onInput: (v) => { S.visc = v; } });
      addSlider(ph, { id: 's-iters', label: 'Iterations', min: 1, max: 6, step: 1, value: S.iters, def: dv('iters'), fmt: f0, tip: 'Solver passes each step. More is stiffer and slower.', onInput: (v) => { S.iters = v; } });
    }
    const scInfo = () => { const el = $('#scale-info'); if (el) { const k = S.scale || 1, f = (v) => (v * k >= 100 ? Math.round(v * k) : +(v * k).toFixed(v * k >= 10 ? 1 : 2)); el.textContent = 'The box is ' + f(S.dom.w) + ' × ' + f(S.dom.h) + ' × ' + f(S.dom.d) + ' m, one grid cell ' + f(S.liveD * S.cellRatio) + ' m.'; } };
    addSlider(ph, { id: 's-scale', label: 'Scene scale', min: 0.1, max: 200, log: true, round: 0.1, value: S.scale, def: dv('scale'), fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' m/unit', tip: 'How many metres one unit of the scene stands for. Gravity and every speed in m/s are converted, so a bigger scale makes the same box behave like a bigger, slower body of water.', onInput: (v) => { S.scale = Math.max(0.1, v); scInfo(); } });
    { const el = document.createElement('div'); el.className = 'pos'; el.id = 'scale-info'; ph.appendChild(el); scInfo(); }

    if (flip) {
      const aw = sub(gs, 'air', 'Air and wind', false);
      addSlider(aw, { id: 's-wind', label: 'Wind speed', min: 0, max: 20, step: 0.5, value: S.wind.speed, def: dv('wind.speed'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'Steady wind that pushes on water exposed to the air.', onInput: (v) => { S.wind.speed = v; } });
      addSlider(aw, { id: 's-windaz', label: 'Wind heading', min: -180, max: 180, step: 5, value: S.wind.az, def: dv('wind.az'), fmt: (v) => v + '°', tip: 'Direction the wind blows towards, around the vertical axis.', onInput: (v) => { S.wind.az = v; } });
      addSlider(aw, { id: 's-up', label: 'Updraft', min: -5, max: 8, step: 0.5, value: S.wind.up, def: dv('wind.up'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'Vertical air movement. Positive lifts spray, negative pushes it down.', onInput: (v) => { S.wind.up = v; } });
      addSlider(aw, { id: 's-drag', label: 'Air drag', min: 0, max: 3, step: 0.05, value: S.airDrag, def: dv('airDrag'), fmt: (v) => v.toFixed(2) + ' /s', tip: 'How quickly flying water slows down in the air.', onInput: (v) => { S.airDrag = v; } });
      addSlider(aw, { id: 's-gust', label: 'Air turbulence', min: 0, max: 6, step: 0.25, value: S.gust, def: dv('gust'), fmt: (v) => v.toFixed(2) + ' m/s', tip: 'Random gusts that break up flying sheets and spray.', onInput: (v) => { S.gust = v; } });

      const ww = sub(gs, 'white', 'White water and tearing', false);
      addSlider(ww, { id: 's-foamsens', label: 'White water amount', min: 0.3, max: 3, step: 0.1, value: 1 / S.foamSens, def: 1 / dv('foamSens'), fmt: (v) => v.toFixed(1) + '×', tip: 'How easily fast, churned water turns white.', onInput: (v) => { S.foamSens = 1 / v; } });
      addSlider(ww, { id: 's-foamtau', label: 'White water fade', min: 0.3, max: 4, step: 0.1, value: S.foamTau, def: dv('foamTau'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long white water takes to fade back to blue.', onInput: (v) => { S.foamTau = v; } });
      addSlider(ww, { id: 's-tear', label: 'Sheet tearing', min: 0, max: 1, step: 0.05, value: S.tear, def: dv('tear'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2)), tip: 'Lets thin sheets and drops fly apart instead of being held together as a membrane (the lace look). Too high and thin water starts to look lost.', onInput: (v) => { S.tear = v; } });

      const sp = sub(gs, 'spray', 'Whitewater', true, 'Spray, mist, foam and bubbles, as in Houdini: points thrown off the water that never push it. Each is sorted every step by how deep in water it is: spray that lands turns to foam, foam rides the surface and fades, foam pushed under turns to bubbles, and bubbles rise back up as foam.');
      addCheck(sp, 'c-spray', 'Enabled', S.sprOn, 'Turns whitewater (spray, mist, foam and bubbles), the air field and dripping on or off.', (on) => { S.sprOn = on; if (sim && sim.setSprayCap) sim.setSprayCap(S.sprOn ? S.sprCap : 0); lastGen = -1; }, dv('sprOn'));
      // looks: whole sets of the settings below; anything changed by hand shows as Custom
      const lk = document.createElement('div'); lk.className = 'row plain looks';
      lk.innerHTML = '<label data-tip="Starting points for the whitewater settings. Pick one, then fine-tune; changing any setting by hand makes it Custom.">Look</label><div class="seg wrap" id="seg-wwlook" role="group" aria-label="Whitewater look">' +
        [['calm', 'Calm'], ['waves', 'Breaking waves'], ['impact', 'Impact'], ['storm', 'Storm'], ['custom', 'Custom']].map(([v, l]) => '<button type="button" data-v="' + v + '"' + (v === 'custom' ? ' disabled' : '') + '>' + l + '</button>').join('') + '</div>';
      sp.appendChild(lk); setSeg($('#seg-wwlook'), wwLookNow());
      seg('#seg-wwlook', (v) => { if (WW_LOOKS[v]) { Object.assign(S, WW_LOOKS[v]); buildLiveUI(); } });
      ['input', 'change', 'pointerup'].forEach((ev) => sp.addEventListener(ev, () => setTimeout(wwLookMark, 0)));
      addSlider(sp, { id: 's-spramt', label: 'Spray amount', min: 0.1, max: 6, log: true, round: 0.05, value: S.sprAmt, def: dv('sprAmt'), fmt: (v) => v.toFixed(2) + '×', tip: 'How many spray points fast water throws off.', onInput: (v) => { S.sprAmt = v; } });
      addSlider(sp, { id: 's-wwfoam', label: 'Foam lifetime', min: 0.3, max: 20, log: true, round: 0.1, value: S.wwFoamLife, def: dv('wwFoamLife'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long foam lasts on the surface before it breaks up. Long foam leaves the trails and patches that make big water read as big.', onInput: (v) => { S.wwFoamLife = v; } });
      addSlider(sp, { id: 's-wwtrail', label: 'Mist trails', min: 0, max: 3, step: 0.05, value: S.wwTrail, def: dv('wwTrail'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Fast spray drops leave a trail of fine mist behind them; the faster they fly, the more.', onInput: (v) => { S.wwTrail = v; } });
      const spFrom = sub(sp, 'ww-from', 'Where it comes from', false, 'Which water throws off whitewater: fast crests and leading edges, churning impacts, water landing on water, and spin under the surface.');
      addSlider(spFrom, { id: 's-sprmin', label: 'Spray from', min: 0.5, max: 30, log: true, round: 0.1, value: S.sprMin, def: dv('sprMin'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'Water faster than this, near the surface, throws off spray. Lower makes more spray from calmer water.', onInput: (v) => { S.sprMin = v; } });
      addSlider(spFrom, { id: 's-wwcrest', label: 'From crests', min: 0, max: 3, step: 0.05, value: S.wwCrest, def: dv('wwCrest'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Whitewater from fast water at crests, thin sheets and splash edges moving outwards (Houdini sources this from curvature and speed).', onInput: (v) => { S.wwCrest = v; } });
      addSlider(spFrom, { id: 's-wwedge', label: 'Leading edge', min: 20, max: 90, step: 1, value: S.wwEdge, def: dv('wwEdge'), fmt: (v) => Math.round(v) + '°', tip: 'Crests only throw whitewater where the water moves outwards from the surface, within this angle of straight out: the leading edges of waves and splashes. 90° lets any fast exposed water throw it (Houdini: Max Velocity Angle).', onInput: (v) => { S.wwEdge = v; } });
      addSlider(spFrom, { id: 's-wwimpact', label: 'From churn', min: 0, max: 3, step: 0.05, value: S.wwImpact, def: dv('wwImpact'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Whitewater from churning white water: impacts, breaking waves, hard turns (Houdini sources this from acceleration). Made under the surface it starts as bubbles.', onInput: (v) => { S.wwImpact = v; } });
      addSlider(spFrom, { id: 's-wwland', label: 'Foam from landing', min: 0, max: 3, step: 0.05, value: S.wwLand, def: dv('wwLand'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Foam where falling water lands on water: splashes coming down, a waterfall hitting a pool, a crown falling back into the sea.', onInput: (v) => { S.wwLand = v; } });
      addSlider(spFrom, { id: 's-wwspin', label: 'From spin', min: 0, max: 3, step: 0.05, value: S.wwSpin, def: dv('wwSpin'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Bubbles from water spinning under the surface, where churning drags air down (Houdini sources this from vorticity).', onInput: (v) => { S.wwSpin = v; } });
      const spMove = sub(sp, 'ww-move', 'How it moves', false, 'How long each kind lives and how the air slows it: spray, mist, foam spreading, bubbles rising.');
      addSlider(spMove, { id: 's-sprlife', label: 'Spray lifetime', min: 0.2, max: 6, step: 0.1, value: S.sprLife, def: dv('sprLife'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long a spray point lives before it fades.', onInput: (v) => { S.sprLife = v; } });
      addSlider(spMove, { id: 's-sprmist', label: 'Mist share', min: 0, max: 1, step: 0.05, value: S.sprMist, def: dv('sprMist'), fmt: f2, tip: 'Fraction of the spray that is fine mist: lighter, slowed hard by the air, drawn as soft puffs.', onInput: (v) => { S.sprMist = v; } });
      addSlider(spMove, { id: 's-sprdrag', label: 'Spray drag', min: 0, max: 6, step: 0.1, value: S.sprDrag, def: dv('sprDrag'), fmt: (v) => v.toFixed(1) + ' /s', tip: 'How quickly spray droplets slow down in the air.', onInput: (v) => { S.sprDrag = v; } });
      addSlider(spMove, { id: 's-mistdrag', label: 'Mist drag', min: 0.5, max: 30, log: true, round: 0.1, value: S.mistDrag, def: dv('mistDrag'), fmt: (v) => v.toFixed(1) + ' /s', tip: 'How quickly mist slows down in the air. High values make it hang and drift.', onInput: (v) => { S.mistDrag = v; } });
      addSlider(spMove, { id: 's-wwerode', label: 'Foam spreading', min: 0, max: 3, step: 0.05, value: S.wwErode, def: dv('wwErode'), fmt: (v) => (v === 0 ? 'off' : v.toFixed(2) + '×'), tip: 'Foam fades faster where the surface spreads apart and lasts where it gathers, so it forms lines and lacy patches instead of an even sheet.', onInput: (v) => { S.wwErode = v; } });
      addSlider(spMove, { id: 's-wwrise', label: 'Bubble rise', min: 0.05, max: 2, log: true, round: 0.01, value: S.wwRise, def: dv('wwRise'), fmt: (v) => v.toFixed(2) + ' m/s', tip: 'How fast bubbles rise through the water before they surface as foam.', onInput: (v) => { S.wwRise = v; } });
      const spMany = sub(sp, 'ww-many', 'How many', false, 'The most whitewater points alive at once.');
      addSlider(spMany, { id: 's-sprcap', label: 'Max whitewater', min: 50000, max: 4000000, log: true, round: 10000, value: S.sprCap, def: dv('sprCap'), fmt: fmtN, tip: 'The most whitewater (spray, mist, foam and bubble) points alive at once. They use GPU memory but never slow the water solve.', onInput: () => {}, onChange: (v) => { S.sprCap = v; if (sim && sim.setSprayCap && S.sprOn) sim.setSprayCap(v); } });
      const ap = sub(gs, 'airfield', 'Air field', false, 'A coarse grid of moving air. Water near the surface, flying spray and moving objects drag it along; it spreads out and settles back to the wind. Spray and mist drift with it, so mist billows and trails behind a splash. It never pushes the water itself.');
      addCheck(ap, 'c-air', 'Enabled', S.airOn, 'Spray and mist move with the air the water and objects drag along, instead of only the wind.', (on) => { S.airOn = on; }, dv('airOn'));
      addSlider(ap, { id: 's-aircouple', label: 'Drag along', min: 0.2, max: 20, log: true, round: 0.1, value: S.airCouple, def: dv('airCouple'), fmt: (v) => v.toFixed(1), tip: 'How strongly moving water, spray and objects pull the air with them.', onInput: (v) => { S.airCouple = v; } });
      addSlider(ap, { id: 's-airdecay', label: 'Settle', min: 0.05, max: 5, log: true, round: 0.05, value: S.airDecay, def: dv('airDecay'), fmt: (v) => v.toFixed(2) + ' /s', tip: 'How quickly stirred-up air settles back to the wind. Low values leave long trailing gusts.', onInput: (v) => { S.airDecay = v; } });
      const dp = sub(gs, 'drip', 'Dripping', false, 'Objects coming out of the water stay wet and drip for a while: points over their surface remember being in water, dry out, and let go of drops as they do (more from surfaces facing down).');
      addCheck(dp, 'c-drip', 'Enabled', S.dripOn, 'Wet objects drip after they leave the water.', (on) => { S.dripOn = on; }, dv('dripOn'));
      addSlider(dp, { id: 's-driprate', label: 'Drip amount', min: 0.1, max: 20, log: true, round: 0.1, value: S.dripRate, def: dv('dripRate'), fmt: (v) => v.toFixed(1), tip: 'Drops a second from each wet spot on the surface (about one spot per grid cell of surface), while it is fully wet.', onInput: (v) => { S.dripRate = v; } });
      addSlider(dp, { id: 's-dripdry', label: 'Dries in', min: 0.3, max: 20, log: true, round: 0.1, value: S.dripDry, def: dv('dripDry'), fmt: (v) => v.toFixed(1) + ' s', tip: 'How long an object keeps dripping after it leaves the water.', onInput: (v) => { S.dripDry = v; } });
    }

    if (flip) {   // narrow band and ocean
      const nbp = sub(gs, 'nband', 'Narrow band', S.nbOn || S.ocean.on, 'Particles only in a band under the surface, as in Houdini. The deep water is kept on the grid, so big bodies of water need far fewer particles and a much finer spacing fits. From the side, the deep water shows hollow.');
      const nr = addCheck(nbp, 'c-nb', 'Enabled', S.nbOn || S.ocean.on, 'Keep particles only near the surface. Restarts the particles.', (on) => { S.nbOn = on; lcClear(); resetSim(S.tl.t); buildLiveUI(); }, false);
      if (S.ocean.on) { nr.querySelector('input').disabled = true; nr.querySelector('label').dataset.tip = 'The ocean needs narrow band, so it stays on while the ocean is on.'; }
      addCheck(nbp, 'c-nblook', 'Deep water', S.nbLook, 'Look only: draws the deep water under the band (which has no particles) as points too, so the water does not look hollow from the side. Drawing only, also kept in bakes. Costs some drawing time.', (on) => { S.nbLook = on; lastGen = -1; }, false);
      addSlider(nbp, { id: 's-nbband', label: 'Band', min: 2, max: NB_FULL, step: 1, value: S.nbBand, def: 3, fmt: (v) => (v >= NB_FULL ? 'Full depth' : v + ' cells'), tip: 'How many grid cells deep the particles reach under the surface. Under the band the water lives only on the grid, which is fast but smooths away swirls and damps waves deep down. More keeps detail in deep, churning water; Full depth (the far right) keeps particles all the way down, so the water behaves like a normally filled volume, at the cost of many more particles. Restarts the particles.', onInput: () => {}, onChange: (v) => { S.nbBand = v; lcClear(); resetSim(S.tl.t); updateEst(); } });
      const op = sub(gs, 'ocean', 'Ocean', S.ocean.on, 'Waves from an ocean spectrum roll in through the sides of the box, like Houdini\'s wave tank. The sides become a boundary that moves with the waves.');
      addCheck(op, 'c-ocean', 'Enabled', S.ocean.on, 'Fills the box with sea up to the water level and drives waves in from the sides. Turns narrow band on. Restarts the particles.', (on) => { S.ocean.on = on; lcClear(); resetSim(S.tl.t); buildLiveUI(); }, false);
      const ocS = (id, label, key, min, max, o) => addSlider(op, Object.assign({ id, label, min, max, value: S.ocean[key], def: OCEAN_DEF[key], onInput: (v) => { S.ocean[key] = v; } }, o));
      ocS('s-ohgt', 'Wave height', 'height', 0.05, 40, { log: true, round: 0.05, fmt: (v) => v.toFixed(v < 10 ? 2 : 1) + ' m', tip: 'Significant wave height: about the average of the biggest third of the waves, trough to crest, in metres (Scene scale applies).' });
      ocS('s-olen', 'Wavelength', 'length', 1, 600, { log: true, round: 0.5, fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' m', tip: 'Length of the main waves, crest to crest, in metres. Longer waves travel faster and stir the water deeper.' });
      ocS('s-odir', 'Direction', 'dir', -180, 180, { step: 5, fmt: (v) => v + '°', tip: 'Direction the waves travel towards. 0 is along +X.' });
      ocS('s-ospr', 'Spread', 'spread', 0, 90, { step: 5, fmt: (v) => v + '°', tip: 'How far the wave directions fan out. 0 gives long parallel swell; more gives a choppy, crossing sea.' });
      addCheck(op, 'c-ofull', 'Full depth', S.nbBand >= NB_FULL, 'Particles all the way to the bottom instead of only a narrow band under the surface. The sea then behaves like a normally filled volume: swirls and waves travel through it instead of being damped deep down. Uses many more particles, so it is slower; lower the spacing or raise Max points to fit it. Restarts the particles.', (on) => { S.nbBand = on ? NB_FULL : 3; lcClear(); resetSim(S.tl.t); buildLiveUI(); updateEst(); }, false);
      ocS('s-olvl', 'Water level', 'level', 0.1, 0.9, { step: 0.01, fmt: (v) => Math.round(v * 100) + '%', tip: 'Still water height, as a share of the box height. Restarts the particles.', onInput: () => {}, onChange: (v) => { S.ocean.level = v; lcClear(); resetSim(S.tl.t); } });
      ocS('s-olay', 'Boundary', 'layer', 0.05, 0.4, { step: 0.01, fmt: (v) => Math.round(v * 100) + '%', tip: 'Width of the boundary along the sides, as a share of the box. Its outer half moves with the waves like a wall; its inner half eases the water into the waves, which keeps reflections down.' });
      ocS('s-oseed', 'Seed', 'seed', 1, 99, { step: 1, fmt: (v) => String(v), tip: 'A different pattern of the same kind of sea.' });
    }

    // motion: substeps for the whole scene and how fast things may go
    const mo = sub(gs, 'motion', 'Substeps and speed limits', false, 'Each frame is split into substeps so nothing moves more than about 1.5 grid cells per step; the count follows the fastest water, source or object.');
    addSlider(mo, { id: 's-submin', label: 'Min substeps', min: 1, max: 8, step: 1, value: S.subMin, def: dv('subMin'), fmt: f0, tip: 'Substeps every frame even when the water is calm.', onInput: (v) => { S.subMin = v; } });
    addSlider(mo, { id: 's-submax', label: 'Max substeps', min: 1, max: 128, step: 1, value: S.subMax, def: dv('subMax'), fmt: f0, tip: 'The most substeps a frame may take when things move fast.', onInput: (v) => { S.subMax = v; } });
    addSlider(mo, { id: 's-colmax', label: 'Object speed limit', min: 5, max: 1000, log: true, round: 1, value: S.colMax, def: dv('colMax'), fmt: (v) => Math.round(v) + ' m/s', tip: 'An object moving faster than this counts as jumping: it shows up in the new place and only pushes water out of its way, without carrying it along.', onInput: (v) => { S.colMax = v; } });
    if (flip) addSlider(mo, { id: 's-wmax', label: 'Max water speed', min: 5, max: 1000, log: true, round: 1, value: S.vmaxW, def: dv('vmaxW'), fmt: (v) => Math.round(v) + ' m/s', tip: 'Water is never allowed to go faster than this. A safety limit against blow-ups.', onInput: (v) => { S.vmaxW = v; } });
    if (flip) mo.insertAdjacentHTML('beforeend', '<div class="pos" id="vmax-info" data-keep></div>');   // fastest water and substeps against their limits (updated by the frame loop)
    addSlider(mo, { id: 's-dragspd', label: 'Drag speed', min: 1, max: 100, log: true, round: 0.5, value: S.dragSpeed, def: dv('dragSpeed'), fmt: (v) => v.toFixed(v < 10 ? 1 : 0) + ' m/s', tip: 'How fast objects follow the mouse when you drag them while the sim runs.', onInput: (v) => { S.dragSpeed = v; } });

    if (isGpu()) {   // live cache controls; changing these never clears the cache
      const lc = sub(gs, 'lcache', 'Live cache', false, 'While the sim runs from the start, the frames are kept in memory so Reset, Rewind and the timeline play them back without simulating. Blue on the timeline is cached, orange is out of date.');
      const box = document.createElement('div'); box.dataset.keep = '1'; box.className = 'params'; lc.appendChild(box);
      addCheck(box, 'c-lc', 'Live cache', S.lcOn, 'Keep the frames the live view shows, so they replay without simulating.', (on) => { S.lcOn = on; if (!S.lcOn) { lcClear(); LC.staleEnd = 0; } lcUi(); }, true);
      addSlider(box, { id: 's-lcmem', label: 'Cache memory', min: 128, max: 8192, log: true, round: 64, value: S.lcBudget, def: dv('lcBudget'), fmt: (v) => (v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : Math.round(v) + ' MB'), tip: 'The most memory the live cache may use. Recording stops when it is full.', onInput: (v) => { S.lcBudget = v; } });
      const st = document.createElement('div'); st.className = 'pos'; st.id = 'lc-info'; box.appendChild(st);
      const br = document.createElement('div'); br.className = 'btnrow'; br.innerHTML = '<button class="btn flat" id="btn-lc-clear" type="button">Clear cache</button>'; box.appendChild(br);
      br.querySelector('button').addEventListener('click', () => { lcClear(); LC.staleEnd = 0; lcUi(); flash('Live cache cleared'); });
      lcUi();
    }
    if (flip) {
      const su = sub(gs, 'speedups', 'Speed-ups', false);
      addCheck(su, 'c-sort', 'Sort particles', S.sortP, 'Reorders particles by position every 16 steps so neighbours sit together in memory. Same result. Clearly faster with a million or more points; about even on small scenes. Costs 32 bytes per point of GPU memory.', (on) => { S.sortP = on; if (sim && sim.opt) sim.opt.sort = on; }, dv('sortP'));
      addCheck(su, 'c-ballistic', 'Fast drops fly free', S.ballistic, 'A drop on its own that moves fast leaves the grid and flies by itself (gravity, air, objects, walls) in its own small steps, until it reaches water again. The grid then takes its substeps from the water that is still together, not from the fastest flying drop, so splashes and impacts simulate much faster. Drops in flight move almost exactly as before.', (on) => { S.ballistic = on; if (sim && sim.opt) sim.opt.ballistic = on; }, dv('ballistic'));
      addCheck(su, 'c-settle', 'Settled water skips pressure', S.settle, 'Water whose pressure from the last step still holds (calm deep water, mostly) is left out of the pressure solve and keeps its pressure; it is checked again every step and joins in when the water there changes. Experimental: an impact needs the pressure of the whole body of water to change at once, but settled water only rejoins cell by cell, so it holds its old pressure and the water squeezes instead of splashing (impacts lose almost all their spray). Saves little time.', (on) => { S.settle = on; if (sim && sim.opt) sim.opt.settle = on; }, dv('settle'));
      addCheck(su, 'c-mg', 'Multigrid pressure', S.mg, 'Solves the pressure on coarser and coarser grids as well as the fine one, so it reaches deep water: without it, at fine spacings deep water is left part-solved and gives a little under impacts (then springs back). Uses about a third less work for a pressure many times closer to exact in deep water; about the same in shallow scenes. The water can move differently (splashes out of deep water stand taller).', (on) => { S.mg = on; if (sim && sim.opt) sim.opt.mg = on; }, dv('mg'));
      addCheck(su, 'c-p2gwin', 'Grouped transfer', S.p2gWin, 'Particles hand their velocity to the grid, and read it back, through a small patch of the grid kept in fast workgroup memory, instead of each particle going to the grid on its own. Exactly the same result. Needs Sort particles on to help. Whether it is faster depends on the GPU: the Solver benchmark compares both (row G) on this computer.', (on) => { S.p2gWin = on; if (sim && sim.opt) sim.opt.p2gWin = on; }, dv('p2gWin'));
    }
    if (searching) filterPanel($('#psearch').value);
  }

  const gd = $('#g-disp');
  addSelect(gd, 'd-colby', 'Colour by', [['speed', 'Speed'], ['type', 'Type']], S.colorBy, 'Speed: blue to cyan to white as the water speeds up, churned water white. Type: one colour per kind of point: water blue, churned water pale blue, foam white, spray orange, mist lilac, bubbles green, deep water (narrow band) dark blue.', (v) => setColorBy(v));
  addSlider(gd, { id: 'd-size', label: 'Point size', min: 0.3, max: 1.6, step: 0.05, value: S.psize, def: dv('psize'), fmt: (v) => v.toFixed(2) + '×', tip: 'How big each point is drawn, compared with the particle spacing.', onInput: (v) => { S.psize = v; } });
  addSlider(gd, { id: 'd-vmax', label: 'White at', min: 1, max: 12, step: 0.5, value: S.vmax, def: dv('vmax'), fmt: (v) => v.toFixed(1) + ' m/s', tip: 'The speed that is coloured white. Slower water runs from blue to cyan.', onInput: (v) => { S.vmax = v; pmat.uniforms.uMax.value = v; } });
  addSlider(gd, { id: 'd-foam', label: 'White water', min: 0, max: 1, step: 0.05, value: S.foam, def: dv('foam'), fmt: (v) => v === 0 ? 'off' : v.toFixed(2), tip: 'How strongly churned water is drawn white.', onInput: (v) => { S.foam = v; pmat.uniforms.uFoam.value = v; } });
  addCheck(gd, 'c-gizmo', 'Transform gizmo', S.gizmo, 'Arrows move along an axis, rings rotate, small cubes scale, the centre ball moves freely. Hold V while moving to snap to points.', (on) => { setTool(on ? 'transform' : 'select'); $('#c-gizmo').blur(); }, false);
  addCheck(gd, 'c-literun', 'Lighter while running', S.liteRun, 'While the live sim runs, draws each point once, without the look-only extra points, so the GPU has more time for the sim. The full look comes back when it stops, and in bakes. Drawing only.', (on) => { S.liteRun = on; }, true);
  {   // water as points or as a smooth surface (renderView in 02-viewport.js)
    const r = document.createElement('div'); r.className = 'row plain';
    r.innerHTML = '<label data-tip="Points draws every water point. Surface melts them into one smooth, shaded surface with sky reflections, like a mesh but made on the fly each frame (whitewater stays as points). Drawing only: the simulation is the same.">Draw water</label><div class="seg" id="seg-surf" role="group" aria-label="Draw water"><button type="button" data-v="0">Points</button><button type="button" data-v="1">Surface</button></div>';
    gd.appendChild(r); setSeg($('#seg-surf'), S.surface ? '1' : '0'); seg('#seg-surf', (v) => { S.surface = v === '1'; r.classList.toggle('nd', S.surface); lastGen = -1; });
    addCheck(gd, 'c-surfaniso', 'Surface shapes', S.surfAniso, 'With Draw water: Surface, points at the surface are drawn flattened along it, so they melt into a smooth skin and thin sheets look like sheets, while drops in the air stay round. Off draws every point round. Drawing only.', (on) => { S.surfAniso = on; }, true);
    addSlider(gd, { id: 'd-surfsm', label: 'Surface smoothing', min: 0.3, max: 3, step: 0.05, value: S.surfSmooth, def: dv('surfSmooth'), fmt: (v) => v.toFixed(2) + '×', tip: 'How far the surface is smoothed, compared with the point size. More melts small bumps and drops into the surface; less keeps detail. Only with Draw water: Surface.', onInput: (v) => { S.surfSmooth = v; } });
  }
  {   // how a bake plays back: Full always draws everything; Smooth drops look-only points while frames come late; Fast always drops them
    const r = document.createElement('div'); r.className = 'row plain';
    r.innerHTML = '<label data-tip="Full draws everything while a bake plays. Smooth (auto) keeps playback at the frame rate: when frames come late it draws fewer look-only points, and the full look comes back when it is paused or keeps up again. Fast always draws each point once while a bake plays. Drawing only.">Bake playback</label><div class="seg" id="seg-pbq" role="group" aria-label="Bake playback"><button type="button" data-v="full">Full</button><button type="button" data-v="smooth">Smooth (auto)</button><button type="button" data-v="fast">Fast</button></div>';
    gd.appendChild(r); setSeg($('#seg-pbq'), S.pbQ); seg('#seg-pbq', (v) => { S.pbQ = v; S.pbLvl = 0; r.classList.toggle('nd', v !== dv('pbQ')); });
  }
  addCheck(gd, 'c-hidein', 'Skip buried water', S.hideIn, 'Bakes mark the water points that lie three cells or more inside the water, where no view can see them, and these are not drawn. Dense bakes draw much faster. Drawing only.', (on) => { S.hideIn = on; }, true);
  addCheck(gd, 'c-oview', 'Ocean around box', S.oceanView, 'With the ocean on, draws its surface over the boundary and out past the box, so the box sits in open sea. Drawing only.', (on) => { S.oceanView = on; }, true);
  addSlider(gd, { id: 'd-sprdetail', label: 'Spray detail', min: 0, max: 12, step: 1, value: S.sprDetail, def: dv('sprDetail'), fmt: (v) => (v === 0 ? 'off' : '×' + (v + 1)), tip: 'Extra look-only points drawn around each spray and mist point, so spray looks denser. Drawing only.', onInput: (v) => { S.sprDetail = v; lastGen = -1; } });
  addSlider(gd, { id: 'd-streak', label: 'Spray streaks', min: 0, max: 0.1, step: 0.005, value: S.streak, def: dv('streak'), fmt: (v) => (v === 0 ? 'off' : Math.round(v * 1000) + ' ms'), tip: 'Draws fast spray as short streaks along its motion, like a camera shutter of this length.', onInput: (v) => { S.streak = v; lastGen = -1; } });
  seg('#seg-detail', (v) => { S.detail = +v; lastGen = -1; });
  seg('#seg-bg', (v) => {
    S.bg = v; stage.classList.toggle('black', v === 'black'); stage.classList.toggle('light', v === 'light');
    const grey = v === 'light';   // dark lines on the light background, light lines on the dark ones
    lineMat.color.setHex(grey ? 0x2b333b : 0x8a949e); lineMat.opacity = grey ? 0.55 : 0.5;
    gridMat.color.setHex(grey ? 0x2b333b : 0x8a949e); gridMat.opacity = grey ? 0.22 : 0.2;
  });

  // bake group, rebuilt when the engine changes
  const gb = $('#g-bake'); const bakeAnchor = $('#bake-est');
  const bakeHolder = document.createElement('div'); bakeHolder.className = 'params'; gb.insertBefore(bakeHolder, bakeAnchor);
  function buildBakeUI() {
    bakeHolder.innerHTML = '';
    addSlider(bakeHolder, { id: 'b-dur', label: 'Duration', min: 1, max: 60, step: 0.5, value: S.bk.dur, fmt: (v) => v.toFixed(1) + ' s', tip: 'Length of the bake. The same as the timeline length.', onInput: (v) => { setDur(v); } });
    const fpsRow = document.createElement('div'); fpsRow.className = 'row plain';
    fpsRow.innerHTML = '<label data-tip="Frames stored per second of the bake.">Frame rate</label><div class="seg" id="seg-fps" role="group" aria-label="Frame rate"><button type="button" data-v="24" aria-pressed="' + (S.bk.fps === 24) + '">24</button><button type="button" data-v="30" aria-pressed="' + (S.bk.fps === 30) + '">30</button><button type="button" data-v="60" aria-pressed="' + (S.bk.fps === 60) + '">60</button></div>';
    bakeHolder.appendChild(fpsRow);
    seg('#seg-fps', (v) => { S.bk.fps = +v; updateEst(); });
    const dRow = document.createElement('div'); dRow.className = 'row plain';
    dRow.innerHTML = '<label data-tip="Preview bakes exactly what you see in the live view (the live spacing), quickly. Final and Fine divide the spacing by 1.5 and 2 and raise Max points to match, for a more detailed bake of the same scene (about 4 and 10 times the time).">Quality</label><div class="seg" id="seg-bkdetail" role="group" aria-label="Bake quality"><button type="button" data-v="1">Preview</button><button type="button" data-v="1.5">Final</button><button type="button" data-v="2">Fine</button></div>';
    bakeHolder.appendChild(dRow); setSeg($('#seg-bkdetail'), S.bkDetail);
    seg('#seg-bkdetail', (v) => { S.bkDetail = +v; updateEst(); });
    const ri = document.createElement('div'); ri.className = 'pos'; ri.id = 'bake-res'; bakeHolder.appendChild(ri);
    updateEst();
  }
  function setEngine(eng) {
    if (S.baking) return;
    applyPreset(eng); buildLiveUI(); buildBakeUI(); makeSim(); $('#capshow').textContent = fmtN(S.cap);
    resetSim(S.tl.t);
  }

  // box size and open faces
  const gbx = $('#g-box');
  function commitBox() { makeSim(); resetSim(S.tl.t); updateDomainViz(); renderUI(); updateEst(); buildBoxUI(); }
  // move one face of the box (world coordinate v), keeping the box between 0.6 and 14 m
  // the box size and what it costs at the live spacing: grid cells, and points to fill it a third deep (narrow band: one band-deep layer)
  function boxSizeText() {
    const c = gridCost(S.liveD, S.cellRatio, S.cap), d3 = S.liveD ** 3;
    let n = S.dom.w * S.dom.d * S.dom.h / 3 / d3;
    if (nbActive()) n = Math.min(n, S.dom.w * S.dom.d * S.nbBand * S.liveD * S.cellRatio / d3);
    const over = n > S.cap;
    return 'size <b>' + S.dom.w.toFixed(2) + '</b> × <b>' + S.dom.h.toFixed(2) + '</b> × <b>' + S.dom.d.toFixed(2) + '</b> m. Changing the box restarts the particles.<br>' +
      'At spacing ' + S.liveD.toFixed(3) + ': grid ' + c.nx + ' × ' + c.ny + ' × ' + c.nz + ' (' + (c.ncell / 1e6).toFixed(1) + 'M cells); water a third deep is about <b' + (over ? ' class="warn"' : '') + '>' + fmtN(Math.round(n)) + '</b> points' +
      (over ? ', more than Max points (' + fmtN(S.cap) + ')' : '') + '. The solver\'s time grows with the number of points.';
  }
  function setFaceCoord(k, v) {
    const B = { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1 }, lo = k.endsWith('0');
    const other = B[lo ? k[0] + '1' : k[0] + '0'];
    B[k] = lo ? clamp(v, other - 14, other - 0.6) : clamp(v, other + 0.6, other + 14);
    S.min = { x: B.x0, y: B.y0, z: B.z0 }; S.dom = { w: B.x1 - B.x0, h: B.y1 - B.y0, d: B.z1 - B.z0 };
    updateDomainViz(); const bs = $('#box-size'); if (bs) bs.innerHTML = boxSizeText();
  }
  function setDomain(w, h, d) {
    S.dom = { w, h, d }; S.min = { x: -w / 2, y: 0, z: -d / 2 }; updateDomainViz();
    for (const o of objs) if (o.kind === 'emitter') { clampEm(o, o.target); o.pos.copy(o.target); syncMesh(o); }
    cam.target.set(S.org.x, S.org.y + (Hh > 3.5 ? Hh * 0.46 : Hh * 0.27), S.org.z); cam.r = clamp(2.1 * Math.max(W, Dd, Hh * 1.1), 3, 24); updateCam();
    commitBox();
  }
  const FACE_ROWS = [['x0', 'Left (-X)'], ['x1', 'Right (+X)'], ['y0', 'Floor'], ['y1', 'Top'], ['z0', 'Back (-Z)'], ['z1', 'Front (+Z)']];
  function buildBoxUI() {
    gbx.querySelectorAll(':scope > :not(h2)').forEach((n) => n.remove());
    gbx.querySelector('h2').dataset.tip = 'Drag the coloured arrows on the box in the view, or type a position for each face. Tick Open to delete particles that cross that face.';
    FACE_ROWS.forEach(([k, lab]) => {
      const row = document.createElement('div'); row.className = 'row face';
      row.innerHTML = '<label for="face-' + k + '">' + lab + '</label><input type="number" id="face-' + k + '" step="0.1" value="' + (+b[k].toFixed(3)) + '"><label class="check"><input type="checkbox" id="open-' + k + '"' + (S.open[k] ? ' checked' : '') + '><span>Open</span></label>';
      row.querySelector('input[type=number]').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { setFaceCoord(k, v); commitBox(); } else e.target.value = +b[k].toFixed(3); });
      row.querySelector('input[type=checkbox]').addEventListener('change', (e) => { S.open[k] = e.target.checked; applyOpen(); updateDomainViz(); });
      gbx.appendChild(row);
    });
    const sz = document.createElement('div'); sz.className = 'pos'; sz.id = 'box-size';
    sz.innerHTML = boxSizeText(); gbx.appendChild(sz);
    const fr = document.createElement('div'); fr.className = 'row face';
    fr.innerHTML = '<label for="fill-h">Fill tank</label><input type="number" id="fill-h" step="0.1" value="' + (+Math.min(1, S.dom.h * 0.4).toFixed(2)) + '"><button type="button" class="btn flat" id="btn-filltank">to height</button>';
    fr.querySelector('button').addEventListener('click', () => {
      const h = Math.max(0.1, Math.min(S.dom.h, parseFloat(fr.querySelector('input').value) || 1)); pushUndo();
      const o = makeObj('cube', { water: true, name: 'Tank water', x: (b.x0 + b.x1) / 2, y: b.y0 + h / 2, z: (b.z0 + b.z1) / 2, hx: S.dom.w / 2 - 0.02, hy: h / 2, hz: S.dom.d / 2 - 0.02 });
      select(o); fillNow(o);
    });
    gbx.appendChild(fr);
    const AREA = [['1', 'Tank only'], ['1.5', '1.5 × tank'], ['2', '2 × tank'], ['3', '3 × tank'], ['4', '4 × tank']];
    addSelect(gbx, 'ww-area', 'Whitewater area', AREA, String(S.wwArea), 'Spray, mist and foam may fly on past the tank walls, up to this many times the tank\'s width and depth (the dashed box). The water itself stays in the tank. A bigger area costs almost nothing.',
      (v) => { S.wwArea = +v; updateDomainViz(); buildBoxUI(); }).classList.toggle('nd', S.wwArea !== dv('wwArea'));
    addSelect(gbx, 'ww-area-up', 'Spray height', AREA.map(([v, l]) => [v, v === '1' ? 'Tank top' : l.replace('tank', 'height')]), String(S.wwAreaUp), 'How high spray may fly above the tank floor, in tank heights.',
      (v) => { S.wwAreaUp = +v; updateDomainViz(); buildBoxUI(); }).classList.toggle('nd', S.wwAreaUp !== dv('wwAreaUp'));
    const hl = document.createElement('label'); hl.className = 'check';
    hl.innerHTML = '<input type="checkbox" id="show-handles"' + (S.handles ? ' checked' : '') + '><span>Show face arrows</span>';
    hl.querySelector('input').addEventListener('change', (e) => { S.handles = e.target.checked; });
    gbx.appendChild(hl);
  }
  buildBoxUI();

  // what the bake uses: the shared Simulation settings, optionally finer. Substep limits are per 1/60 s in the live view, so they are converted to the bake frame rate.
  function bakeRes() {
    const P = PRESET[S.engine], f = S.bkDetail || 1, fps = S.bk.fps || 24, k = 60 / fps;
    const d = +(S.liveD / f).toFixed(4);
    const maxN = Math.round(Math.min(S.cap * f * f * f, Math.max(P.bkMax, S.cap)));
    const lo = Math.max(1, S.subMin | 0), hi = Math.max(lo, S.subMax | 0);
    return { d, maxN, sub: Math.max(1, Math.ceil(lo * k * (S.engine === 'flip' ? 1 : f) - 1e-9)), maxSub: Math.max(1, Math.ceil(hi * k * f - 1e-9)), iters: S.iters };
  }
  function estimate() {
    const bk = Object.assign({}, S.bk, bakeRes()), d3 = bk.d * bk.d * bk.d;
    let fill = 0;
    for (const f of resolveFills()) fill += f.t === 'box' ? (f.x1 - f.x0) * (f.y1 - f.y0) * (f.z1 - f.z0) : f.t === 'vol' ? (f.hi[0] - f.lo[0]) * (f.hi[1] - f.lo[1]) * (f.hi[2] - f.lo[2]) * (f.sdf.fillFrac || 0.6) : (4 / 3) * Math.PI * f.r ** 3;
    for (const e of S.events) fill += (4 / 3) * Math.PI * e.r ** 3;
    let flow = 0;
    for (const o of objs) if (o.kind === 'emitter' && o.on) flow += Math.PI * o.radius * o.radius * Math.max(o.speed, 0.3) * (o.mode === 'random' ? o.density : 0.85);
    if (S.ocean.on && S.engine === 'flip') fill += S.dom.w * S.dom.d * S.ocean.level * S.dom.h;
    let n0 = fill / d3;
    if (nbActive()) n0 = Math.min(n0, S.dom.w * S.dom.d * S.nbBand * bk.d * S.cellRatio / d3 * 1.35);   // narrow band: about one band-deep layer across the box, plus spare slots
    const n1 = n0 + (flow * bk.dur) / d3;
    const frames = Math.round(bk.dur * bk.fps);
    const capped = Math.min(n1, bk.maxN);
    const bytes = frames * ((n0 + capped) / 2) * 7;
    return { n0, n1, capped, frames, mb: bytes / 1048576, steps: frames * bk.sub, over: n1 > bk.maxN };
  }
  function updateEst() {
    const e = estimate(); const el = $('#bake-est');
    const br = $('#bake-res'); if (br) { const r = bakeRes(), c = isGpu() ? gridCost(r.d, S.cellRatio, r.maxN) : null, bad = c && c.biggest > (S.gpu ? S.gpu.maxBuf : 1 << 27);
      br.innerHTML = 'Spacing <b>' + r.d.toFixed(3) + ' m</b>, max <b>' + fmtN(r.maxN) + '</b> points, ' + (S.engine === 'flip' ? r.sub + ' to ' + r.maxSub + ' substeps' : r.sub + ' substeps') + ' a frame, ' + r.iters + ' iterations.' + (bad ? ' TOO BIG for this GPU: pick less detail or lower Max points.' : '') + (nbActive() ? ' Narrow band: particles only in the band under the surface.' : '');
      br.classList.toggle('warn', !!bad); }
    el.classList.toggle('warn', e.over);
    el.innerHTML = 'About <b>' + fmtN(Math.round(e.capped)) + '</b> points, <b>' + e.frames + '</b> frames, <b>' + e.steps + '</b> solver steps, cache around <b>' + e.mb.toFixed(0) + ' MB</b>.' +
      (e.over ? '<br>This scene would reach ' + fmtN(Math.round(e.n1)) + ' points. Emission stops when Max points is full.' : '');
  }

