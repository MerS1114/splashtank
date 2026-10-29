// Sets two native caches' per-frame measurements side by side (a resumed bake against one that ran straight through, or two runs):
// particles, water centre and height spread per frame, and the largest differences.
// node native/tools/diag-diff.js a.splc b.splc [every 4 frames]
const fs = require('fs');
const rd = (f) => { const b = fs.readFileSync(f); return JSON.parse(b.toString('utf8', 12, 12 + b.readUInt32LE(8))).diag; };
const A = rd(process.argv[2]), B = rd(process.argv[3]), every = +(process.argv[4] || 4);
const histDiff = (a, b) => { const sa = a.reduce((s, v) => s + v, 0) || 1, sb = b.reduce((s, v) => s + v, 0) || 1; return a.reduce((s, v, i) => s + Math.abs(v / sa - b[i] / sb), 0) / 2; };
let wc = 0, wh = 0, wn = 0;
console.log('frame: alive a/b; centre gap; height spread difference; whitewater a/b');
for (let f = 0; f < Math.min(A.length, B.length); f++) {
  const a = A[f], b = B[f];
  if (a.f !== b.f) { console.log('frame numbers differ at ' + f + ': ' + a.f + ' and ' + b.f); process.exit(1); }
  const dc = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]), dh = histDiff(a.heightHist, b.heightHist);
  wc = Math.max(wc, dc); wh = Math.max(wh, dh); wn = Math.max(wn, Math.abs(a.alive - b.alive) / Math.max(a.alive, 1));
  if (f % every && f !== A.length - 1) continue;
  console.log(f + ': ' + a.alive + '/' + b.alive + '; ' + dc.toFixed(4) + '; ' + dh.toFixed(4) + '; ' + (a.sprayPoints ?? '-') + '/' + (b.sprayPoints ?? '-'));
}
console.log('frames ' + A.length + '/' + B.length + '; largest centre gap ' + wc.toFixed(4) + ', height spread difference ' + wh.toFixed(4) + ', particle count difference ' + (wn * 100).toFixed(2) + '%');
