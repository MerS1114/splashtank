# SplashTank desktop: the new plan

Decided with Mer on 2026-10-29: the desktop program is SplashTank from now on. The web page stays exactly as it is (still online, no more changes); Mer uses it or Remote Desktop at work. The desktop program keeps the page's interface and features but no longer has to match the page's solver, file layout or limits. Everything under the interface is free to be whatever is most accurate and fastest on a desktop PC with a real graphics card.

The first plan (porting the page: viewer, solver, big scenes, bake controls, editor) is in `PLAN-page-port.md`. It is done, and it is the starting point here.

## Ground rules

- Target machine: Mer's home PC (RTX 3060 Ti, 8 GB video memory, 12 CPU threads, 32 GB RAM). The program may require a desktop graphics card with at least 16 storage buffers per shader and 4 GB of video memory, and says so plainly at start-up on anything less.
- The interface stays like the page (layout, keys, mouse, panels, Blender style). Mer should not have to relearn anything.
- Old files still open: page scene files (.json) and page caches (.splc) are read forever. New files are written in the new formats only.
- Every change to the water is measured, not guessed: the accuracy tests and the benchmark below run before and after, and the numbers go in the commit and in CLAUDE.md.
- Work goes on branch native/desktop-app, into the SplashTank Testing copy after each change; published only when Mer says.
- Mer leaves the Detail pass to be reworked later; it is phase 8 and waits for her ideas.

## What we keep (it worked)

- Sparse grid of 8x8x8 blocks that exist only near water, grown on demand.
- APIC transfer with Splash detail (a share of FLIP on top), particle separation, velocity extrapolation, multigrid pressure.
- Narrow band (particles only near the surface) with the fixes from the meteor work: fast deep water turns back into particles, refills only where grid-only water is moving.
- Tall cells for deep water.
- Fast drops flying free, growing and moving colliders that throw water, the real air field, Houdini-style whitewater rules, drips.
- Streaming bakes to disk, checkpoints and resume, Max points picked from the scene and the free video memory, the disk-speed warning.
- Frames kept on the GPU up to a budget, decoded in the vertex shader; the page's point look.
- The whole editor: objects, edit mode, snapping, keys and timeline, motion recording, live water, settings rows.

## What we drop

- Settled water (the idea is flawed: it holds old pressure through an impact).
- The page's 8-buffer limit and the splitting it forced (separate passes only to fit 8 buffers).
- The shader export from the page (`tools/export-wgsl.js`) and the text patches applied when loading: the shaders become the desktop program's own source files.
- The tests that compare against the page frame by frame (native-compare, nb-check). They are replaced by reference numbers recorded once from today's program, and then by the accuracy tests.
- Copying the page's quirks only to match it (for example sorting turned off under APIC, the turbulence white-water term missing under APIC on 8 buffers).

## Phase 0: a fresh foundation (no change to the water) — done 2026-10-29, see CLAUDE.md

1. Shaders as our own source: `sim/shaders/` split by area (core, blocks, solver, pressure, narrow band, tall cells, whitewater, air), joined by a small include step in gpu.rs. Binding numbers come from the shader text (already scanned by binding_use), not from the page's table. The exporter and the patches go.
2. Reference numbers: run the current program on a fixed set of scenes and store per-frame measures (water centre, height spread, particles, substeps, fastest water, pressure left unsolved) in `native/tests/reference/`. Later changes are compared against them, and any difference must be one we meant.
3. The accuracy tests in Rust (`cargo test --release -- accuracy`, a few minutes), ported from tests/accuracy.js, each with a known answer:
   - still water stays still (mean speed after 3 s, mean height);
   - dam break front against Martin and Moyce 1952;
   - volume kept over 10 s of sloshing;
   - standing wave: period against the wave formula, height lost per period;
   - swirl (Taylor-Green vortex): energy and vortex kept after 3 s;
   - drop into deep water: crown height, water thrown out (the crown and impact counts from tests/crown.js and impact.js);
   - underwater blast: speed of the water pushed out.
4. The benchmark set, run by `splashtank --benchmark-set` and written to a text file: Meteor lake at 0.03 and 0.015, Dam break 0.025 full depth, Mer's meteor ocean at 0.012, the deep ocean (tall cells). GPU time per stage, whole step, memory.
5. DX12 against Vulkan on her card: both are offered by wgpu; measure the benchmark set on each and pick the faster as default.

Done when: the shaders build from our own files, every test passes, and the reference and benchmark numbers are recorded with today's water.

## Phase 1: speed, same water — done 2026-10-30, see CLAUDE.md

The browser limit made the solver many small passes. With it gone:

