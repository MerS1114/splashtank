// Reads a cache file with the page's own reader (parseCache and framePoint from src/shared.js) and prints what it found:
// used by native/format's tests to check that the page can open native caches. node read-cache.js file.splc [points to print]
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../../src/shared.js'), 'utf8');
const ctx = vm.createContext({ TextEncoder, TextDecoder, Math, console, Float32Array, Uint32Array, Uint16Array, Uint8Array, Int32Array, Float64Array, DataView, ArrayBuffer });
vm.runInContext(src + '\nthis.parseCache = parseCache; this.framePoint = framePoint;', ctx);
const buf = fs.readFileSync(process.argv[2]);
const c = ctx.parseCache(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const want = +(process.argv[3] || 0);
console.log('frames', c.frames.length);
let k = 0;
for (const fr of c.frames) for (let i = 0; i < fr.n && k < want; i++, k++) console.log('pt ' + ctx.framePoint(fr, c.b, i).join(' '));
