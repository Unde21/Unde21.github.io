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
cp $M/runtime.js $M/runtime-worker.js $S/mlxweb/
