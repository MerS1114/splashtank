# Tests

All tests open `dist/SplashTank.html` in headless Chromium with a software GPU, so build first (`npm run build`). Screenshots and downloads go to `test-output/`. Run them one at a time.

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
- `wwarea.js`: the whitewater area: counts whitewater past the tank walls and above its top while Meteor lake runs, screenshot of the dashed area box; checks per-frame compact boxes (compactFrameBox) decode and survive a cache file. About 2 min.
- `hidden.js`: buried water in compact bakes (markInterior): how many points are marked, the draw time with them skipped and drawn, and how many pixels differ. About 2 min.
- `surface.js`: Draw water: Surface: screenshots a scene as points and as a surface and times a draw each way. `node tests/surface.js "Dam break" 0.05`.
- `redraw.js`: while the sim plays the live view redraws only for new sim frames; stopped, every frame (asserts, exits non-zero).
- `snap.js`, `gz.js`: older snapping and gizmo checks.
