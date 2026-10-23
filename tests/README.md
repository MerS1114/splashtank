# Tests

All tests open `dist/SplashTank.html` in headless Chromium with a software GPU, so build first (`npm run build`). Screenshots and downloads go to `test-output/`. Run them one at a time.

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
- `ww.js`: whitewater, air field and dripping: counts points by kind while a scene runs, screenshots in speed and type colours. `node tests/ww.js "Meteor lake" 90 0.08`.
- `snap.js`, `gz.js`: older snapping and gizmo checks.
