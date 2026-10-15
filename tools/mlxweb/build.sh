#!/usr/bin/env bash
# build.sh OUT.wasm [extra cflags...] -- sources...
# Compiles a MiniLibX program to WebAssembly with the mlx_web shim + Asyncify.
# THREADS=1 builds with wasi-threads (pthreads -> Web Workers, shared memory).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WASI="${WASI_SDK:-$HOME/work/wasi-sdk-25.0-x86_64-linux}"
WASMOPT="${WASM_OPT:-node $HOME/work/tools/node_modules/binaryen/bin/wasm-opt}"
OUT="$1"; shift
CFLAGS=(); SRCS=()
while [[ $# -gt 0 && "$1" != "--" ]]; do CFLAGS+=("$1"); shift; done
shift || true
SRCS=("$@")

CC="$WASI/bin/clang"
SYSROOT="$WASI/share/wasi-sysroot"
TMP="$(mktemp -d)"
TARGET=wasm32-wasip1
EXTRA_SRC=("$HERE/mlx_web.c" "$HERE/mlx_rgb.c" "$HERE/mlx_sound.c")
LDFLAGS=(-Wl,-z,stack-size=$((8*1024*1024)) -Wl,--export=malloc)
if [[ "${THREADS:-0}" == 1 ]]; then
  TARGET=wasm32-wasip1-threads
  CFLAGS+=(-pthread)
  EXTRA_SRC+=("$HERE/mlx_threads.c")
  LDFLAGS+=(-pthread -Wl,--import-memory -Wl,--export-memory -Wl,--shared-memory
    -Wl,--initial-memory=$((64*1024*1024)) -Wl,--max-memory=$((2048*1024*1024)))
elif [[ "${FIBERS:-0}" == 1 ]]; then
  CFLAGS+=(-D_WASI_EMULATED_PTHREAD)
  EXTRA_SRC+=("$HERE/mlx_fibers.c")
  LDFLAGS+=(-Wl,--export=__stack_pointer)
fi
ASYNC=(--pass-arg=asyncify-imports@mlxweb.yield,mlxweb.fiber_switch)
[[ "${FIBERS:-0}" == 1 ]] || ASYNC+=(--pass-arg=asyncify-ignore-indirect)
INC=(-I"$HERE/include")
if [[ "${POSIX:-0}" == 1 ]]; then
  # Command-line programs run by posix.js: one instance per process.
  EXTRA_SRC=("$HERE/mlx_posix.c")
  INC=(-I"$HERE/include-posix" -I"$HERE/include")
  LDFLAGS+=(-Wl,--export=__stack_pointer -Wl,--export-table)
  ASYNC=(--pass-arg=asyncify-imports@posix.fork,posix.waitpid,posix.readline,wasi_snapshot_preview1.fd_read,wasi_snapshot_preview1.fd_write,wasi_snapshot_preview1.poll_oneoff)
fi
COMMON=(--target=$TARGET --sysroot="$SYSROOT" -O2 "${INC[@]}"
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID
  -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types
  -Wno-unused-command-line-argument -Wno-deprecated-non-prototype)

"$CC" "${COMMON[@]}" "${CFLAGS[@]}" "${EXTRA_SRC[@]}" "${SRCS[@]}" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lm \
  "${LDFLAGS[@]}" -o "$TMP/raw.wasm"

$WASMOPT "$TMP/raw.wasm" -O2 --asyncify "${ASYNC[@]}" -o "$OUT"
rm -rf "$TMP"
ls -la "$OUT"
