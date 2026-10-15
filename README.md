# Portfolio — samaouch (42 Lyon)

A static site (GitHub Pages) that presents my 42 projects and makes them playable in the browser.

- `index.html`: home page
- `so_long.html`, `cub3d.html`: game pages
- `minishell.html`: web terminal (xterm.js) running the real minishell
- `webserv.html`: the real webserv running in the page, with a browser frame, a request log and a raw HTTP console
- `philosophers.html`: dining philosophers simulation (the program runs in a Web Worker started by `games/mlxweb/wasi-worker.js`)
- `games/`: programs compiled to WebAssembly, with their files (maps, textures, sounds)
- `coi-serviceworker.js`: enables cross-origin isolation on GitHub Pages (needed by the Cub3D bonus threads)
- `tools/mlxweb/`: the porting layer (MiniLibX for canvas, WASI runtime, threads, sound) and the build scripts

## Publishing

1. Create a public repository named `Unde21.github.io`.
2. Push the contents of this folder to it.
3. Settings → Pages → Source: branch `main`, folder `/ (root)`.
4. The site is served at https://unde21.github.io

## How the port works

The original C code is compiled as is with wasi-sdk. `tools/mlxweb/mlx_web.c` reimplements
the MiniLibX API: windows are canvases, images live in memory, and X11 hooks are fed by the
browser's keyboard and mouse. `mlx_loop()` hands control back to the browser every frame thanks
to Asyncify (Binaryen). Pthreads become Web Workers sharing memory (wasi-threads). `.xpm` files
are converted by `pack.py` into a more compact indexed format, read by the same
`mlx_xpm_file_to_image` function.

The only file replaced in the projects: `Cub3D/srcs_bonus/game/sound/init.c`
(`fork` + `cvlc` → browser audio), see `tools/mlxweb/ports/cub3d/`.

Philosophers bonus: `fork()` is replaced by `mlxweb_spawn()` in a copy of
`init_child_bonus.c` (`tools/mlxweb/ports/philosophers/`); `kill()`, `wait()`, `exit()` and
named semaphores are emulated by `tools/mlxweb/mlx_fibers.c`.

Minishell: built with `POSIX=1`, each process is a WebAssembly instance with its own memory.
`games/mlxweb/posix.js` acts as the kernel: `fork()` (memory copy, resumed through Asyncify),
`execve`, `waitpid`, pipes, `dup2`, signals, an in-memory file system and a terminal with a
line editor (the readline API is in `tools/mlxweb/mlx_posix.c`). The commands in `/bin`
(`ls`, `grep`, `sort`…) are written in JavaScript in `games/mlxweb/commands.js`. No minishell
file is modified.

webserv: C++98 built with the same `POSIX=1` mode. `tools/mlxweb/mlx_net.c` adds sockets,
`getaddrinfo` and `epoll` on top of a virtual network in `posix.js`; the page connects to port
8080 and speaks raw HTTP (`games/webserv/http-client.js`). A Service Worker
(`games/webserv/sw.js`) catches the requests of the iframe and hands them to the page, so the
team's website is browsed through webserv itself. The config is `www/config` plus one
`/cgi-bin/` location for JavaScript CGI scripts (`tools/mlxweb/ports/webserv/`), run by a small
node-like interpreter, because Python is not available in the browser. No webserv file is modified.

Web-only setting: the Cub3D bonus mouse sensitivity starts at 70 % of the pause-menu bar
(`sensitivity = 110` instead of 175), applied at build time by `tools/mlxweb/ports/build_all.sh`.

Rebuild: `tools/mlxweb/ports/build_all.sh` (wasi-sdk 25 + `npm i binaryen`).
