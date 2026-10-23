# SplashTank: notes for Claude

SplashTank is a water simulator in one HTML page: a WebGPU FLIP solver (Houdini FLIP look) with a three.js r128 viewer and a Blender-style interface. The owner is Mer. She opens the built page in Chrome on a work computer where she cannot install software, so everything has to stay a single self-contained page that runs in the browser.

## Working with Mer

- Her GPU is an Intel UHD Graphics 730 (i5-12400, 32 GB RAM). All testing here is headless Chromium on a software GPU (SwiftShader), which is much slower and not the same hardware. Say so plainly when reporting speed or anything GPU-dependent.
- Summaries: short and plain. No tables (she uses text-to-speech, tables come out garbled). Code she might copy goes inline in chat code blocks.
- She tests the built page herself and reports what feels wrong. Ask for specifics only when a report is too vague to act on; otherwise fix and test.
- Deliver by committing to main (which republishes the page) and, when asked, sending dist/SplashTank.html.

## Layout of the repo

- `src/head.html`: CSS, the page layout and every element with an id. The app finds elements by id, so keep ids when restyling.
- `src/shared.js`: code shared by the page and the CPU bake worker: CPU PBF solver (FluidSim), SceneRunner, collider SDFs, keyframe sampling, cache file format (writeCacheParts / parseCache), ocean wave spectrum (oceanWaves, oceanEtaJS, oceanVelJS), narrow band seeding (nbSeed).
- `src/gpu.js`: GPU PBF solver (GpuSim), WebGPU setup (initGpu), the live readback ring (pump), packFrameBuf / packDeep for cache frames, runBakeGpu.
- `src/flip.js`: the FLIP solver (FlipSim): WGSL in flipWGSL(), pipelines, step(), dispSource() for the live view, readbackInto / readSpray / readDeep for bakes, runBakeFlipGpu.
- `src/app.js`: everything else (one IIFE): UI, scene objects, transforms, edit mode, timeline and keys, live cache, bakes, panels, menus, layout.
- `tools/build.py`: concatenates the above with three.min.js (from node_modules) into `dist/SplashTank.html`.
- `tests/`: puppeteer scripts. `smoke.js` asserts and exits non-zero on failure; the others print measurements and save screenshots to `test-output/` for a person (or Claude) to look at.
- `native/splash.cpp`: an older native multithreaded baker; the page can still read its cache format. Not part of the build.

## Build and test

    npm install          # once: three.js and the test browser
    npm run build        # dist/SplashTank.html
    npm test             # build + smoke test (about a minute)
    node tests/ui5b.js   # any other test, after building

Tests are slow on SwiftShader (a few frames a second). Run them one at a time; in parallel they get flaky. Kill stray browsers with `pkill -x chromium` style exact matches, never `pkill -f` (it matches the shell running it).

`window.__splash` exposes app internals for tests (S, objs, getSim, select, startTf, setTool, setPtab and many more). Add to it rather than reaching into the DOM when a test needs state.

GitHub Actions (`.github/workflows/pages.yml`) builds and publishes the page to GitHub Pages on every push to main and runs the smoke test.

## FLIP solver, in brief

- Sparse grid: 8x8x8 blocks with a slot pool (tmap, slotList, slotTile, free stack); blocks exist only near water and grow on demand (maybeGrow / grow). Active cells are dispatched indirectly (acell()). Pressure: red-black SOR over per-colour fluid cell lists.
- `ctype` per cell packs: bits 0-7 cell type (0 air, 1 fluid, 2 solid), bits 8-15 collider index + 1, bits 16-31 depth phi as 16 bits (phi = 8 - q/4096).
- Uniform block layout (FLIP_PARAMS_BYTES = 1568): words 55 nb, 56 band, 57 ocean, 58 nwave, 59 otime, 60 olevel, 61 olayer, 62 opad (now: offset of the deep water points in the display buffer), 63 oy0, 64 nbInit, 65 nfill, 66 odepth, 67 nfv; fills at word 68, waves at 132. Adding fields means keeping the 16-byte alignment of the arrays.
- `ctl` counters (16 x u32): 0-1 fluid list lengths, 2 free stack, 3 new blocks, 4 slots in use, 5 overflow, 6 max speed, 7-10 narrow band, 11-13 deep water display.
- Narrow band (Houdini style): particles only in a band under the surface; deep water lives on the grid. phi advected (nbPhi) and relaxed (nbJacA/B); grid velocity kept between steps in velG (binding 31, allocated only once narrow band is used: enableNB). nbVel fills particle-less faces; classify treats deep calm cells as fluid; nbKill / nbDead / nbDeficit / nbSpawn trim and refill the band. Known trade-off: impacts into deep water splash less than full FLIP.
- `step(dt, o)`: `o.nb` null means off. (A past bug fell back to a stale sim.nbCfg when nb was null, so narrow band never turned off.)
- Ocean: 24 Airy waves from a Pierson-Moskowitz spectrum; the box sides are a boundary layer that moves with the waves. The ocean view outside the box is a points grid computed in a shader.
- Look-only deep water (narrow band): deepClear / deepPick / deepFin write one point per deep cell (w = 4096 + speed) after the spray points; kept in bakes as frame block flag 4.
- Point kinds in the display buffer (the w component): below 1024 water (speed + 64 x white-water level), uint bits with the top bit set are spray (0x40000000 = mist), 4096 + speed deep water.
- With narrow band off, solver output is bit-identical to the version before narrow band existed; keep it that way when changing shared kernels.

## Interface, in brief

- Blender-like layout: top bar (menus, Live/Bake workspaces), tool shelf (Select, Move, Rotate, Scale, Transform: the tool decides which gizmo handles show), viewport header (mode, Global/Local orientation, snapping, colour by), viewport, timeline, outliner, properties with vertical tabs (`.group[data-ptab]`, `setPtab`). Splitters set CSS variables --rw, --oh, --kfh, remembered in localStorage (`lay`).
- Clicking only selects; dragging draws a selection box. Moving is G/R/S or the gizmo.
- Snapping: S.snapOn (magnet, Shift+Tab), Ctrl held flips it, V held snaps to points; S.snapTo increment / vertex / edge / face. Targets and sources are computed once per move from where things started (snapTargets / snapSources).
- Orientation: S.orient global/local; pressing the same axis twice switches for that move (useLocalAx, axisDir). Object-mode scaling rewrites mesh vertices through scaleMatL (no group scale).
- Edit mode overlay: custom shaders, depth-tested with a small bias: round dots in point mode, thick screen-space edges in edge mode, face dots in face mode.
- Sliders are `input[type=range]` inside `.num`, styled as Blender number fields; drag sideways to change, click to type. Each row has `row._st` (get, commit, def, fmt) used by reset/copy/paste/search.
- Live cache: frames the live view showed are kept in memory (default budget 2 GB) and replayed by Reset/Rewind/scrubbing; any change clears it (shown orange as out of date).

## Conventions

- Plain-language UI text and tooltips; the label is bold when a setting differs from its default.
- Comments explain why, briefly. Keep functions where they are unless a refactor is the task.
- Before handing over a change: build, run the smoke test, run the tests that touch the area, and look at the screenshots.
