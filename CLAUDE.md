# SplashTank: notes for Claude

SplashTank is a water simulator in one HTML page: a WebGPU FLIP solver (Houdini FLIP look) with a three.js r128 viewer and a Blender-style interface. The owner is Mer. She opens the built page in Chrome on a work computer where she cannot install software, so everything has to stay a single self-contained page that runs in the browser.

## Working with Mer

- Her GPU is an Intel UHD Graphics 730 (i5-12400, 32 GB RAM). All testing here is headless Chromium on a software GPU (SwiftShader), which is much slower and not the same hardware. Say so plainly when reporting speed or anything GPU-dependent.
- Summaries: short and plain. No tables (she uses text-to-speech, tables come out garbled). Code she might copy goes inline in chat code blocks.
- She tests the built page herself and reports what feels wrong. Ask for specifics only when a report is too vague to act on; otherwise fix and test.
- Deliver by committing to main (which republishes the page) and, when asked, sending dist/SplashTank.html.

## Layout of the repo

Files are split by area so a change means reading one small file. Find things with grep (function names are unique), then read only that file or range.

- `src/head.html`: CSS, the page layout and every element with an id. The app finds elements by id, so keep ids when restyling.
- `src/shared.js`: code shared by the page and the workers (CPU bake, collision shapes): CPU PBF solver (FluidSim), SceneRunner, collision shapes (buildSDF), keyframe sampling, cache file format (writeCacheParts / parseCache), ocean waves (oceanWaves, oceanEtaJS, oceanVelJS), narrow band seeding (nbSeed).
- `src/gpu.js`: GPU PBF solver (GpuSim), WebGPU setup (initGpu), SDF_WGSL, packFrameBuf / packDeep for cache frames, runBakeGpu.
- `src/flip/`: the FLIP solver. The shader is five parts joined by flipWGSL() (WGSL does not care about declaration order):
  - `wgsl-core.js` parameter block (Params), every binding, shared helpers (cells, blocks, colliders, sampling, narrow band and ocean helpers);
  - `wgsl-blocks.js` sparse block allocation and the particle sort;
  - `wgsl-solver.js` one step: clear, p2g, classify, divergence, pressure, project, collideP, g2p;
  - `wgsl-whitewater.js` whitewater, air field, drips, live view gather and packing (sprayDisp, packDisp), deep water points;
  - `wgsl-narrowband.js` narrow band kernels;
  - `sim.js` the FlipSim class (buffers, binding table L, step(), stages(), dispPack(), pump(), unpackLive, readbacks);
  - `bake.js` CPU-side helpers (packSprayJS, dripSamples, packSprayFrame, bakeDiag) and runBakeFlipGpu.
  Adding a kernel: write it in the right wgsl part, add its bindings to `FLIP_L` in sim.js (max 8 storage buffers), dispatch it in stages() or where it belongs.
- `src/presets.js`: Meteor lake and Waterfall, as scene files Mer saved from the app (SCENE_FILES); loadScene loads them like a scene file. Other presets are built in code (SCENES in app/04-scenes.js).
- `src/app/`: the app, one function split into numbered parts that share its variables (build.py joins them in name order inside `(function () { ... })();`). A part can use anything from any part at run time, but code that runs at start-up may only use what earlier parts defined.
  - `00-state.js` S (settings and state), solver presets, ocean and narrow band config;
  - `01-draw.js` the frame format notes, SLOTS, frameAlive, packCpuFrame, makeSim, simPar;
  - `02-viewport.js` three.js, cameras, integer-texture slots (slotAlloc, slotLoad), the three point shaders and showSlots, ocean view, tank box, face handles;
  - `03-objects.js` scene objects, meshes, collision shapes (rebuildSDF, rebuildSDFLater worker);
  - `04-scenes.js` built-in scenes, loadScene, resetSim, undo;
  - `05-panels.js` slider/check/segment helpers and the property panels (box, live solver, whitewater, narrow band, ocean, bake, display);
  - `06-outliner.js` object list, object parameters, outliner;
  - `07-timeline.js` keys and the one timeline (tlSpan, tlNow, scrubTo, stepFrame), recording;
  - `08-modes.js` play buttons, Live/Bake (viewMode, applyMode);
  - `09-bake.js` baking, progressive display, cache info, saving, report, cache slots (slotFor, showCache), loading a cache;
  - `10-edit.js` viewport helpers and edit mode; `11-transform.js` G/R/S, snapping, orientation; `12-input.js` add menu, keyboard, pointer;
  - `13-files.js` scene files (sceneData, applySceneData); `14-bench.js` solver benchmark and smoothness test (runSmooth);
  - `15-livecache.js` live cache (lcRecord, lcShow, lcUi); `16-loop.js` stepOnce and the frame loop;
  - `17-panelui.js` group folding, tooltips, right-click menu, search, status bar; `18-layout.js` tabs, menus, tool shelf, viewport header, splitters, window.__splash, start-up.
