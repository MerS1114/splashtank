// The page's ocean waves and narrow band seed count for a setup given as JSON, so the native tests can check nb.rs against them:
//   node native/tools/nb-check.js '{"d":0.04,"ratio":2,"size":[3,2,3],"fills":[...],"band":4,"ocean":{...},"g":9.8}'
// prints { waves: [...], count } (count: particles with the spare slots, as nbSeedCount)
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '../..');
const ctx = vm.createContext({ console, Math, performance: { now: () => 0 }, Float32Array, Uint32Array, Uint16Array, Uint8Array, Int32Array, ArrayBuffer, DataView, Map, Set, WeakMap, Promise,
  navigator: {}, GPUBufferUsage: {}, GPUMapMode: {}, setTimeout: () => {}, self: {} });
vm.runInContext(['src/shared.js', 'src/gpu.js', 'src/flip/wgsl-multigrid.js', 'src/flip/sim.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n') +
  '\n;this.FlipSim = FlipSim; this.nbSeedCount = nbSeedCount; this.oceanWaves = oceanWaves;', ctx);
const a = JSON.parse(process.argv[2]);
const lay = ctx.FlipSim.layout({ d: a.d, ratio: a.ratio, size: a.size });
const waves = a.ocean ? Array.from(ctx.oceanWaves(a.ocean, a.g, a.ocean.level - lay.b.y0).w) : [];
const count = ctx.nbSeedCount(lay, a.fills, { on: true, band: a.band }, a.ocean || null, 0, a.g);
console.log(JSON.stringify({ waves, count }));
