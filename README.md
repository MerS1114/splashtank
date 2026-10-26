# SplashTank

A water simulator that runs in the browser: FLIP fluid on the GPU (WebGPU) with spray, white water, narrow band and ocean waves, a Blender-style interface, keyframed objects, a live cache and full-quality bakes.

**Open it:** https://mers1114.github.io/splashtank/ (Chrome or Edge with WebGPU). The same page works offline: download `SplashTank.html` from there and double-click it.

**Testing version:** https://mers1114.github.io/splashtank/testing/ — the newest work in progress from Claude's branch, for trying out before it goes into the main page. An orange label in the bottom left corner says which branch and commit it is.

## For development

    npm install
    npm run build     # writes dist/SplashTank.html (needs Python 3)
    npm test          # build + smoke test in headless Chromium

The source is in `src/`; `CLAUDE.md` describes how it fits together.

By default the tests run in a headless Chromium on a software GPU (SwiftShader, Linux only). That works anywhere, including Claude's cloud sessions, but it is many times slower than a real graphics card, so its speed numbers mean little.

## Running the tests on your own graphics card

On a computer with a real graphics card (for example with the Claude desktop app, in a session that runs on that computer), the tests can open your own Edge or Chrome in a window and use the card.

What the computer needs, once:

- Node.js, the LTS version (nodejs.org).
- Git (git-scm.com), to download this repository.
- Microsoft Edge or Google Chrome, up to date.
- Python 3 (python.org) only if you want to build the page from the source. To test the published pages you do not need it.

Download and set up, once (in a terminal, in the folder where you keep projects):

    git clone https://github.com/MerS1114/splashtank.git
    cd splashtank
    npm install

The Smoothness test and Solver benchmark (the ones in the Performance tab), run for you and saved to `test-output/gpu-report.txt`, with screenshots of the view as points and as a surface. In Windows PowerShell:

    $env:SPLASH_GPU = "1"
    $env:SPLASH_PAGE = "https://mers1114.github.io/splashtank/testing/"
    npm run gpu -- "Meteor lake" 0.03

On Mac or Linux:

    SPLASH_GPU=1 SPLASH_PAGE=https://mers1114.github.io/splashtank/testing/ npm run gpu -- "Meteor lake" 0.03

- `SPLASH_GPU=1` uses your installed Edge (or Chrome) on the real graphics card, in a visible window. Leave the window on screen and do not use the computer for anything heavy while it runs.
- `SPLASH_PAGE` picks the page to test: the testing page as above, the main page (https://mers1114.github.io/splashtank/), or leave it out to test your own build in `dist/`.
- The words after `--` are the scene, the spacing, and optionally a bake length in seconds (for example `"Meteor lake" 0.03 4`): with a bake, it first bakes that many seconds at Preview quality, so the Smoothness test also times bake playback.
- `SPLASH_BROWSER` points at a browser program if Edge and Chrome are not in their usual places.
- The report says which GPU WebGPU found. If it says SwiftShader, the browser fell back to software and the numbers are not the card's.
- Any other test runs the same way, for example `$env:SPLASH_GPU = "1"; node tests/surface.js "Dam break" 0.05` (see `tests/README.md`).

The GPU this was tuned for is Mer's work computer (Intel UHD Graphics 730); numbers from another card show how the page behaves there, not on that one.