- `tools/build.py`: joins the above with three.min.js (from node_modules) into `dist/SplashTank.html`, then runs `tools/check.js`, which reports syntax errors by source file and line.
- `tests/`: puppeteer scripts (see tests/README.md). `tests/lib.js` has the shared start-up (open a scene, run code in the page, wait, screenshot); use it for new tests. `smoke.js` asserts and exits non-zero on failure; the others print measurements and save screenshots to `test-output/`.
- `native/splash.cpp`: an older native multithreaded baker; the page can still read its cache format. Not part of the build.

## Build and test

    npm install                  # once: three.js and the test browser
    npm run build                # dist/SplashTank.html + syntax check (a second or two)
    npm test                     # build + smoke test (about a minute)
    npm run t -- tests/ui5b.js   # build, then run one test

Fast loop: edit, `npm run build` (catches syntax errors by file and line), then the one test that covers the area (tests/README.md says which), then `npm test` before committing. Do not run long tests just to check a small change.

Tests are slow on SwiftShader (a few frames a second; bakes take minutes). Run them one at a time; in parallel they get flaky. Kill stray browsers with `pkill -x chromium; pkill -x headless_shell` (exact matches, never `pkill -f`, which matches the shell running it), and always before timing anything. Do not start a test that writes to the same output file as one still running.

`window.__splash` exposes app internals for tests (S, objs, getSim, select, startTf, setTool, setPtab, slotLoad, perf, runSmooth and many more). Add to it (in 18-layout.js) rather than reaching into the DOM when a test needs state.

