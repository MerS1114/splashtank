// Accuracy against known answers (FLIP, full depth, no colliders, whitewater off):
//   still  water at rest in a tank must stay at rest: speeds after 3 s (spurious currents) and the water's mean height (compression).
//   dam    a column a wide and 2a high let go at a wall (Martin and Moyce 1952): the front's distance from the wall Z = x/a against
//          T = t sqrt(2g/a), next to their measurements. The shallow-water (Ritter) front speed 2 sqrt(g 2a) is the upper bound.
//   slosh  a standing wave, surface A cos(pi x / L), in water h deep: the period against linear theory, w^2 = g k tanh(k h), and how
//          much of the height is left after each period (real water this size loses well under 1% a period; the rest is the solver).
// node tests/accuracy.js [cases "still,dam,slosh"] [spacing 0.0125] [js run in the page before each case, e.g. "S.airDrag=0"]
// Prints one line per case to compare runs. Uses the real GPU with SPLASH_GPU=1.
const { open, done } = require('./lib');
const CASES = (process.argv[2] || 'still,dam,slosh').split(','), SP = +(process.argv[3] || 0.0125), OV = process.argv[4] || '';
// Martin and Moyce (1952), n^2 = 2 (column twice as high as wide), as reprinted in the SPH and MPS literature
const MM = [[0.41, 1.11], [0.84, 1.22], [1.19, 1.44], [1.43, 1.67], [1.63, 1.89], [1.83, 2.11], [1.98, 2.33], [2.20, 2.56], [2.32, 2.78], [2.51, 3.00], [2.65, 3.22], [2.83, 3.44], [2.98, 3.67], [3.11, 3.89], [3.33, 4.11]];
const scene = (size, fills) => ({ app: 'SplashTank', version: 2, box: { size, open: {} }, solver: { engine: 'flip', nbOn: false, sprOn: false, airOn: false, dripOn: false, scale: 1, subMax: 16, vmaxW: 50, colMax: 100 }, fills, events: [], objs: [], timeline: { dur: 30, t: 0, auto: true, smooth: true, end: 'hold' } });
async function setup(sc) {
  const t = await open(null, {});
  await t.ev((d) => { window.__splash.applySceneData(d); }, sc);
  await t.pg.evaluate((d) => document.querySelector('#s-res').closest('.row')._st.commit(d), SP);
  await new Promise((r) => setTimeout(r, 1500));
  await t.pg.waitForFunction(() => { const s = window.__splash; return s && s.getSim() && s.getSim().ready !== false; }, { timeout: 180000 });
  await t.ev((OV) => { const s = window.__splash, S = s.S; S.sprOn = false; if (OV) eval(OV); const sim = s.getSim(); sim.opt.mg = S.mg; sim.opt.ballistic = S.ballistic; s.resetSim(0); }, OV);
  return t;
}
// page helpers: read every particle's position and velocity, step n frames
const PAGE = `window.__acc = {
  read: async () => { const s = window.__splash, sim = s.getSim(), n = sim.N, out = {};
    for (const [k, buf] of [['p', sim.bPos], ['v', sim.bVel]]) { const b = sim.dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = sim.dev.createCommandEncoder(); e.copyBufferToBuffer(buf, 0, b, 0, n * 16); sim.dev.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ); out[k] = new Float32Array(b.getMappedRange()).slice(); b.unmap(); b.destroy(); }
    out.n = n; out.b = sim.b; out.h = sim.h; out.d = sim.d; return out; },
  step: async (n) => { const s = window.__splash, sim = s.getSim(); let sub = 0; for (let f = 0; f < n; f++) { s.stepOnce(); sub = Math.max(sub, s.S.lastSub || 1); await sim.dev.queue.onSubmittedWorkDone(); } return sub; }
};`;
const f3 = (v) => (Math.round(v * 1000) / 1000).toString();
(async () => {
  for (const cs of CASES) {
    if (cs === 'still') {
      const t = await setup(scene({ w: 1, h: 1, d: 1 }, [{ t: 'box', fx0: 0, fx1: 1, y0: 0, y1: 0.5, fz0: 0, fz1: 1 }]));
      await t.ev(PAGE);
      const r = await t.ev(async () => {
        const A = window.__acc, mean = (q) => { let s = 0, c = 0; for (let i = 0; i < q.n; i++) if (q.p[i * 4 + 1] > -1e5) { s += q.p[i * 4 + 1]; c++; } return { y: s / c, c }; };
        const q0 = await A.read(); const m0 = mean(q0); await A.step(180); const q = await A.read(); const m = mean(q);
        const sp = []; for (let i = 0; i < q.n; i++) if (q.p[i * 4 + 1] > -1e5) sp.push(Math.hypot(q.v[i * 4], q.v[i * 4 + 1], q.v[i * 4 + 2])); sp.sort((a, b) => a - b);
        return { n: m.c, n0: m0.c, dy: (m.y - m0.y) / q.h, mean: sp.reduce((a, b) => a + b, 0) / sp.length, p99: sp[Math.floor(sp.length * 0.99)], max: sp[sp.length - 1], h: q.h };
      });
      console.log('still: after 3 s, speed mean ' + f3(r.mean) + ' m/s, 99% under ' + f3(r.p99) + ', max ' + f3(r.max) + '; mean height moved ' + f3(r.dy) + ' cells; particles ' + r.n0 + ' -> ' + r.n + ' (cell ' + r.h + ' m)');
      await t.shot('acc_still'); await done(t);
    } else if (cs === 'dam') {
      const a = 0.4, W = 2.4, H = 1.2, D = 0.24;
      const t = await setup(scene({ w: W, h: H, d: D }, [{ t: 'box', fx0: 0, fx1: a / W, y0: 0, y1: 2 * a, fz0: 0, fz1: 1 }]));
      await t.ev(PAGE);
      const r = await t.ev(async (a) => {
        const A = window.__acc, out = []; let sub = 0;
        for (let f = 1; f <= 40; f++) {
          sub = Math.max(sub, await A.step(1));
          if (f % 2) continue;
          const q = await A.read(), x0 = q.b.x0, xs = [];
          for (let i = 0; i < q.n; i++) { const y = q.p[i * 4 + 1]; if (y > -1e5 && y - q.b.y0 < 0.25 * a) xs.push(q.p[i * 4] - x0); }
          xs.sort((p, q2) => p - q2);
          out.push([f / 60 * Math.sqrt(2 * 9.8 / a), xs[Math.max(0, xs.length - 1 - Math.floor(xs.length * 0.002))] / a]);   // the front: all but the furthest 0.2% of the water near the floor
        }
        return { out, sub };
      }, a);
      const at = (T) => { for (let k = 1; k < MM.length; k++) if (T <= MM[k][0]) { const [t0, z0] = MM[k - 1], [t1, z1] = MM[k]; return z0 + (z1 - z0) * (T - t0) / (t1 - t0); } return null; };
      let err = 0, ne = 0; const pts = [];
      for (const [T, Z] of r.out) { const m = at(T); if (m !== null && T >= 0.8) { err += (Z - m) / m; ne++; } if (T > 0.6) pts.push('T' + T.toFixed(2) + ' ' + Z.toFixed(2) + (m !== null ? '/' + m.toFixed(2) : '')); }
      console.log('dam: front ahead of Martin and Moyce by ' + (100 * err / ne).toFixed(1) + '% on average (T 0.8-3.3), most substeps ' + r.sub);
      console.log('  Z sim/measured: ' + pts.join(', '));
      await t.shot('acc_dam'); await done(t);
    } else if (cs === 'volume') {
      // a dam break left to slosh for 10 s: the water must still fill the tank to the depth it started with (column area / tank length)
      const a = 0.4, W = 2.4, H = 1.2, D = 0.24, want = a * 2 * a / W;
      const t = await setup(scene({ w: W, h: H, d: D }, [{ t: 'box', fx0: 0, fx1: a / W, y0: 0, y1: 2 * a, fz0: 0, fz1: 1 }]));
      await t.ev(PAGE);
      const r = await t.ev(async () => {
        const A = window.__acc, sim = window.__splash.getSim(), out = [];
        const depth = (q) => { const h = q.h, b = q.b, nx = Math.ceil((b.x1 - b.x0) / h), nz = Math.ceil((b.z1 - b.z0) / h), top = new Float32Array(nx * nz).fill(0);
          for (let i = 0; i < q.n; i++) { const y = q.p[i * 4 + 1]; if (y < -1e5) continue; const ix = Math.floor((q.p[i * 4] - b.x0) / h), iz = Math.floor((q.p[i * 4 + 2] - b.z0) / h); if (ix >= 0 && ix < nx && iz >= 0 && iz < nz) top[ix * nz + iz] = Math.max(top[ix * nz + iz], y - b.y0 + q.d / 2); }
          let s = 0; for (const v of top) s += v; return s / top.length; };
        let sub = 0; for (let k = 1; k <= 5; k++) { sub = Math.max(sub, await A.step(120)); out.push(depth(await A.read())); }
        return { out, sub, cells: sim.stats && sim.stats.fluid };
      });
      console.log('volume: settled depth ' + r.out.map((v) => (100 * (v / want - 1)).toFixed(1) + '%').join(', ') + ' off the starting volume every 2 s (wants ' + f3(want) + ' m; the top particle sits about half a spacing under the surface), most substeps ' + r.sub);
      await t.shot('acc_volume'); await done(t);
    } else if (cs === 'slosh') {
      const L = 1, D = 0.2, hd = 0.5, Am = +(process.env.ACC_AMP || 0.08);
      const t = await setup(scene({ w: L, h: 1, d: D }, []));
      await t.ev(PAGE);
      const r = await t.ev(async (L, D, hd, Am) => {
        const s = window.__splash, sim = s.getSim(), A = window.__acc, d = sim.d, b = sim.b;
        sim.clear();
        for (let x = b.x0 + d / 2; x < b.x1; x += d) { const top = hd + Am * Math.cos(Math.PI * (x - b.x0) / L); for (let y = b.y0 + d / 2; y < b.y0 + top; y += d) for (let z = b.z0 + d / 2; z < b.z1; z += d) sim.add(x + (Math.random() - 0.5) * 0.02 * d, y, z + (Math.random() - 0.5) * 0.02 * d, 0, 0, 0); }
        // the surface height near each end wall: the mean of the highest particle per column within a fifth of L of the wall
        const surf = (q) => { const h = q.h, nx = Math.ceil(L / h), nz = Math.ceil(D / h), top = new Float32Array(nx * nz).fill(-1e9);
          for (let i = 0; i < q.n; i++) { const y = q.p[i * 4 + 1]; if (y < -1e5) continue; const ix = Math.floor((q.p[i * 4] - b.x0) / h), iz = Math.floor((q.p[i * 4 + 2] - b.z0) / h); if (ix >= 0 && ix < nx && iz >= 0 && iz < nz) top[ix * nz + iz] = Math.max(top[ix * nz + iz], y - b.y0); }
          let l = 0, r = 0, cl = 0, cr = 0; for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) { const v = top[ix * nz + iz]; if (v < -1e8) continue; if ((ix + 0.5) * h < 0.2 * L) { l += v; cl++; } else if ((ix + 0.5) * h > 0.8 * L) { r += v; cr++; } }
          return l / cl - r / cr; };
        const ts = [], ys = []; let sub = 0;
        for (let f = 0; f <= 300; f++) { if (f) sub = Math.max(sub, await A.step(1)); if (f % 2 === 0) { ts.push(f / 60); ys.push(surf(await A.read())); } }
        return { ts, ys, sub, h: sim.h };
      }, L, D, hd, Am);
      // period from the zero crossings, decay from the heights of successive peaks of the left-right difference
      const zc = []; for (let k = 1; k < r.ys.length; k++) if ((r.ys[k - 1] > 0) !== (r.ys[k] > 0)) zc.push(r.ts[k - 1] + (r.ts[k] - r.ts[k - 1]) * r.ys[k - 1] / (r.ys[k - 1] - r.ys[k]));
      const per = zc.length > 2 ? 2 * (zc[zc.length - 1] - zc[0]) / (zc.length - 1) : NaN;
      const pk = []; let lo = 0; for (let k = 0; k < zc.length - 1; k++) { let m = 0; for (let j = 0; j < r.ts.length; j++) if (r.ts[j] > zc[k] && r.ts[j] < zc[k + 1]) m = Math.max(m, Math.abs(r.ys[j])); pk.push(m); }
      // the starting difference from the shape itself (particles added are only uploaded with the first step): 2A sin(0.2 pi) / (0.2 pi)
      const first = 2 * Am * Math.sin(0.2 * Math.PI) / (0.2 * Math.PI), k = Math.PI / L, w = Math.sqrt(9.8 * k * Math.tanh(k * hd)), Tth = 2 * Math.PI / w;
      const left = pk.length ? pk[pk.length - 1] / Math.abs(first) : NaN, nper = (r.ts[r.ts.length - 1]) / per;
      console.log('slosh: period ' + f3(per) + ' s against ' + f3(Tth) + ' s from theory (' + (100 * (per / Tth - 1)).toFixed(1) + '%); height left after ' + nper.toFixed(1) + ' periods ' + (100 * left).toFixed(0) + '% (' + (100 * (1 - Math.pow(left, 1 / Math.max(nper - 0.5, 1)))).toFixed(1) + '% lost a period); most substeps ' + r.sub + ', cell ' + r.h + ' m');
      console.log('  half-period peaks (m): ' + pk.map((v) => v.toFixed(4)).join(' ') + ' (start ' + Math.abs(first).toFixed(4) + ')');
      if (process.env.ACC_CURVE) console.log('  curve: ' + r.ys.filter((v, i) => i % 3 === 0).map((v) => (v === null ? NaN : v).toFixed(3)).join(' '));
      await t.shot('acc_slosh'); await done(t);
    }
  }
})();
