# SplashTank native: plan

A desktop program that runs the SplashTank FLIP solver straight on the graphics card, for scenes, bakes and memory use beyond what a browser allows. The web page stays as it is and keeps working; the native program reads and writes the same scene files (.json) and bake caches (.splc).

## Why

In the browser a dense bake is held in memory (about 28 MB a frame for a 6M point ocean), the GPU's buffers are capped by the browser, and the page dies if the tab runs out of memory. The native program streams bake frames to and from disk, so a bake's length no longer costs memory, and it asks the GPU for everything the card offers.

## Choice of tools

- Rust with wgpu. wgpu is the library Firefox uses for WebGPU, so it runs the same WGSL compute shaders the page already uses (`src/flip/wgsl-*.js`), on DX12, Vulkan or Metal. The solver is ported, not rewritten.
- egui for the interface (panels, buttons, timeline), winit for the window.
- Built with Rust's MSVC toolchain and the Visual Studio Build Tools (the GNU toolchain's dlltool cannot build the Windows crates without a full MinGW). The result is one .exe that needs no installer.
- The old `native/splash.cpp` (a CPU baker for an older format) stays where it is; nothing here depends on it.

## Layout

All under `native/`, a Cargo workspace:

- `format/` (library): scene files and cache files. Reads and writes the same SPLC version 2 layout as `writeCacheParts` / `parseCache2` in `src/shared.js`, including compact frames (flag 8), per-frame boxes (flag 32), whitewater (flag 2), deep water (flag 4) and Bake whitewater frames (flag 16). Scene files are kept as JSON values, so fields the native side does not know survive a load and save.
- `app/` (the program): window, viewer, playback, the command-line modes (`--info`, `--picture`, `--bake`) and the Bake panel.
- `sim/` (library): the FLIP solver on wgpu (`gpu.rs` pipelines, `flip.rs` FlipSim, `runner.rs` SceneRunner, `scene.rs` bake settings from a scene file, `sdf.rs` collision shapes, `bake.rs` the streaming bake).
- `tools/export-wgsl.js`: a Node script that loads `src/flip/wgsl-*.js` and writes the joined shader text (`flipWGSL()`) and the binding table (`FLIP_L`) to `native/sim/shaders/`. The page's files stay the one source of the shaders; a test fails when the export is out of date. wgpu's shader compiler needs two patches, made when loading: no `enable subgroups;` line, and `subgroupElect()` written with `subgroupBroadcastFirst`.
- `tools/compare.js` with the page test `tests/native-compare.js`: the same scene baked by both, frame by frame.

## Sharing the file formats

