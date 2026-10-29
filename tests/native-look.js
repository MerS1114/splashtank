// The page's picture of a cache frame, for matching the native viewer's look (native: splashtank --picture out.png file --frame n --size WxH).
// Loads the cache, pauses on the frame, puts the camera where the native program's default framing puts it, and saves the viewport alone.
// node tests/native-look.js cache.splc [frame 24] [out test-output/native/look-page.png]
const { open, wait, done } = require('./lib');
const path = require('path');
const FILE = path.resolve(process.argv[2]), F = +(process.argv[3] || 24), OUT = process.argv[4] || 'test-output/native/look-page.png';
(async () => {
  const t = await open(null);
  const inp = await t.pg.$('#cache-file'); await inp.uploadFile(FILE);
  await t.pg.waitForFunction(() => window.__splash.S.cache && window.__splash.S.cache.fromFile, { timeout: 600000, polling: 500 });
  await t.ev((f) => {
    const x = window.__splash; x.setCPlay(false); x.S.ct = f; x.S.cfollow = false;
    // the page's frameAll at its starting angles (theta 0.8, phi 1.0), as the native program frames a tank
    const c = x.S.cache, b = c.b, o = c.org || x.S.org, W = b.x1 - b.x0, H = b.y1 - b.y0, D = b.z1 - b.z0;
    x.cam.theta = 0.8; x.cam.phi = 1.0; x.cam.r = Math.min(Math.max(2.1 * Math.max(W, D, H * 1.1), 3), 40);
    x.cam.target.set(o.x, o.y + (H > 3.5 ? H * 0.46 : H * 0.27), o.z); x.setOrtho(false);
    document.querySelectorAll('.vp-info, .vp-stats, #camtools, .camtools').forEach((e) => { e.style.visibility = 'hidden'; });
  }, F);
  await wait(4000);
  const st = await t.pg.$('#stage'), bb = await st.boundingBox();
  await st.screenshot({ path: OUT });
  console.log('page picture ' + Math.round(bb.width) + 'x' + Math.round(bb.height) + ' -> ' + OUT);
  await done(t);
})();
