#!/usr/bin/env bash
# Builds the GitHub Pages site into site/:
#   site/index.html, site/SplashTank.html          the page from main (the version to use)
#   site/testing/index.html, site/testing/...      the page from the newest claude/* branch (work in progress, for trying out)
# Needs a checkout with all branches (fetch-depth: 0) and npm ci already run.
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch -q origin '+refs/heads/*:refs/remotes/origin/*' || true
rm -rf site && mkdir -p site/testing

git worktree remove --force .site-main 2>/dev/null || true
git worktree add -q --detach .site-main origin/main
ln -s "$PWD/node_modules" .site-main/node_modules
python3 .site-main/tools/build.py
cp .site-main/dist/SplashTank.html site/SplashTank.html
cp .site-main/dist/SplashTank.html site/index.html
git worktree remove --force .site-main

# the testing page: the most recently committed claude/* branch (main again if there is none)
br=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/remotes/origin/claude/*' | head -n 1)
[ -n "$br" ] || br=origin/main
git worktree remove --force .site-test 2>/dev/null || true
git worktree add -q --detach .site-test "$br"
ln -s "$PWD/node_modules" .site-test/node_modules
python3 .site-test/tools/build.py
info="Testing build: ${br#origin/} · $(git log -1 --format='%h, %cd' --date=format:'%d %b %H:%M UTC' "$br")"
python3 - "$info" .site-test/dist/SplashTank.html site/testing/SplashTank.html <<'PY'
import sys, html
info, src, dst = sys.argv[1:]
s = open(src, encoding='utf-8').read()
tag = ('<div style="position:fixed;left:8px;bottom:28px;z-index:9999;background:#b45309;color:#fff;font:12px system-ui,sans-serif;'
       'padding:2px 7px;border-radius:3px;pointer-events:none;opacity:.9">' + html.escape(info) + '</div>')
i = s.rfind('</body>')
s = s[:i] + tag + s[i:] if i >= 0 else s + tag
open(dst, 'w', encoding='utf-8').write(s)
PY
cp site/testing/SplashTank.html site/testing/index.html
git worktree remove --force .site-test
echo "site built: main + $br"
