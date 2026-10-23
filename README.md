# SplashTank

A water simulator that runs in the browser: FLIP fluid on the GPU (WebGPU) with spray, white water, narrow band and ocean waves, a Blender-style interface, keyframed objects, a live cache and full-quality bakes.

**Open it:** https://mers1114.github.io/splashtank/ (Chrome or Edge with WebGPU). The same page works offline: download `SplashTank.html` from there and double-click it.

**Testing version:** https://mers1114.github.io/splashtank/testing/ — the newest work in progress from Claude's branch, for trying out before it goes into the main page. An orange label in the bottom left corner says which branch and commit it is.

## For development

    npm install
    npm run build     # writes dist/SplashTank.html
    npm test          # build + smoke test in headless Chromium

The source is in `src/`; `CLAUDE.md` describes how it fits together.
