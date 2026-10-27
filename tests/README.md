# Tests

All tests open `dist/SplashTank.html` in headless Chromium with a software GPU, so build first (`npm run build`). Screenshots and downloads go to `test-output/`. Run them one at a time.

The browser is started in `browser.js`. Set `SPLASH_GPU=1` to use the Edge or Chrome installed on the computer, in a window, on its real graphics card (`SPLASH_BROWSER` = the browser program if it is not found), and `SPLASH_PAGE` to test another copy of the page (a file or a web address such as the testing page) instead of `dist/`. See the README for setting up a computer for this.

- `stress.js` (`npm run stress`, or `node tests/stress.js quick` to check the script): several dense cases in turn, each baked, Smoothness test with 20 s live, bake playback as a surface, Solver benchmark; `test-output/stress-report.txt` with a summary line per case. For a real GPU; about an hour.
- `gpu.js` (`npm run gpu -- "Meteor lake" 0.03 [bake seconds]`): runs the Smoothness test and the Solver benchmark and saves them to `test-output/gpu-report.txt`, with screenshots as points and as a surface. Meant for a real GPU; it says which GPU WebGPU found.

- `lib.js`: shared start-up for new tests (open a scene, run code in the page, wait for a condition, screenshot). Not a test itself.
- `smoke.js`: the quick pass/fail check (`npm test`).
- `ui2.js`, `ui3.js`: interface basics: typing values, tooltips, right-click menu, search, add menu, live cache lanes, bake panel, gizmo, view snapping.
- `ui5b.js`: click selects without moving, gizmo size, snapping (Ctrl, magnet, while playing), Global/Local scaling, edit mode looks, double-click a key, splitters, slider drag, menus.
- `ui5c.js`: narrow band on and off, deep water look, colour by type.
- `ed5.js`: edit mode screenshots in point, edge and face mode.
- `lc.js`, `lcq.js`: live cache recording and playback.
- `rep2.js`: bake, save the cache and the bake report, reopen the cache.
- `dp_bake.js`: bake with deep water points; cache file round trip.
- `oc_ui.js`, `oc_bake.js`, `oc_rise.js`: ocean scene, ocean bake, a hull rising out of the sea.
- `nb2.js` to `nb5.js`: narrow band measurements and debugging (column and row dumps). nb2 takes arguments: `nb|full scene steps spacing iters band`.
- `bake_live.js`: the bake shows while it runs; cancelling keeps the finished frames.
- `ww.js`: whitewater, air field and dripping: counts points by kind and the slots in use (they should stay near the living count) while a scene runs, screenshots in speed and type colours. `node tests/ww.js "Meteor lake" 90 0.08 [max whitewater]`.
- `timeline.js`: the one timeline with a bake shown (frame stepping by buttons and arrow keys, ruler clicks, Shift+Left), stepping in the live view, and a short run of the in-page smoothness test.
- `wwpass.js`: the whitewater pass over a bake (Make whitewater): whitewater per frame before and after, screenshots. Slow (about 5 min).
- `ballistic.js`: fast drops flying free of the grid: counts drops flying free during a live run and compares substeps and time of a short water bake with it on and off. `node tests/ballistic.js [spacing 0.08] [bake seconds 2.5]` (at 0.08 almost no drops separate; use 0.04).
- `settle.js`: settled water left out of the pressure solve: bakes with it on and off and prints water points per frame (water must not be lost), the share of cells left out, bake time, and a picture of the same last frame. `node tests/settle.js ["Meteor lake"] [0.06] [2 s] [tolerance]`.
- `multigrid.js`: multigrid pressure in the running sim: steps a scene with plain sweeps and with V-cycles, prints the leftover pressure residual every few frames and the water's mean height, screenshots. `node tests/multigrid.js ["Dam break"] [0.05] [60 frames] [weight 1] [on|off] [every n frames]`.
- `detail.js`: Bake > Detail: bakes the water, then a region again finer, guided by the bake; prints the time, fine particles per frame and the water above the still surface in the region before and after, pictures `detail_before`/`detail_after`. `node tests/detail.js ["Meteor lake"] [0.06] [2 s] [2x] [frame 30]`.
- `impact.js`: how hard an impact splashes with the pressure speed-ups on and off (settle, plain, mg, settle+mg; +noball keeps fast drops on the grid): pressure left unsolved, settled share, water above the still surface and the highest water every 6 frames. `node tests/impact.js ["Meteor lake"] [0.03] [72 frames] [runs]`.
- `deepwater.js`: a saved scene file stepped in chunks: water cells (the volume), particles and the surface height far from the middle, with a picture after each chunk. For narrow band water lost or gained under impacts. `node tests/deepwater.js scene.json [0.04] [12 frames a chunk] [5 chunks]`.
- `mgsolve.js`: the pressure solve alone on one state, from zero pressure, for sweep counts and multigrid settings (fine sweeps per cycle, over-relaxation): the cleanest comparison of the solvers. `node tests/mgsolve.js ["Meteor lake"] [0.05] [frames 30]`.
- `wwarea.js`: the whitewater area: counts whitewater past the tank walls and above its top while Meteor lake runs, screenshot of the dashed area box; checks per-frame compact boxes (compactFrameBox) decode and survive a cache file. About 2 min.
- `hidden.js`: buried water in compact bakes (markInterior): how many points are marked, the draw time with them skipped and drawn, and how many pixels differ. About 2 min.
- `surface.js`: Draw water: Surface: screenshots a scene as points and as a surface and times a draw each way. `node tests/surface.js "Dam break" 0.05`.
- `redraw.js`: while the sim plays the live view redraws only for new sim frames; stopped, every frame (asserts, exits non-zero).
- `snap.js`, `gz.js`: older snapping and gizmo checks.
