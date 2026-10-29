# SplashTank native: plan

A desktop program that runs the SplashTank FLIP solver straight on the graphics card, for scenes, bakes and memory use beyond what a browser allows. The web page stays as it is and keeps working; the native program reads and writes the same scene files (.json) and bake caches (.splc).

## Why

In the browser a dense bake is held in memory (about 28 MB a frame for a 6M point ocean), the GPU's buffers are capped by the browser, and the page dies if the tab runs out of memory. The native program streams bake frames to and from disk, so a bake's length no longer costs memory, and it asks the GPU for everything the card offers.

## Choice of tools

- Rust with wgpu. wgpu is the library Firefox uses for WebGPU, so it runs the same WGSL compute shaders the page already uses (`src/flip/wgsl-*.js`), on DX12, Vulkan or Metal. The solver is ported, not rewritten.
- egui for the interface (panels, buttons, timeline), winit for the window.
- Built with the GNU toolchain, so no Visual Studio is needed. The result is one .exe that needs no installer.
- The old `native/splash.cpp` (a CPU baker for an older format) stays where it is; nothing here depends on it.

## Layout

All under `native/`, a Cargo workspace:

- `format/` (library): scene files and cache files. Reads and writes the same SPLC version 2 layout as `writeCacheParts` / `parseCache2` in `src/shared.js`, including compact frames (flag 8), per-frame boxes (flag 32), whitewater (flag 2), deep water (flag 4) and Bake whitewater frames (flag 16). Scene files are kept as JSON values, so fields the native side does not know survive a load and save.
- `app/` (the program): window, viewer, playback, later the bake controls.
- Later `sim/` (library): the FLIP solver on wgpu, and a headless baker (`splashtank bake scene.json out.splc`) that needs no window.
- `tools/export-wgsl.js`: a Node script that loads `src/flip/wgsl-*.js` and writes the joined shader text (`flipWGSL()`) to `native/sim/shaders/`. The page's files stay the one source of the shaders; a check fails the native build when the export is out of date.

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

- Each finished frame is copied from the GPU to a few reusable staging buffers, packed, and handed to a writer thread that appends it to the file. Only a few frames are ever in memory.
- The JSON block at the start holds per-frame measurements that grow during the bake. Space is reserved for it and padded with spaces (JSON allows trailing spaces, and the page's reader accepts them); if it outgrows the space, the file is rewritten once at the end.
- The frame count is written as "as many as there are" while baking and corrected at the end. The page's reader already stops at the end of the file, so a bake cut short by a crash still opens, with every frame that was finished.

GPU limits:

- The program requests the adapter's full limits: biggest buffer, biggest storage binding, storage buffers per kernel (the page asks for 8 to 16).
- One particle buffer of 2 GB holds about 44M particles with APIC (48 bytes each). The home card has 8 GB of video memory in all, so the grid and the other buffers run out before one particle buffer does. Splitting particle buffers (dispatching the particle kernels once per chunk, each with its own buffer and a base index) is planned, but only built if a measured scene needs it.
- Host memory is 64-bit with no browser cap; RAM still matters for building collision shapes and seeding, which run on the CPU.

## Phases

1. Viewer (this session). Opens a page-made .splc and plays it: water, deep water and whitewater points coloured by speed, the tank box, the scene's objects posed from each frame, orbit camera, play, pause, frame stepping and scrubbing. Opens a page-made scene .json and shows its tank, objects and starting water. Done when Mer's 418 MB, 4M point, 18 frame cache and her scene play on this PC.
2. Solver port, core FLIP: shader export, wgpu device with full limits, the FlipSim buffers, binding table and stages from `src/flip/sim.js`, the parameter block, colliders (buildSDF ported to Rust), keyframes and SceneRunner. Headless bakes that stream to disk. Checked against the page with the same measures the tests use (water volume, mean height, the crown and dam break numbers), since two different GPU APIs will not give bit-identical results.
3. The rest of the solver: narrow band and ocean (nbSeed and the waves; these are what Mer's big scenes need), multigrid, APIC, whitewater, air field, drips, Bake whitewater and the Detail pass.
4. Big-scene work: point caps from the GPU's limits, split particle buffers if a scene needs them, bakes that resume after a crash, playback of bakes bigger than video memory.
Throughout: the native program should look and handle like the page (Mer asked after trying phase 1): the same mouse and key controls in the viewport, the same water, deep water and whitewater look (blending between frames, look-only extras, Surface drawing), the same panel layout and Blender-style theme. Pictures from `--picture` are compared against the page's test screenshots.

5. Interface: a full editor in the native program like the page's (Mer's choice): properties, outliner, objects and edit mode, keys and the timeline, Live and Bake.

## Things to know

- At work Mer cannot install software. The .exe needs no installer, but the work computer's rules may still block programs downloaded from the internet. The web page stays the tool there.
- Both of Mer's GPUs are supported by wgpu: the Intel UHD 730 through DX12 or Vulkan, the home NVIDIA card (RTX 3060 Ti, 8 GB) through Vulkan or DX12. Speed numbers from one card describe that card only.
- Native work lives on its own branch (`native/desktop-app`), not on the testing page's branch or main. The branch name does not start with `claude/`, so pushing it does not replace the testing page.
