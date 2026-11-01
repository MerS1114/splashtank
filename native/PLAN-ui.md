# SplashTank: interface and scenes plan

Mer's choices, 2026-10-31: the interface comes first, with more quality of life, information and organisation. Then the features below.
Not wanted yet: a built-in render and water pushing objects.

## Stage 1: settings that are easy to find

1. Interface size, remembered.
2. Simple and All views of the Simulation tab. Search always covers everything.
3. Pinned settings: right-click any setting to keep it in a Pinned group at the top.
4. A mark on settings that change the picture at once; the rest simulate again.
5. Undo for every setting, look settings too.
6. A short description at the top of each group, saying what it does for the shot.
7. The same treatment for the Object, Scene, Bake, Display and Performance tabs: fewer loose rows, the same layout, the same mark.
8. Changed settings: a view showing only what differs from the default, with reset for a whole group.

## Stage 2: information while working

1. Heads-up display over the viewport: points, substeps, memory, time a frame, time left. Off with one key.
2. Warnings in plain words: water at the speed limit, out of particles, not enough video memory, the disk holding the bake back. Each says what to do and which frame.
3. Check my scene before a bake: objects outside the tank, open shapes, spacing too fine for the card, water missing, no whitewater area.
4. A clearer bake estimate: time as well as size and memory, from the last frames baked on this computer.

## Stage 3: faster tuning

1. Shot presets: pick a kind of shot, a size and a quality; the settings are filled in. Everything stays editable.
2. Bake versions: each bake kept with its settings and a small picture, in a list; a note on each; what changed between two.
3. Compare two bakes side by side or with a wipe.
4. Quick preview: a low resolution bake of just the frames in a chosen range, starting from a saved checkpoint.
5. Surface preview: the export's mesh for one paused frame.

## Stage 4: features

1. Force fields: wind, vortex and turbulence objects to place and key, acting on water, whitewater and mist.
2. Emission regions and kill zones: mist or foam only from a chosen object or box; boxes that remove water.
3. Viscosity and surface tension.

## Resolution: making a preview behave like the final

Measured on Meteor lake (accuracy.rs res_crown, --ignored). Water above the surface stays about the same from spacing 0.04 to 0.02 (0.81-0.99 at frame 18, 1.10-1.28 at frame 24, no steady trend). The top of the crown rises faster at finer spacing: 99% height 1.79 at 0.04 against 2.46 at 0.02 at frame 18, then all reach about 3.1-3.5 by frame 48. Keeping the narrow band the same depth in metres did not change that. So fine, fast sheets are the difference: a coarse grid averages them with slower water around them, and that part cannot be fully removed.

1. Everything set in cells or per particle becomes the same in real sizes: narrow band depth, whitewater amount and mist by volume of water, not by particle count (the point count rises eight times from 0.04 to 0.02). Measure each first.
2. Guided finals, as in Houdini: the fine bake follows the approved coarse bake's large motion and adds only its own detail, so the final keeps the preview's behaviour. Mer's decision, 2026-10-31: this is the plan for the Detail pass rework (phase 8). Not now.

## Preset scenes

On hold: Mer is gathering a set of images of what each preset should be. Do not remake them until those arrive; the notes below are only a starting point.

Meteor lake stays the standard: a clear event, a sense of scale, a strong silhouette, whitewater and mist, and a settled ending. Each preset gets the same treatment: real scale, a camera that frames the shot, a moment worth watching in the first two seconds, tuned whitewater and mist, a short note saying what it shows off, and a bake that fits Mer's card at the default spacing. They are built and baked one at a time, and Mer judges them.

1. Wave tank: today a block in a tank with a hose. Becomes a surf pool: a real paddle sweeping waves down a long tank, breaking on a sloped beach with foam and backwash, and a rock to hit. Shows breaking waves and foam.
2. Dam break: today a tiny tank. Becomes a town street scale break: a tall gate lifts, water runs down a channel past blocks and pillars, climbs a wall at the end. Shows impact, sheets and floor drag.
3. Waterfall: today a tall stack of ledges. Becomes one cliff and one deep plunge pool: a broad river over a lip, curtain breaking into spray, mist rising from the pool, rocks at the base. Shows mist and smoke settings at their best.
4. Cascade: today many small parts. Becomes a mountain stream: fewer, bigger rocks, stepped pools, white water between them. Shows smooth walls and foam along the banks.
5. Ocean: today a hull on waves. Becomes a storm at sea: big swell, a ship pitching on keys, bow spray, wind-torn crests, mist low over the water. Shows the ocean, wind and air.
6. Fountain: today a jet on a ball. Becomes a garden fountain: several jets in a timed pattern from a stone basin that overflows into a lower pool. Shows sources, keys and drips.
7. Underwater blast: today a growing ball. Becomes a depth charge in a harbour: a dark column rising, a white dome, then collapse and a ring wave against a quay wall. Shows growing objects and big plumes.
8. New, one or two: a boulder dropped in a pool at small scale for a clean crown, and a glass filling from a tap, once viscosity and surface tension exist.
