// Starts the browser every test uses.
// Default: the bundled headless Chromium (@sparticuz/chromium, Linux) on a software GPU (SwiftShader). It runs anywhere Linux runs, with no
// graphics card, but it is many times slower than real hardware and not the same GPU, so its speeds say little about Mer's computer.
// SPLASH_GPU=1: the Edge or Chrome installed on this computer, in a visible window, on its real graphics card (a headless browser would fall
// back to a software GPU). SPLASH_BROWSER=<path to the browser's program> picks a browser when the usual places do not find one.
const fs = require('fs'), path = require('path'), url = require('url');
const puppeteer = require('puppeteer-core');
const REAL = !!process.env.SPLASH_GPU && process.env.SPLASH_GPU !== '0';
const PLACES = {
  win32: [process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe', process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe', process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'],
  darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
};
function realBrowser() {
  if (process.env.SPLASH_BROWSER) return process.env.SPLASH_BROWSER;
  const found = (PLACES[process.platform] || []).find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('SPLASH_GPU: no Edge or Chrome found. Set SPLASH_BROWSER to the browser program, e.g. C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  return found;
}
async function launch() {
  if (REAL) {
    const exe = realBrowser();
    console.log('Real GPU run: ' + path.basename(exe) + ' in a window. Keep it on screen and do not use the computer for anything heavy meanwhile.');
    return puppeteer.launch({ executablePath: exe, headless: false, defaultViewport: null, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--allow-file-access-from-files',
      '--no-first-run', '--no-default-browser-check', '--window-size=1460,980',
      // keep the page running at full speed even when another window covers it
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  }
  const chromium = require('@sparticuz/chromium').default;
  const exe = await chromium.executablePath();
  return puppeteer.launch({ executablePath: exe, args: [...chromium.args, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'], headless: 'shell' });
}
// the page's address: a web address as it is, a file as file:// (works with Windows paths too)
const pageUrl = (p) => (/^https?:/.test(p) ? p : url.pathToFileURL(p).href);
module.exports = { launch, pageUrl, REAL };
