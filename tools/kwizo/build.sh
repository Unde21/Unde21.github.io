#!/usr/bin/env bash
# build.sh KWIZO_REPO SITE_DIR — rebuilds games/kwizo/ of the portfolio from a
# checkout of Kwizo42/Kwizo (private). Steps:
#   1. backend: prisma generate + tsc, then bundled for the browser
#   2. data: the real backend runs in Node on PGlite, the project's seed
#      script (frontend/init.ts, anonymised copy) fills it through the API,
#      a few games are played over Socket.io, the database is dumped
#   3. app: Expo web export with the demo settings (app/build-app.sh)
# Needs Node 22, npm and python3. The Kwizo sources are never modified.
set -euo pipefail
K="$(cd "$1" && pwd)"; SITE="$(cd "$2" && pwd)"; HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$SITE/games/kwizo"; WORK="$(mktemp -d)"
(cd "$HERE" && npm ci --no-audit --no-fund 2>/dev/null || npm i --no-audit --no-fund)

echo "== 1. backend"
BE="$K/backend/project"
(cd "$BE" && npm ci --ignore-scripts --no-audit --no-fund && npm rebuild bcrypt)
printf '#!/bin/sh\necho schema-engine 0\n' > "$WORK/schema-engine" && chmod +x "$WORK/schema-engine"
(cd "$BE" && PRISMA_SCHEMA_ENGINE_BINARY="$WORK/schema-engine" DATABASE_URL=postgresql://x@localhost/db npx prisma generate)
(cd "$BE" && npx tsc -p tsconfig.build.json --outDir "$WORK/dist")
rm -rf "$HERE/be" && mkdir -p "$HERE/be" && cp -r "$WORK/dist/src" "$HERE/be/src" && cp -r "$BE/prisma" "$HERE/be/" && ln -s "$BE/node_modules" "$HERE/be/node_modules"
mkdir -p "$OUT" && node "$HERE/build-backend.mjs" "$OUT/backend.js"
cp "$HERE/node_modules/@electric-sql/pglite/dist/pglite.wasm" "$HERE/node_modules/@electric-sql/pglite/dist/pglite.data" "$OUT/"

echo "== 2. data"
FE="$K/frontend"
(cd "$FE" && npm ci --ignore-scripts --no-audit --no-fund)
python3 "$HERE/seed/make_seed.py" "$FE/init.ts" "$FE/zz_demo_seed.ts"
UV_THREADPOOL_SIZE=16 node "$HERE/node/run.js" "$HERE/be" "$WORK/pgdata" 8080 > "$WORK/backend.log" 2>&1 &
PID=$!
for i in $(seq 60); do curl -s -o /dev/null localhost:8080/api/users/me && break; sleep 1; done
(cd "$FE" && SEED_API=http://localhost:8080/api npx tsx zz_demo_seed.ts)
SOCKET_IO_CLIENT="$BE/node_modules/socket.io-client" node "$HERE/seed/play_games.mjs" http://localhost:8080
kill $PID; sleep 2; rm -f "$FE/zz_demo_seed.ts"
node "$HERE/node/dump.mjs" "$WORK/pgdata" "$OUT/kwizo-seed.tar.gz"

echo "== 3. app"
bash "$HERE/app/build-app.sh" "$FE" "$OUT/app" /games/kwizo/app
rm -rf "$WORK"
du -sh "$OUT"
