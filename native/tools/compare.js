// Sets a native bake (its cache file's per-frame measurements) against the page's bake of the same scene (tests/native-compare.js).
// The two run on different GPU APIs with their own random jitter, so they never match exactly; a faithful port gives the same water:
// the same number of particles, the water's centre and height spread close, similar speeds and substeps.
// node native/tools/compare.js native.splc page.json [every 4 frames]
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]), ml = buf.readUInt32LE(8), nat = JSON.parse(buf.toString('utf8', 12, 12 + ml)).diag;
const page = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), pg = page.diag, every = +(process.argv[4] || 4);
const f2 = (v) => (v == null ? '-' : (+v).toFixed(2));
// how much two height histograms differ: half the summed difference of their shares (0 the same, 1 nothing in common)
const histDiff = (a, b) => { const sa = a.reduce((s, v) => s + v, 0) || 1, sb = b.reduce((s, v) => s + v, 0) || 1; return a.reduce((s, v, i) => s + Math.abs(v / sa - b[i] / sb), 0) / 2; };
let worstC = 0, worstH = 0;
console.log('frame: points native/page; centre x y native vs page; mean speed; fastest; substeps; height spread difference');
for (let f = 0; f < Math.min(nat.length, pg.length); f++) {
  const a = nat[f], b = pg[f];
  const dc = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]), dh = histDiff(a.heightHist, b.heightHist);
  worstC = Math.max(worstC, dc); worstH = Math.max(worstH, dh);
  if (f % every && f !== nat.length - 1) continue;
  console.log(f + ': ' + a.alive + '/' + b.alive + '; ' + f2(a.center[0]) + ' ' + f2(a.center[1]) + ' vs ' + f2(b.center[0]) + ' ' + f2(b.center[1]) + '; ' + f2(a.meanSpeed) + '/' + f2(b.meanSpeed) +
    '; ' + f2(a.maxSpeed) + '/' + f2(b.maxSpeed) + '; ' + (a.sub ?? '-') + '/' + (b.sub ?? '-') + '; ' + dh.toFixed(3));
}
const nsec = nat[nat.length - 1].elapsed;
console.log('largest centre gap ' + worstC.toFixed(3) + ' units, largest height spread difference ' + worstH.toFixed(3));
console.log('time: native ' + (nsec != null ? nsec.toFixed(1) + ' s' : '?') + ', page ' + page.seconds.toFixed(1) + ' s');
