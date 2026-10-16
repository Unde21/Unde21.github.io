#!/usr/bin/env bash
# build-app.sh FRONTEND_DIR OUT_DIR BASE_URL: the Kwizo web app for the demo.
# Works on a copy; the project's files are only changed in that copy:
# - app.config.js gets experiments.baseUrl (the app lives under BASE_URL)
# - metro.config.js gains an alias: socket.io-client -> long-polling wrapper
# - every exported page loads boot.js (backend in the page) first
set -euo pipefail
SRC="$1"; OUT="$2"; BASE="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
(cd "$SRC" && tar --exclude=./node_modules --exclude=./.expo --exclude=./.metro-cache --exclude=./zz_demo_seed.ts -cf - .) | (cd "$WORK" && tar -xf -)
ln -s "$SRC/node_modules" "$WORK/node_modules"
mkdir -p "$WORK/kwizo-demo" && cp "$HERE/socketio-polling.js" "$WORK/kwizo-demo/"
mv "$WORK/metro.config.js" "$WORK/metro.config.original.js" && cp "$HERE/metro.demo.js" "$WORK/metro.config.js"
python3 - "$WORK/app.config.js" "$BASE" <<'PY'
import sys
p, base = sys.argv[1], sys.argv[2]
s = open(p).read()
a = 'experiments: {'
assert a in s
s = s.replace(a, a + f'\n\t\t\tbaseUrl: "{base}",', 1)
open(p, 'w').write(s)
PY
cd "$WORK"
rm -rf "$OUT"
EXPO_PUBLIC_BACK_URL=https://kwizo.demo CI=1 EXPO_NO_TELEMETRY=1 npx expo export -p web --output-dir "$OUT" > "$WORK/export.log" 2>&1 || { tail -30 "$WORK/export.log"; exit 1; }
cp "$HERE/boot.js" "$OUT/kwizo-boot.js"
cp "$HERE/bots.js" "$OUT/kwizo-bots.js"
cp "$HERE/sw.js" "$OUT/kwizo-sw.js"
cp "$SRC/node_modules/socket.io-client/dist/socket.io.min.js" "$OUT/socket.io.min.js"
python3 - "$OUT" "$BASE" <<'PY'
import os, sys
out, base = sys.argv[1], sys.argv[2]
tag = f'<script src="{base}/kwizo-boot.js"></script>'
n = 0
for root, _, files in os.walk(out):
    for f in files:
        if f.endswith('.html'):
            p = os.path.join(root, f)
            s = open(p, encoding='utf-8').read()
            if 'kwizo-boot.js' not in s:
                s = s.replace('<head>', '<head>' + tag, 1)
                open(p, 'w', encoding='utf-8').write(s); n += 1
print('boot script added to', n, 'pages')
PY
rm -rf "$WORK"
