# Kwizo in the browser

`kwizo.html` runs the real Kwizo (ft_transcendence, private repository `Kwizo42/Kwizo`) without
any server: the Expo web app and the NestJS backend both run in the visitor's tab.

```
kwizo.html ── iframe ── games/kwizo/app/          Expo web export of frontend/
                          kwizo-boot.js           loaded first by every page
                          │  XMLHttpRequest / fetch to https://kwizo.demo
                          ▼
                        games/kwizo/backend.js    backend/project compiled with tsc,
                          Express + Nest           bundled with esbuild
                          Socket.io (long-polling)
                          Prisma 7 (WebAssembly query compiler)
                          ▼
                        PGlite                     PostgreSQL in WebAssembly,
                                                   stored in IndexedDB
```

## What is changed, and where

Nothing in the Kwizo sources. The demo build works on copies and adds:

| Piece | Why |
| --- | --- |
| `shims/http.js` | `http.createServer()` without sockets: Express and engine.io attach to it as usual, the page hands it requests. |
| `shims/adapter-pg.js` | Prisma's PostgreSQL adapter replaced by PGlite's (same SQL, same migrations). |
| `shims/prisma-client.js` | Prisma's edge client (WebAssembly query compiler) with longer transaction limits: PGlite has one connection, so transactions wait for each other instead of running side by side. |
| `shims/crypto.js`, `timers.js`, `globals.js`, … | The Node APIs the backend's libraries use (KeyObject for jsonwebtoken, `Timeout.refresh()` for engine.io, Buffer methods for busboy). |
| `bcrypt` → `bcryptjs` | Same hashes, pure JavaScript. |
| `app/boot.js` | Starts the backend in the page and routes the app's requests to it (an XMLHttpRequest stand-in), keeps cookies, persists the database and uploads. |
| `app/sw.js` | Images (`<img src>` of avatars and quiz pictures) are fetched through a service worker that asks the page. |
| `app/socketio-polling.js` | The app asks for WebSocket-only Socket.io; in the page it uses long-polling, which goes through the same bridge. Metro alias in `app/metro.demo.js`. |
| `app.config.js` (copy) | `experiments.baseUrl` so the app lives under `/games/kwizo/app`. |
| `AuthLayout.tsx` (copy) | `paddingBottom` on the phone layout, so the login footer links no longer sit on the box's rounded border. |
| `app/bots.js` | Extra players for a lobby, following `backend/project/scripts/realtime-quiz-client.ts`. |

OAuth sign-in (42, Google, GitHub) needs registered OAuth apps and a public callback URL, so the
demo uses email accounts.

## Data

`seed/make_seed.py` makes a copy of `frontend/init.ts` for the public demo: every email becomes
`<username>@kwizo.demo`, the two accounts of real people are renamed, and the bulk
`register-many`/`login-many` calls become one call per user (the bulk endpoints hash every
password inside one 5 s transaction, too slow on a small build machine). The script then fills
the database through the real API. `seed/play_games.mjs` plays a few sessions over Socket.io so
the leaderboards are not empty. All accounts use the password `Password!0`.

## Rebuild

```
tools/kwizo/build.sh /path/to/Kwizo /path/to/this/site
```

Node 22, npm and python3; about 15 minutes (the seeded games play in real time).
