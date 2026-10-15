#!/usr/bin/env bash
# Rebuild every ported game into the site folder.
set -euo pipefail
M=~/work/mlxweb; S=~/work/site/games
pm() { make -s -f Makefile -f /tmp/claude-0/print.mk print-$1; }
printf 'print-%%:\n\t@echo $($*)\n' > /tmp/claude-0/print.mk

cd ~/work/So_long
SRCB=$(sed -n '/^SRCSB/,/^$/p' Makefile | grep -oE 'srcs_bonus/[^ \\]+\.c')
$M/build.sh $S/so_long/so_long.wasm -Iincludes -Ilibft -- $SRCB libft/libft.a

cd ~/work/Cub3D
LIBS=$(find lib -name "*.c" | grep -v test)
CF=(-O3 -DDEBUG_VALUE=0 -DDEBUG_VALUE_BONUS=0 -Ilib/printf_fd_buffer/header -Ilib/t_lst/header -Ilib/gnl/header)
$M/build.sh $S/cub3d/cub3d.wasm "${CF[@]}" -Iincludes/header_mandatory -- $(pm FILES) $LIBS
# Web-only tweak: default mouse sensitivity at 70 % of the pause-menu bar.
# The bar fills (320 - sensitivity) / 300, so 70 % = 110 (the repo uses 175).
PORT_TMP=$(mktemp -d)
sed 's/data->sensitivity = 175;/data->sensitivity = 110;/' srcs_bonus/parsing/init/utils.c > $PORT_TMP/init_utils.c
grep -q 'sensitivity = 110' $PORT_TMP/init_utils.c
FB=$(pm FILES_BONUS | tr ' ' '\n' | grep -v "srcs_bonus/game/sound/init.c" | sed "s#^srcs_bonus/parsing/init/utils.c\$#$PORT_TMP/init_utils.c#" | tr '\n' ' ')
case "$FB" in *init_utils.c*) ;; *) echo "utils.c not found in FILES_BONUS" >&2; exit 1;; esac
THREADS=1 $M/build.sh $S/cub3d/cub3d_bonus.wasm "${CF[@]}" -Iincludes/header_bonus -- $FB $M/ports/cub3d/sound_init_web.c $LIBS
FIBERS=1 $M/build.sh $S/cub3d/cub3d_bonus_st.wasm "${CF[@]}" -Iincludes/header_bonus -- $FB $M/ports/cub3d/sound_init_web.c $LIBS

cd ~/work/Philosophers/philo
FIBERS=1 $M/build.sh $S/philosophers/philo.wasm -DFIBER_STACK=65536 -DFIBER_ABUF=16384 -Iincludes -- srcs/*.c
cd ~/work/Philosophers/philo_bonus
# fork() -> mlxweb_spawn() in a web copy of init_child_bonus.c; exit() ends only the calling "process"
FIBERS=1 $M/build.sh $S/philosophers/philo_bonus.wasm -Dexit=mlxweb_exit -DFIBER_STACK=65536 -DFIBER_ABUF=16384 -Iincludes -- \
  $(ls srcs_bonus/*.c | grep -v init_child_bonus.c) $M/ports/philosophers/init_child_web.c

cd ~/work/Minishell
# POSIX=1: one wasm instance per process, run by games/mlxweb/posix.js (fork copies memory).
# main(ac, av, envp) and chdir() are wrapped by mlx_posix.c; the sources are unchanged.
PATH=$M/bin:$PATH make -s -C libft CC=cc
POSIX=1 $M/build.sh $S/minishell/minishell.wasm -Dmain=mlxweb_user_main -DMLXWEB_MAIN_ENVP -Dchdir=mlxweb_chdir \
  -Iincludes -Ilibft -- $(sed -n '/^SRCS/,/^$/p' Makefile | grep -oE 'srcs/[^ \\]+\.c') libft/libft.a
python3 $M/ports/minishell/pack_src.py . $S/minishell/src.json

cd ~/work/webserv
# C++98 + sockets/epoll/fork: POSIX=1 with the virtual network of posix.js (mlx_net.c).
POSIX=1 $M/build.sh $S/webserv/webserv.wasm -std=c++98 -Iincludes -Iincludes/engine -Iincludes/response \
  -Iincludes/server -Iincludes/utils -- $(pm FILES)
# The site files: www/ and file/ from the repo, plus web.conf (www/config + a
# /cgi-bin/ location) and the JavaScript CGI demos (no Python in the browser).
WS_STAGE=$(mktemp -d)
cp -r www file $WS_STAGE/ && cp -r $M/ports/webserv/cgi-bin $WS_STAGE/www/ && cp $M/ports/webserv/web.conf $WS_STAGE/
python3 $M/pack.py $S/webserv/site $WS_STAGE web.conf www file

cp $M/runtime.js $M/runtime-worker.js $S/mlxweb/
