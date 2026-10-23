// Syntax check of the page's scripts, reported by source file and line (the build concatenates many files, so a
// browser error points into the big page). Runs at the end of tools/build.py; about a second.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..'), S = (...p) => path.join(ROOT, 'src', ...p);
const FLIP = ['wgsl-core', 'wgsl-blocks', 'wgsl-solver', 'wgsl-whitewater', 'wgsl-narrowband', 'sim', 'bake'].map((p) => S('flip', p + '.js'));
const APP = fs.readdirSync(S('app')).filter((f) => f.endsWith('.js')).sort().map((f) => S('app', f));
const groups = [[S('shared.js')], [S('gpu.js'), ...FLIP], [S('presets.js')], APP];
let bad = 0;
for (const files of groups) {
  const isApp = files === APP; let code = isApp ? '(function () {\n' : '', map = [], line = isApp ? 1 : 0;
  for (const f of files) { const t = fs.readFileSync(f, 'utf8') + (isApp ? '' : '\n'); map.push([line, f]); code += t; line += t.split('\n').length - 1; }
  if (isApp) code += '})();';
  try { new vm.Script(code); } catch (e) {
    const m = /:(\d+)/.exec(e.stack.split('\n')[0]) || /<anonymous>:(\d+)/.exec(e.stack) || [];
    const ln = +(m[1] || 0) - 1; let at = map[0]; for (const q of map) if (q[0] <= ln) at = q;
    console.log('SYNTAX ERROR in ' + path.relative(ROOT, at[1]) + ' line ' + (ln - at[0] + 1) + ': ' + e.message); bad++;
  }
}
if (bad) process.exit(1); else console.log('syntax ok');
