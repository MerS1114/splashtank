#!/usr/bin/env python3
"""Builds dist/SplashTank.html: one self-contained page (double-click to open, no server needed).

The page is src/head.html (styles and layout) followed by three.js r128, then src/shared.js,
src/gpu.js + src/flip.js, src/presets.js and src/app.js as inline scripts. three.js comes from node_modules
(run `npm install` once)."""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = lambda *p: open(os.path.join(ROOT, 'src', *p), encoding='utf-8').read()

head = src('head.html')
head = re.sub(r'<link rel="preconnect"[^>]*>\n?', '', head)
head = re.sub(r'<link rel="stylesheet" href="https://fonts[^>]*>\n?', '', head)
tag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
three_path = os.path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js')
if not os.path.exists(three_path):
    sys.exit('three.js not found: run `npm install` first')
if tag not in head:
    sys.exit('head.html no longer has the three.js script tag that the build replaces')
three = open(three_path, encoding='utf-8').read()
head = head.replace(tag, '<script>\n' + three + '\n</script>')

out = (head
       + '\n<script id="shared">\n' + src('shared.js') + '\n</script>\n'
       + '<script>\n' + src('gpu.js') + '\n' + src('flip.js') + '\n</script>\n'
       + '<script>\n' + src('presets.js') + '\n</script>\n'
       + '<script>\n' + src('app.js') + '\n</script>\n</body>\n</html>\n')
os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
dst = os.path.join(ROOT, 'dist', 'SplashTank.html')
open(dst, 'w', encoding='utf-8').write(out)
print('built', os.path.relpath(dst, ROOT), round(len(out.encode('utf-8')) / 1024), 'KB')
