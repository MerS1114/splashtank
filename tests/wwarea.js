// Whitewater area: runs Meteor lake live at 0.08 for a while, counts whitewater past the tank walls (it should fly on up to the
// dashed box) and saves a screenshot; checks per-frame compact boxes (compactFrameBox) decode to the same points and survive a cache file.
const { open, wait, done } = require('./lib');
(async () => {
  const t = await open('Meteor lake', { spacing: 0.08 });
  console.log('area', JSON.stringify(await t.ev(() => { const s = window.__splash; return { k: s.S.wwArea, up: s.S.wwAreaUp }; })));
  await t.ev(() => document.querySelector('#btn-play').click());
  let most = 0;
  for (let k = 0; k < 8; k++) {
    await wait(7000);
    const r = await t.ev(() => {
      const s = window.__splash, fr = s.getSim().outFrame, b = s.getSim().b; if (!fr || !fr.sp) return null;
      const sb = fr.sb || b; let out = 0, up = 0;
      for (let i = 0; i < fr.sp.n; i++) {
        const x = sb.x0 + fr.sp.pos[i * 3] / 65535 * (sb.x1 - sb.x0), y = sb.y0 + fr.sp.pos[i * 3 + 1] / 65535 * (sb.y1 - sb.y0), z = sb.z0 + fr.sp.pos[i * 3 + 2] / 65535 * (sb.z1 - sb.z0);
        if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) out++; if (y > b.y1) up++;
      }
      return { simT: +s.S.tl.t.toFixed(2), whitewater: fr.sp.n, pastWalls: out, aboveTop: up };
    });
    console.log(JSON.stringify(r)); if (r) most = Math.max(most, r.pastWalls + r.aboveTop);
  }
  console.log('most whitewater outside the tank at once', most);
  await t.ev(() => document.querySelector('#btn-play').click()); await wait(1500);
  await t.shot('wwarea_live');
  console.log(JSON.stringify(await t.ev(() => {
    const s = window.__splash, fr = s.getSim().outFrame, b = s.getSim().b, d = 0.08;
    const c = compactFrameBox(Object.assign({}, fr, { objs: fr.objs || new Float32Array(0) }), b, d); if (!c) return { compactBox: null };
    let err = 0; for (let i = 0; i < fr.n; i += 7) { const p = framePoint(fr, b, i), q = framePoint(c, b, i); if (p[3] === 255) continue; err = Math.max(err, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])); }
    const parts = writeCacheParts({ d, fps: 24, ids: [], b, frames: [c], maxN: c.n, seconds: 1, engine: 'flip', scale: 1, spdMs: true, q: null });
    const blob = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0)); let o = 0; for (const p of parts) { blob.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o); o += p.byteLength; }
    const back = parseCache(blob.buffer).frames[0]; let err2 = 0;
    for (let i = 0; i < c.n; i += 7) { const p = framePoint(c, b, i), q = framePoint(back, b, i); err2 = Math.max(err2, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])); }
    return { box: c.b, q: c.q, maxErr: +err.toFixed(4), quarterSpacing: d / 4, fileErr: err2, fileBox: back.b, sb: back.sb || null };
  })));
  await done(t);
})();
