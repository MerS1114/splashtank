// Runs tools/build.py with whichever Python this computer has (python3 on Linux and Mac; python or py on Windows).
const { spawnSync } = require('child_process'), path = require('path');
for (const py of ['python3', 'python', 'py']) {
  const r = spawnSync(py, [path.join(__dirname, 'build.py'), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') continue;
  if (r.status === 9009) continue;   // Windows: the Microsoft Store placeholder for a missing python
  process.exit(r.status === null ? 1 : r.status);
}
console.error('No Python found. Install Python 3 (python.org) to build the page.'); process.exit(1);