GitHub Actions (`.github/workflows/pages.yml`) builds and tests on every push to main or a claude/* branch. The site (tools/site.sh) has main at the root and the newest claude/* branch at /testing/ (orange label with branch and commit); claude/* pushes are published by testing-page.yml, which runs from main because only main may deploy to github-pages. Push work to the session branch first so Mer can try it at https://mers1114.github.io/splashtank/testing/, then merge to main when she says. Check with `gh run list -R MerS1114/splashtank -L 1`.

## Current work (update this when it changes)

Mer's smoothness test on her Intel UHD 730 (Meteor lake preset, spacing 0.03, 219k particles live, bake up to 491k water points), before the fixes below: bake playback fine (44 frames a second, uploads 1.6 ms for 4.3 MB); live had one 23 s frame right after Start (first use of the compute pipelines), then 28 ms frames, and got through only 0.3 s of sim time in 10 s.

Done since (merged to main):
- The 61 FLIP pipelines are made once per device (flipPipes in flip/sim.js, FLIP_L is the binding table) with createComputePipelineAsync, compiled in parallel and shared by every FlipSim. sim.ready / sim.whenReady: nothing steps until then (stepOnce returns, the viewport says "Preparing the GPU solver"); bakes and the benchmark await whenReady; tests/lib.js open() waits for it. The smoothness test reports how long the compile took.
- sim.lastMs (track() in gpu.js) is the median of the last 31 steps; sim.slowMs is the slowest since the test started.
- The live view and live cache alternate between slots 0 and 4 (liveLoad, liveI), so an upload never rewrites textures the last draw may still read. Bake slots are 1 to 3 (NBSLOT).
- perf.frame is timed from the start of frame(), not from the rAF timestamp.
- Speed colours: speed bytes are now 16ths of m/s instead of 16ths of a scene unit, so big-scale scenes (Meteor lake, 6.7 m per unit) get about 80 colour steps up to 5 m/s instead of 12. Encoders take vs (metres per unit): packDisp (PK.vs), packFrameBuf, packDeep, packCpuFrame, packFrame. New caches carry spdMs.
- Her rerun with these fixes (sent as a file, Meteor lake 0.03): pipelines ready in 0.8 s, no start stall; page work 0.7 ms a frame; live uploads 0.7 ms for 2.3 MB (was 4.7); 32 frames a second drawn. The sim itself is the bottleneck: solver step about 150 ms (median, slowest 616), 15% of real time. Waiting for her Solver benchmark (stage times) on that scene.
- Her Solver benchmark (old build, no timestamps): whole step 134 ms, but every stage timed alone took 15 to 80 ms (even 'clear'), varying 4x between runs; 20 instead of 30 pressure iterations, no sorting, no whitewater: all within a few %. So the time is not the solver's GPU work; it is the wait until the browser reports a submission done (and maybe drawing sharing the GPU). The live loop allowed only 2 steps in flight and 1 per drawn frame, so that wait capped the sim.
- Since then (on the testing page): timestamp-query is requested when offered; FlipSim times each step on the GPU (sim.gpuMs, median of 31) and stepTimed times every stage with timestamps in one submission. The live loop allows about 100 ms of GPU work in flight (2 to 8 frames' worth, from gpuMs) and up to 3 steps per drawn frame. The benchmark has run D (viewport not drawn); the smoothness test prints GPU busy time and the most steps queued.
- The benchmark measures from the playhead (2.5 s if it is at the start): every measured run resets and simulates up to that moment again (warmTo), so all variants time the same window (2 x M steps), e.g. a meteor impact. GPU busy counts only the timed steps.
- Next: her rerun of both tests on the testing page; check GPU busy vs whole step, and whether D is much faster (then drawing competes with the solver).
 Her 4 million whitewater pool: once that many slots have been handed out, every whitewater kernel runs over all of them each substep.

## FLIP solver, in brief

- Sparse grid: 8x8x8 blocks with a slot pool (tmap, slotList, slotTile, free stack); blocks exist only near water and grow on demand (maybeGrow / grow). Active cells are dispatched indirectly (acell()). Pressure: red-black SOR over per-colour fluid cell lists.
- `ctype` per cell packs: bits 0-7 cell type (0 air, 1 fluid, 2 solid), bits 8-15 collider index + 1, bits 16-31 depth phi as 16 bits (phi = 8 - q/4096).
- Uniform block layout (FLIP_PARAMS_BYTES = 1632): words 55 nb, 56 band, 57 ocean, 58 nwave, 59 otime, 60 olevel, 61 olayer, 62 opad (offset of the deep water points in the display buffer), 63 oy0, 64 nbInit, 65 nfill, 66 odepth, 67 nfv; 68-71 whitewater (foam life, bubble rise, crest and churn weights), 72-78 air field (on, couple, decay, cell size, dims), 79-81 drips (count, rate, dry time), 82 air blur; fills at word 84, waves at 148. Adding fields means keeping the 16-byte alignment of the arrays.
- Keep every kernel within 8 storage buffers (the default WebGPU limit, and likely what Mer's GPU gives under Chrome). That is why whitewater has a separate wwSample pass.
- `ctl` counters (16 x u32): 0-1 fluid list lengths, 2 free stack, 3 new blocks, 4 slots in use, 5 overflow, 6 max speed, 7-10 narrow band, 11-14 deep water display (14: deep points shown last time). `sctl`: 0 whitewater slots handed out, 2 whitewater points in the live view.
- Narrow band (Houdini style): particles only in a band under the surface; deep water lives on the grid. phi advected (nbPhi) and relaxed (nbJacA/B); grid velocity kept between steps in velG (binding 31, allocated only once narrow band is used: enableNB). nbVel fills particle-less faces; classify treats deep calm cells as fluid; nbKill / nbDead / nbDeficit / nbSpawn trim and refill the band. Known trade-off: impacts into deep water splash less than full FLIP.
- `step(dt, o)`: `o.nb` null means off. (A past bug fell back to a stale sim.nbCfg when nb was null, so narrow band never turned off.)
- Ocean: 24 Airy waves from a Pierson-Moskowitz spectrum; the box sides are a boundary layer that moves with the waves. The ocean view outside the box is a points grid computed in a shader.
- Whitewater (Houdini style), one pool of points (sPos: xyz + life, sVel: velocity + kind 0 spray, 1 mist, 2 foam, 3 bubble; the fraction of sVel.w, up to 0.4, is how long it has been that kind, up to WWHOLD = 0.2 s, and a point keeps its kind at least that long so it never flickers between kinds). New points only go into dead slots (the slot counter runs on, but a living point is never replaced). sprayEmit sources from crests (fast exposed water) and churn (white water from impacts; made under the surface it starts as bubbles); nothing is emitted for the first half second after a start, while the fill settles. wwSample stores the water velocity and wetness (wetAt) per point; sprayStep reclassifies (spray landing turns to foam, foam pushed under to bubbles, bubbles surfacing to foam) and moves each kind. The time since start (this.tm, word q8) resets in clear().
- Air field: dense coarse grid (airAlloc, cells 2+ solver cells, at most about 260k), pushed by surface water, flying spray and colliders (airSplatW, airSplatS, airUpdate), settles back to the wind. Only whitewater feels it; the water does not.
- Dripping: samples over each collider's surface from its distance grid (dripSamples, cached per sdf id); dripStep keeps them wet in water, dries them over dripDry seconds and emits drops as spray with the collider's velocity.
- Look-only deep water (narrow band): deepClear / deepPick / deepFin write one point per deep cell (w = 4096 + speed) after the spray points; kept in bakes as frame block flag 4.
- Point kinds in the display buffer (the w component): below 1024 water (speed + 64 x white-water level), uint bits with the top bit set are whitewater (bits 30-29: 00 spray, 10 mist, 01 foam, 11 bubble; 8 bits speed; direction for spray and mist, life left for foam and bubbles), 4096 + speed deep water. In the point shader: 2048 spray, 3072 mist, 4096+ deep, 6144 + life foam, 7168 + life bubbles.
- With narrow band off, the water's motion is the same as before narrow band and whitewater existed (whitewater never pushes the water); keep it that way when changing shared kernels. One deliberate change: the gust time now restarts on reset.

## Interface, in brief

- Blender-like layout: top bar (menus, Live/Bake workspaces), tool shelf (Select, Move, Rotate, Scale, Transform: the tool decides which gizmo handles show), viewport header (mode, Global/Local orientation, snapping, colour by), viewport, timeline, outliner, properties with vertical tabs (`.group[data-ptab]`, `setPtab`). Splitters set CSS variables --rw, --oh, --kfh, remembered in localStorage (`lay`).
- Clicking only selects; dragging draws a selection box. Moving is G/R/S or the gizmo.
- Snapping: S.snapOn (magnet, Shift+Tab), Ctrl held flips it, V held snaps to points; S.snapTo increment / vertex / edge / face. Targets and sources are computed once per move from where things started (snapTargets / snapSources).
- Orientation: S.orient global/local; pressing the same axis twice switches for that move (useLocalAx, axisDir). Object-mode scaling rewrites mesh vertices through scaleMatL (no group scale).
- Edit mode overlay: custom shaders, depth-tested with a small bias: round dots in point mode, thick screen-space edges in edge mode, face dots in face mode.
- Sliders are `input[type=range]` inside `.num`, styled as Blender number fields; drag sideways to change, click to type. Each row has `row._st` (get, commit, def, fmt) used by reset/copy/paste/search.
- Live cache: frames the live view showed are kept in memory (default budget 2 GB) and replayed by Reset/Rewind/scrubbing; any change clears it (shown orange as out of date).
- Drawing: every view draws a frame in the cache format (water pos u16 x3 across the box, spd byte in 16ths of m/s with 255 = gone (caches without the spdMs flag hold 16ths of a scene unit; the uVs uniform is metres per unit for m/s frames, 1 for those), fm byte; whitewater sp.pos + sp.pk 32-bit codes, 0 = none; deep water dp.pos + dp.spd). Frames go to the GPU as they are: slotLoad uploads the arrays with texSubImage2D into integer textures (RGB16UI positions, R8UI speed and white water, R32UI whitewater codes; 2048 wide; water from row 0, then deep, then whitewater), and three shaders (water blended between two frames, deep water, whitewater) decode them and make the look-only extras from a hash of the point number. The CPU never loops over the points. The textures are made with raw WebGL and handed to three.js by setting renderer.properties.get(tex).__webglTexture on an empty THREE.Texture (version 0, so three only binds it). SLOTS[0] and SLOTS[4] are the live view and live cache, used in turn (liveLoad); 1-3 hold baked frames (playhead, next, and the one after, preloaded on a frame that loaded nothing). Whitewater draws see-through and soft-edged (no per-pixel dithering, which sparkled). Do not go back to instancing (about 6x slower) or to CPU-built float buffers (the old cause of playback stutter).
- Live view (FLIP): dispPack gathers the sample (subsample, sprayDisp packed by sctl[2], deep) and packDisp packs it on the GPU into bPack in the frame format (layout from packLayout, header words 0-1 = whitewater and deep counts); pump reads it back (three copies in flight) and unpackLive makes sim.outFrame with one copy. The live cache keeps those frames as they are. PBF engines go through packFrameBuf (JS), the CPU engine through packCpuFrame.
- Bakes show in the viewport while they run (the bake becomes S.cache with partial = true and the view follows the newest frame unless scrubbed); a cancelled bake keeps the frames it finished.
- One timeline (#kf) for the live view and a shown bake (the old #tl-cache bar stays hidden): tlSpan / tlNow / scrubTo / stepFrame switch on viewMode(). Left/Right arrows and the step buttons move one frame (a bake frame, or a 1/24 s timeline frame in the live view: from the live cache, or simulated forward), Shift+Left/Right go to the ends, Up/Down jump between keys.
- Collision shapes (buildSDF in shared.js): exact distances in a band around each triangle, chamfer sweeps for the rest, inside/outside from x-scanline crossings; about 10 to 100 times faster than the old brute force. After scaling or reshaping a collider, rebuildSDFLater builds it in a worker (water volumes are rebuilt at once).
- Performance tab: Smoothness test (runSmooth) times every drawn frame of 10 s live and 10 s of the bake and the shape rebuilds; Mer can run it and paste the text. Solver benchmark (runBenchmark) times the FLIP stages.
- Narrow band "Full depth" (band slider at the far right, or Ocean > Full depth): band 1e4, so particles go all the way down and nothing is grid-only. This is what makes an ocean behave like a filled volume; the narrow band's deep water is smooth and damped by design.
- Measuring speed in tests: kill leftover browsers first (`pkill -x chromium; pkill -x headless_shell`). A browser left over from a timed-out test keeps baking and makes everything look many times slower.

## Conventions

- Plain-language UI text and tooltips; the label is bold when a setting differs from its default.
- Comments explain why, briefly. Keep functions where they are unless a refactor is the task.
- Before handing over a change: build, run the smoke test, run the tests that touch the area, and look at the screenshots.