1. Merge passes that only were split for the buffer limit: g2p always reads the old grid velocity (the turbulence white water works under APIC), whitewater sampling goes into the whitewater step, list building into classify where it can.
2. Sorting under APIC: the sort carries the APIC rows too, so particles stay sorted by block (the page had to switch sorting off under APIC).
3. Particles to grid without atomic additions ("gather"): with particles sorted by block, one workgroup owns one block, reads the particles of its block and its neighbours, and writes each face once. Faster on the GPU and the same result every run (today's atomics add in a different order each time).
4. Fewer round trips to the CPU: the step's decisions (substeps, growing blocks, sorting) read counters a frame late from a ring of small readbacks, so the GPU never waits for the CPU.
5. Frame packing on all CPU threads (rayon) while the GPU runs the next frame.

Done when: the reference numbers match (within run-to-run spread, and exactly for anything now deterministic), and the benchmark set is faster. Every merge is measured on its own; anything that is not faster goes back.

## Phase 2: accuracy core — sharp surface done 2026-10-30 (the wave targets met); the pressure solve was shown not to be the cause, so MGPCG waits behind smooth walls

1. Pressure solved to an accuracy, every step: conjugate gradient with the multigrid as its preconditioner (MGPCG, McAdams, Sifakis and Teran 2010). It stops when the pressure left unsolved is under a set tolerance (Normal 0.1%, Accurate 0.001%) instead of after a fixed number of sweeps, warm-started from the last step. The sums it needs are done on the GPU with subgroup reductions; the stop test is checked every few iterations without waiting on the CPU (the iteration count is decided on the GPU through indirect dispatch). Incompressible water: an impact can no longer squeeze the water; it has to push it out.
2. Smooth solid walls: each cell face gets the share of it that is open (from the collider's distance field), and the pressure solve weights faces by it (Batty, Bertails and Bridson 2007; Houdini's Voxel Face Area). Slopes and curved objects stop looking like stairs to the water, water slides down a slope instead of sticking at the steps, and thin gaps still pass water.
3. A sharp water surface: the liquid surface is built from the particles each step as a distance field on the grid (Zhu and Bridson 2005), and the pressure at the surface uses where the surface really is inside the cell (ghost fluid, Gibou et al. 2002, Enright et al. 2003). This is what keeps waves from losing height and keeps their period right. The same distance field serves the narrow band, the whitewater (crests from its curvature) and the Bake whitewater pass.
4. Particle motion through the grid velocity with a higher-order step (RK3), as Houdini does, instead of one straight step per substep: drops and sheets follow curved paths correctly at large time steps.
5. Volume kept: the particle separation stays, and the measured volume over a bake is shown in the bake report, so loss is visible.

Targets, at cell size 0.025 m: standing wave loses under 3% of its height a period (today 10-18%) with the period within 1%; volume within 0.5% after 10 s of sloshing (today 1.2-1.6%); still water under 2 mm/s mean; dam break front within 10% of the measurements; swirl keeps over 90% of its energy; pressure left unsolved under the tolerance on every step. The meteor crown at least as tall and full as today.

## Phase 3: narrow band, ocean and tall cells on the new core

1. The narrow band's depth field becomes the liquid distance field from phase 2 (one field instead of two that can disagree).
2. Tall cells that come back: when calm water returns below the surface, its columns become tall again (today they never do), and their flow is carried along; ocean waves drive the tall cells at the tank's sides.
3. The two open questions from Mer's big ocean bake, checked with the new tests: the mean water height dropping between frames 0 and 3, and the bake reporting water at 238 m/s.
4. Splitting the particle buffer only if a measured scene needs more than one buffer holds (about 44M particles today).

## Phase 4: whitewater and air

1. The Houdini emission rules kept, but measured on the liquid distance field: crests from its curvature and the speed towards the outside, churn from the change in velocity. Same settings and looks.
2. Mist as a volume: a density field carried by the air field and drawn as soft see-through fog, thicker and controllable (density, how fast it fades, how much the air turbulence breaks it up). Smoke as a setting of the same volume (made by objects or sources, rising with heat).
3. A finer air field where the card has memory for it (the page capped it at about 260k cells).

## Phase 5: data, the new cache format

1. One new file format (.splc version 3), built for streaming and seeking:
   - Points stored in a fixed order that is the same in every frame and spreads evenly through the water, so any first part of a frame is an even sample (drawing fewer points is just drawing a shorter range).
   - Each frame stored as the difference from where the last two frames predict each point (motion prediction), quantized, then compressed (zstd). A full frame every 24 frames so any frame can be reached quickly, like video.
   - Velocity can be kept (for motion blur when rendering elsewhere, and so Bake whitewater no longer guesses it from the next frame).
   - Target: 3 to 5 times smaller than today's caches, and faster to read than the disk is to send it.
2. Old .splc files still open, and can be converted.
3. Export for Blender: points per frame (PLY sequence, with speed and velocity) and a meshed surface per frame (marching cubes over the liquid distance field on the GPU, OBJ or PLY sequence; Alembic if a Rust writer is good enough). OpenVDB later (writing VDB from Rust needs work).

## Phase 6: playback

1. Level of detail from the point order: fewer points far away, when the frame would be late or while scrubbing fast.
2. Frames decoded on the GPU from the compressed layout, so uploads are a fraction of today's.
3. The page's Bake playback Full / Smooth / Fast becomes this automatic level of detail with a quality setting.

## Phase 7: interface

1. The gaps from the page: smoothness test, saving live water as a cache, invert selection, the Back / Left / Bottom views, the page's real inset in edit mode.
2. Desktop comforts: recent files, scene autosave and recovery after a crash, a project folder (scene, bakes and exports kept together), a bake queue (several bakes in a row, overnight), a notice when a bake finishes, settings remembered between runs.
3. Panels for the new solver settings in plain words (pressure accuracy, smooth walls on/off, mist volume, export), with tooltips that say what each costs.

## Phase 8: Detail pass rework

Waits for Mer's ideas on how it should work. Things learned so far: fine water leaving the region should be kept, not killed; the fine sim should make its own whitewater; its settings belong in the cache file.

## Later

- Octree or adaptive grid (finer cells near the surface, coarser deep down), after tall cells are measured on the new core.
- Splitting very large scenes over the GPU and the CPU's memory.

## How each phase is checked

- `cargo test --release`: format, shaders, the accuracy tests, the reference numbers.
- The benchmark set on Mer's card before and after, numbers in the commit message.
- Pictures from `--picture` and screenshots of the window on her PC.
- Mer tries the testing copy; it is published when she says.
