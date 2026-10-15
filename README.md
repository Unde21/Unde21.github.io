# Portfolio — samaouch (42 Lyon)

Site statique (GitHub Pages) qui présente mes projets 42 et les rend jouables dans le navigateur.

- `index.html` : page d'accueil
- `so_long.html`, `cub3d.html` : pages de jeu
- `minishell.html` : terminal web (xterm.js) où tourne le vrai minishell
- `philosophers.html` : simulation du dîner des philosophes (programme lancé dans un Web Worker par `games/mlxweb/wasi-worker.js`)
- `games/` : programmes compilés en WebAssembly + leurs fichiers (cartes, textures, sons)
- `coi-serviceworker.js` : active l'isolation cross-origin sur GitHub Pages (nécessaire aux threads de Cub3D bonus)
- `tools/mlxweb/` : la couche de portage (MiniLibX pour canvas, runtime WASI, threads, sons) et les scripts de build

## Mise en ligne

1. Créer un dépôt public nommé `Unde21.github.io`.
2. Y pousser le contenu de ce dossier.
3. Settings → Pages → Source : branche `main`, dossier `/ (root)`.
4. Le site est servi sur https://unde21.github.io

## Comment le portage fonctionne

Le code C d'origine est compilé tel quel avec wasi-sdk. `tools/mlxweb/mlx_web.c` réimplémente
l'API de la MiniLibX : fenêtres = canvas, images en mémoire, hooks X11 alimentés par le clavier
et la souris du navigateur. `mlx_loop()` rend la main au navigateur à chaque image grâce à
Asyncify (Binaryen). Les pthreads deviennent des Web Workers qui partagent la mémoire
(wasi-threads). Les `.xpm` sont convertis par `pack.py` en un format indexé plus compact,
lu par la même fonction `mlx_xpm_file_to_image`.

Seul fichier remplacé dans les projets : `Cub3D/srcs_bonus/game/sound/init.c`
(`fork` + `cvlc` → audio du navigateur), voir `tools/mlxweb/ports/cub3d/`.

Philosophers bonus : `fork()` est remplacé par `mlxweb_spawn()` dans une copie de
`init_child_bonus.c` (`tools/mlxweb/ports/philosophers/`) ; `kill()`, `wait()`, `exit()` et les
sémaphores nommés sont émulés par `tools/mlxweb/mlx_fibers.c`.

Minishell : compilé avec `POSIX=1`, chaque processus est une instance WebAssembly avec sa
propre mémoire. `games/mlxweb/posix.js` fait office de noyau : `fork()` (copie de la mémoire
et reprise via Asyncify), `execve`, `waitpid`, pipes, `dup2`, signaux, un système de fichiers
en mémoire et un terminal avec éditeur de ligne (l'API readline est dans `tools/mlxweb/mlx_posix.c`).
Les commandes de `/bin` (`ls`, `grep`, `sort`…) sont écrites en JavaScript dans
`games/mlxweb/commands.js`. Aucun fichier de minishell n'est modifié.

Réglage propre à la version web : la sensibilité de la souris de Cub3D bonus démarre à 70 %
de la barre du menu pause (`sensitivity = 110` au lieu de 175), appliqué au moment du build
par `tools/mlxweb/ports/build_all.sh`.

Rebuild : `tools/mlxweb/ports/build_all.sh` (wasi-sdk 25 + `npm i binaryen`).
