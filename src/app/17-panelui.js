  // ---------- panel: collapsible groups, tooltips, right-click menu, search, status bar ----------
  const panelEl = $('.panel');
  // every group header folds its group; the choice is remembered in this browser
  const GROUP_CLOSED = ['g-native'];   // with the properties split into tabs, most panels start open
  function setGroupOpen(g, open) { g.classList.toggle('closed', !open); const h2 = g.querySelector(':scope > h2'); if (h2) h2.setAttribute('aria-expanded', String(open)); }
  panelEl.querySelectorAll('.group').forEach((g) => {
    const h2 = g.querySelector(':scope > h2'); if (!h2 || !g.id) return;
    h2.tabIndex = 0; h2.setAttribute('role', 'button');
    const st = lsGet('grp.' + g.id); setGroupOpen(g, st === null ? !GROUP_CLOSED.includes(g.id) : st === '1');
    const tog = () => { if (searching) return; const open = g.classList.contains('closed'); setGroupOpen(g, open); lsSet('grp.' + g.id, open ? '1' : '0'); };
    h2.addEventListener('click', tog);
    h2.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); tog(); } });
  });

  // tooltips: hover anything with data-tip; slider rows add their default and range
  const tipEl = $('#tip'); let tipT = 0, tipFor = null;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function hideTip() { clearTimeout(tipT); tipT = 0; tipEl.hidden = true; }
  function showTip(el) {
    if (!el.isConnected) return;
    const row = el.closest('.row'), st = row && row._st && row.contains(el) && el.tagName === 'LABEL' ? row._st : null;
    const title = el.dataset.tipTitle || (st ? st.label : el.textContent.replace(/\s+/g, ' ').trim());
    let s = '<b>' + esc(title) + '</b>';
    if (el.dataset.tip) s += '<div>' + esc(el.dataset.tip) + '</div>';
    if (st) s += '<div class="tk">' + (st.def !== undefined ? 'Default ' + esc(st.fmt(st.def)) + ' · ' : '') + 'range ' + esc(st.fmt(st.min)) + ' to ' + esc(st.fmt(st.max)) + '</div><div class="tk">Drag sideways to change, click to type · right-click to reset or copy</div>';
    if (!el.dataset.tip && !st) return;
    tipEl.innerHTML = s; tipEl.hidden = false;
    const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    let x = r.left, y = r.bottom + 6;
    if (panelEl.contains(el)) { x = panelEl.getBoundingClientRect().left - w - 10; y = r.top - 4; if (x < 4) { x = r.left; y = r.bottom + 6; } }
    tipEl.style.left = clamp(x, 4, innerWidth - w - 4) + 'px'; tipEl.style.top = clamp(y, 4, innerHeight - hh - 4) + 'px';
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el === tipFor) return;
    hideTip(); tipFor = el;
    if (el) tipT = setTimeout(() => showTip(el), 450);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('wheel', hideTip, { passive: true, capture: true });
  panelEl.addEventListener('scroll', hideTip, { passive: true });

  // which setting the mouse is over (Backspace resets it, Ctrl+C / Ctrl+V copy and paste, like Blender)
  panelEl.addEventListener('mouseover', (e) => { const r = e.target.closest('.row'); const h = r && r._st ? r : null; if (h !== hoverRow) { hoverRow = h; updStatus(); } });
  panelEl.addEventListener('mouseleave', () => { if (hoverRow) { hoverRow = null; updStatus(); } });
  function resetRow(row) { const st = row._st; if (st.def === undefined) return; st.commit(st.def); flash(st.label + ' reset to ' + st.fmt(st.def)); }
  function copyRow(row) { const st = row._st, v = st.get(); clipVal = v; try { navigator.clipboard.writeText(String(v)).catch(() => {}); } catch (e) { /* no clipboard here */ } flash('Copied ' + st.label + ' ' + st.fmt(v)); }
  function pasteRow(row) { if (clipVal === null) { flash('Nothing copied yet'); return; } row._st.commit(clipVal); flash(row._st.label + ' set to ' + row._st.fmt(row._st.get())); }

  const ctxEl = $('#ctx'); let ctxRow = null;
  function closeCtx() { ctxEl.hidden = true; ctxRow = null; }
  function openCtx(row, x, y) {
    ctxRow = row; const st = row._st, v = st.get();
    const atDef = st.def === undefined || Math.abs(v - st.def) < 1e-9;
    ctxEl.innerHTML = '<button type="button" data-a="reset"' + (atDef ? ' disabled' : '') + '>Reset to default' + (st.def !== undefined ? ' (' + esc(st.fmt(st.def)) + ')' : '') + '<span>Backspace</span></button>' +
      '<button type="button" data-a="type">Type a value<span>click value</span></button><hr>' +
      '<button type="button" data-a="copy">Copy value<span>Ctrl C</span></button>' +
      '<button type="button" data-a="paste"' + (clipVal === null ? ' disabled' : '') + '>Paste value' + (clipVal === null ? '' : ' (' + esc(+clipVal.toFixed(4)) + ')') + '<span>Ctrl V</span></button>';
    ctxEl.hidden = false;
    const w = ctxEl.offsetWidth, hh = ctxEl.offsetHeight;
    ctxEl.style.left = clamp(x, 4, innerWidth - w - 4) + 'px'; ctxEl.style.top = clamp(y, 4, innerHeight - hh - 4) + 'px';
    const f = ctxEl.querySelector('button:not(:disabled)'); if (f) f.focus({ preventScroll: true });
  }
  panelEl.addEventListener('contextmenu', (e) => { const row = e.target.closest('.row'); if (!row || !row._st) return; e.preventDefault(); hideTip(); openCtx(row, e.clientX, e.clientY); });
  ctxEl.addEventListener('click', (e) => {
    const bt = e.target.closest('button'); if (!bt || bt.disabled || !ctxRow) return;
    const row = ctxRow, a = bt.dataset.a; closeCtx();
    if (a === 'reset') resetRow(row); else if (a === 'copy') copyRow(row); else if (a === 'paste') pasteRow(row); else if (a === 'type') row._st.type();
  });
  ctxEl.addEventListener('keydown', (e) => {
    const its = [...ctxEl.querySelectorAll('button:not(:disabled)')], i = its.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (its.length) its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCtx(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!ctxEl.hidden && !ctxEl.contains(e.target)) closeCtx(); }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F3') { e.preventDefault(); const s = $('#psearch'); s.focus(); s.select(); return; }
    if (!hoverRow || !hoverRow.isConnected || typing() || tf || !ctxEl.hidden) return;
    const K = e.key.toLowerCase();
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); resetRow(hoverRow); }
    else if ((e.ctrlKey || e.metaKey) && K === 'c') { e.preventDefault(); e.stopImmediatePropagation(); copyRow(hoverRow); }
    else if ((e.ctrlKey || e.metaKey) && K === 'v') { e.preventDefault(); e.stopImmediatePropagation(); pasteRow(hoverRow); }
  }, true);

  // search the settings by name: matching rows stay, their panels open, everything else hides
  const psearch = $('#psearch');
  function filterPanel(q) {
    q = (q || '').trim().toLowerCase();
    const was = searching; searching = !!q;
    panelEl.classList.toggle('searching', searching);
    const items = panelEl.querySelectorAll('.group .row, .group label.check');
    const subs = panelEl.querySelectorAll('details.sub'), groups = panelEl.querySelectorAll('.group');
    if (!searching) {
      items.forEach((it) => it.classList.remove('sx')); groups.forEach((g) => g.classList.remove('sx')); subs.forEach((d) => d.classList.remove('sx'));
      if (was) {
        subs.forEach((d) => { if (d.dataset.prev !== undefined) { d.open = d.dataset.prev === '1'; delete d.dataset.prev; } });
        groups.forEach((g) => { if (g.dataset.prevClosed !== undefined) { setGroupOpen(g, g.dataset.prevClosed !== '1'); delete g.dataset.prevClosed; } });
      }
      const none = $('#psearch-none'); if (none) none.remove();
      return;
    }
    let hits = 0;
    items.forEach((it) => {
      const lab = it.querySelector('label') || it, txt = (it.matches('label') ? it.textContent : lab.textContent).toLowerCase();
      const ok = txt.includes(q); it.classList.toggle('sx', !ok); if (ok) hits++;
    });
    // a panel whose own name matches shows all of its settings
    const heads = [...subs].map((d) => [d, d.querySelector(':scope > summary')]).concat([...groups].map((g) => [g, g.querySelector(':scope > h2')]));
    heads.forEach(([c, hd]) => { if (hd && hd.textContent.toLowerCase().includes(q)) c.querySelectorAll('.row, label.check').forEach((it) => { if (it.classList.contains('sx')) { it.classList.remove('sx'); hits++; } }); });
    subs.forEach((d) => {
      const any = [...d.querySelectorAll('.row, label.check')].some((it) => !it.classList.contains('sx'));
      d.classList.toggle('sx', !any);
      if (any) { if (d.dataset.prev === undefined) d.dataset.prev = d.open ? '1' : '0'; d.open = true; }
    });
    groups.forEach((g) => {
      const any = [...g.querySelectorAll('.row, label.check')].some((it) => !it.classList.contains('sx'));
      g.classList.toggle('sx', !any);
      if (any && g.classList.contains('closed')) { if (g.dataset.prevClosed === undefined) g.dataset.prevClosed = '1'; setGroupOpen(g, true); }
    });
    let none = $('#psearch-none');
    if (!hits) { if (!none) { none = document.createElement('div'); none.id = 'psearch-none'; none.className = 'psearch-none'; psearch.parentNode.after(none); } none.textContent = 'No setting called "' + q + '".'; }
    else if (none) none.remove();
  }
  psearch.addEventListener('input', () => filterPanel(psearch.value));
  psearch.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { psearch.value = ''; filterPanel(''); psearch.blur(); } });

  // status bar: what the mouse and keys do right now (Blender shows this along the bottom)
  function updStatus() {
    const el = $('#st-hints'); if (!el) return;
    let h;
    if (hoverRow) h = [['Drag', 'change'], ['Click value', 'type'], ['Backspace', 'reset'], ['Ctrl C', 'copy'], ['Ctrl V', 'paste'], ['Right-click', 'more']];
    else if (viewMode() === 'cache') h = [['Space', 'play or pause'], ['Drag timeline', 'scrub'], ['MMB', 'orbit'], ['Shift MMB', 'pan'], ['Wheel', 'zoom'], ['F3', 'search settings']];
    else if (tf) h = [['X Y Z', 'axis (twice: ' + (S.orient === 'local' ? 'global' : 'local') + ')'], ['Shift+axis', 'plane'], ['Ctrl', S.snapOn ? 'no snapping' : 'snap'], ['V', 'snap to points'], ['0–9', 'type a value'], ['LMB/Enter', 'confirm'], ['RMB/Esc', 'cancel']];
    else if (uiMode === 'edit') h = [['1 2 3', 'points, edges, faces'], ['G R S', 'move, rotate, scale'], ['E', 'extrude'], ['A', 'select all'], ['Tab', 'back to objects']];
    else if (selSet.size) h = [['G R S', 'move, rotate, scale'], ['Shift D', 'duplicate'], ['X', 'delete'], ['I', 'keyframe']].concat(selected && selected.kind === 'mesh' ? [['Tab', 'edit shape']] : []).concat([['F', 'focus'], ['Shift A', 'add'], ['Space', S.playing ? 'stop' : 'start']]);
    else h = [['LMB', 'select'], ['Drag', 'box select'], ['MMB', 'orbit'], ['Shift MMB', 'pan'], ['Wheel', 'zoom'], ['Shift A', 'add'], ['F3', 'search settings'], ['Space', S.playing ? 'stop' : 'start']];
    const s = h.map(([k, t]) => '<span class="h"><kbd>' + k + '</kbd>' + t + '</span>').join('');
    if (el._s !== s) { el._s = s; el.innerHTML = s; }
  }

  window.__errLog = window.__errLog || [];
  window.addEventListener('error', (e) => window.__errLog.push({ t: new Date().toISOString(), msg: 'Page: ' + e.message + ' at ' + (e.filename || '').split('/').pop() + ':' + e.lineno }));
  window.addEventListener('unhandledrejection', (e) => window.__errLog.push({ t: new Date().toISOString(), msg: 'Page: ' + (e.reason && e.reason.stack ? e.reason.stack : e.reason) }));
  // shared source for the worker comes from the page's own script
  sharedSrc = document.getElementById('shared').textContent;
  resize(); updateCam();