- The cache layout is written down once more in `native/format/src/cache.rs`, with the JS functions it mirrors named in its comments. Anyone changing the layout in `src/shared.js` changes both; CLAUDE.md will say so.
- A test in `native/format` writes a cache, reads it back, and reads caches made by the page (a small one kept in the repo as a fixture, and Mer's big one when it is on disk).
- Native bakes are ordinary SPLC files, so the page can open them, as long as the whole file fits in the browser's memory. Very long native bakes may not; the native program will be able to save a part of a bake (a frame range, or every nth frame) for the page.

## Memory and streaming

Reading a cache:

- The file is memory-mapped, not read into memory. On opening, the program walks the frame headers once (no point data is read) and keeps a list of where each frame starts.
- A loader thread decodes frames ahead of the playhead into a small queue; the GPU keeps as many frames as a set budget of video memory allows (like the page's GPU memory setting). Memory use depends on that budget, not on how long the bake is.
- Points are uploaded in their file layout (compact 32-bit positions, 16-bit speed and white-water level) and decoded in the vertex shader, as the page does. The CPU never loops over the points.

Writing a cache during a bake:

- Each finished frame is read back from the GPU and handed to a packer thread (measurements, compact positions, buried water) and then a writer thread that appends it to the file, while the GPU runs the next frame. At most two frames wait at each, so only a few frames are ever in memory.
- The JSON block at the start holds per-frame measurements that grow during the bake. Space is reserved for it and padded with spaces (JSON allows trailing spaces, and the page's reader accepts them); if it outgrows the space, the file is rewritten once at the end.
- The frame count is written as "as many as there are" while baking and corrected at the end. The page's reader already stops at the end of the file, so a bake cut short by a crash still opens, with every frame that was finished.

GPU limits:

- The program requests the adapter's full limits: biggest buffer, biggest storage binding, storage buffers per kernel (the page asks for 8 to 16).
- One particle buffer of 2 GB holds about 44M particles with APIC (48 bytes each). The home card has 8 GB of video memory in all, so the grid and the other buffers run out before one particle buffer does. Splitting particle buffers (dispatching the particle kernels once per chunk, each with its own buffer and a base index) is planned, but only built if a measured scene needs it.
- Host memory is 64-bit with no browser cap; RAM still matters for building collision shapes and seeding, which run on the CPU.

## Phases

1. Viewer (done). Opens a page-made .splc and plays it: water, deep water and whitewater points coloured by speed, the tank box, the scene's objects posed from each frame, orbit camera, play, pause, frame stepping and scrubbing. Opens a page-made scene .json and shows its tank, objects and starting water. Done when Mer's 418 MB, 4M point, 18 frame cache and her scene play on this PC.
2. Solver port, core FLIP (done): shader export, wgpu device with full limits, the FlipSim buffers, binding table and stages from `src/flip/sim.js`, the parameter block, colliders (buildSDF ported to Rust), keyframes and SceneRunner. Headless bakes that stream to disk. Checked against the page with the same measures (bakeDiag per frame), since two different GPU APIs will not give bit-identical results. Results: a dam break with a keyframed ball, 312k and 2.5M particles, matched the page frame by frame (water centre within 0.006-0.011 units, height spread within 2%, same substeps); the 3 s, 2.5M particle bake took 28.7 s natively against 76.7 s in the page on the same card (37 s before packing ran alongside the GPU), with memory flat at about 0.5 GB while its cache file grew to 1.1 GB. The scene file has no live spacing, so `--bake` takes `--spacing`.
3. The rest of the solver (done): narrow band and ocean, whitewater, air field, drips, deep water look points, Bake whitewater (`--bake-whitewater`) and the Detail pass (`--detail-pass`), the last two as commands that read a finished bake and write a new cache. Results on Mer's meteor ocean scene: at live spacing 0.08 the same starting water as the page to the particle, then the water within the page's own run-to-run spread frame by frame (centre within 0.006 units, height spread within 0.4%), whitewater counts within the page's spread, Bake whitewater and the Detail pass close to the page's (fine water counts within 0.5%). At its full size (bake spacing 0.012, Accurate, whitewater on, 6.2M to 8M points), one second took 60 s natively against 278 s in the page on the same card, with 1.4 GB peak memory while a 1.3 GB cache streamed to disk.
4. Big-scene work (done). Measured on Mer's ocean at bake spacing 0.012: the bake's buffers take 1.3 GB at the page's 8M Max points and 2.8 GB at 20M, of the card's 8 GB; video memory was never the limit. Max points was: the narrow band fills every spare slot by frame 2 and wants about twice the starting water after the impact (10.5 to 12M against 6.2M), and when it runs out the refill goes wherever the GPU lists cells first (the water drifted 0.06 to one side). A narrow band bake now picks Max points itself unless given: 2.5 times the starting water, as far as the card's free memory (nvidia-smi) and one buffer allow (15.4M there); every bake checks its estimate against the free memory before starting. Checkpoints: every 5 minutes of baking (--checkpoint-every; spaced so writing them takes at most a tenth of the time) the bake writes out.splc.ckpt: every GPU buffer that carries state between steps (particle buffers only as far as the particles go), the solver's counters, the scene runner, where the cache file ends, and the scene and settings it was started with; --resume out.splc cuts the cache back to that frame and carries on; a finished bake removes it. A bake killed at frame 30 and resumed from its checkpoint at 19 matched one that ran straight through as closely as two straight runs match each other. The disk: drive C: on this PC writes at 13 MB/s sustained (G: 463 MB/s), and a full-size frame is about 75 MB, so on C: the same bake took 173 s instead of 83 s; bakes now measure the time they wait for the disk and say when it held them back. Playback: --playback-test streams a 1.8 GB, 15M point bake through a 512 MB budget at 45 frames a second from the file cache (70 MB a frame); a bake bigger than RAM plays as fast as its drive reads. Split particle buffers: not built, as planned only if a measured scene needs them; one buffer holds 44M particles and 20M took 2.8 GB.
Bake controls in the window (done, Mer asked after phase 4): a Bake panel with the bake settings, Bake, Stop, Resume, Bake whitewater and Detail with its region shown; progress and messages in the panel; the view follows the cache being written. Surface drawing is not wanted natively (Mer).
Viewer look (done, Mer asked after phase 3): the page's point shaders, blending between frames, background, tank, grid, whitewater area, objects, camera, mouse, keys, axis widget and theme; tests/native-look.js pictures match. Still to come: Surface drawing, Bake playback levels, the ocean view outside the box.
Throughout: the native program should look and handle like the page (Mer asked after trying phase 1): the same mouse and key controls in the viewport, the same water, deep water and whitewater look (blending between frames, look-only extras, Surface drawing), the same panel layout and Blender-style theme. Pictures from `--picture` are compared against the page's test screenshots.

5. Interface: a full editor in the native program like the page's (Mer's choice): properties, outliner, objects and edit mode, keys and the timeline, Live and Bake. Started: tabs Bake, Simulation (the page's rows, exported by native/tools/export-settings.js), Tank, Objects (outliner and object fields), View; Save scene; edits go into the scene file's JSON in place. Next: moving objects in the viewport, adding and deleting objects, undo, keys and the timeline, a live sim, edit mode.

## Things to know

- Built and tuned for Mer's home PC only (NVIDIA RTX 3060 Ti, 8 GB, Vulkan), Mer's call: it is not meant for the work computer, where the web page stays the tool. Use what this card offers (subgroups, 2 GB storage bindings, the 9-buffer APIC kernel) without fallbacks for smaller GPUs.
- Native work lives on its own branch (`native/desktop-app`), not on the testing page's branch or main. The branch name does not start with `claude/`, so pushing it does not replace the testing page.
