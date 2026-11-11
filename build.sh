#!/usr/bin/env bash
# Build CUDD 3.0.0 from the vendored cudd/ sources, natively and to
# WebAssembly, with the programs that test it. cudd/ is never modified.
#
#   ./build.sh          both
#   ./build.sh native   native library (autotools, out of tree) and test programs
#   ./build.sh wasm     WebAssembly library (emcc, no autotools) and test programs
#
# Output: build/native/{spike,hardening}, build/wasm/{spike,hardening,hardening-64mb}.{mjs,wasm}
set -euo pipefail
cd "$(dirname "$0")"
target="${1:-all}"

INC=(-I src -I cudd/cudd -I cudd/mtr -I cudd/st -I cudd/epd -I cudd/util)

# The library's C sources, without dddmp, cplusplus, nanotrav or any test main.
SRCS=()
for d in cudd mtr st epd util; do
  for f in cudd/"$d"/*.c; do
    case "$(basename "$f")" in testcudd.c|testextra.c|testmtr.c|testst.c) continue ;; esac
    SRCS+=("$f")
  done
done

build_native() {
  mkdir -p build/native
  if [ ! -f build/native/cudd/.libs/libcudd.a ]; then
    # A git checkout gives every file a new time, so make would see autotools'
    # outputs as older than their inputs and try to regenerate them. Configure
    # from a copy whose files all share one time; cudd/ itself is untouched.
    rm -rf build/cudd-src
    cp -R cudd build/cudd-src
    find build/cudd-src -exec touch -h -d @1451606400 {} +
    # configure applies CUDD's default flags (-Wall -Wextra -g -O3) only when
    # CFLAGS is unset; an exported empty CFLAGS would build it unoptimised.
    (cd build/native && env -u CFLAGS ../cudd-src/configure && make -j"$(nproc)")
  fi
  # -I build/native comes first, so its config.h wins over src/config.h (wasm32).
  local cc=(gcc -O3 -Wall -Wextra -I build/native -I cudd/cudd -I cudd/mtr -I cudd/st -I cudd/epd -I cudd/util -I src)
  local lib=build/native/cudd/.libs/libcudd.a
  "${cc[@]}" src/spike.c "$lib" -lm -o build/native/spike
  "${cc[@]}" test/hardening.c src/glue.c "$lib" -lm -o build/native/hardening
  echo "native: build/native/spike, build/native/hardening"
}

# Link flags shared by every WebAssembly program. Memory grows up to a 1 GB
# ceiling, and at the ceiling malloc returns NULL instead of aborting, so CUDD
# reports CUDD_MEMORY_OUT (LIB-3).
WASM_LINK=(-O3 -sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1
  -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1
  -sMAXIMUM_MEMORY=1GB -sABORTING_MALLOC=0)

build_wasm() {
  command -v emcc >/dev/null || { echo "emcc not found: run ./bootstrap.sh, then source ~/emsdk/emsdk_env.sh" >&2; exit 1; }
  local out=build/wasm
  rm -rf "$out/obj"
  mkdir -p "$out/obj"

  # src/config.h must state wasm32's real type sizes.
  cat > "$out/sizes.c" <<'EOF'
#include "config.h"
_Static_assert(sizeof(int) == SIZEOF_INT, "SIZEOF_INT");
_Static_assert(sizeof(long) == SIZEOF_LONG, "SIZEOF_LONG");
_Static_assert(sizeof(void *) == SIZEOF_VOID_P, "SIZEOF_VOID_P");
_Static_assert(sizeof(long double) == SIZEOF_LONG_DOUBLE, "SIZEOF_LONG_DOUBLE");
EOF
  emcc -I src -c "$out/sizes.c" -o "$out/obj/sizes.o"

  # The library: CUDD's sources, with src/shim.c in place of util/cpu_time.c
  # (LIB-2), plus the C glue. Each compile is waited on, so a failure stops
  # the build.
  local lib_srcs=() objs=() pids=()
  for f in "${SRCS[@]}"; do
    [ "$f" = cudd/util/cpu_time.c ] || lib_srcs+=("$f")
  done
  lib_srcs+=(src/shim.c src/glue.c)
  for f in "${lib_srcs[@]}"; do
    local o="$out/obj/$(basename "$(dirname "$f")")_$(basename "${f%.c}").o"
    objs+=("$o")
    emcc -O3 "${INC[@]}" -c "$f" -o "$o" &
    pids+=($!)
    if (( ${#pids[@]} >= $(nproc) )); then for p in "${pids[@]}"; do wait "$p"; done; pids=(); fi
  done
  for p in "${pids[@]}"; do wait "$p"; done
  rm -f "$out/libcudd.a"
  emar rcs "$out/libcudd.a" "${objs[@]}"

  emcc "${WASM_LINK[@]}" "${INC[@]}" src/spike.c "$out/libcudd.a" -o "$out/spike.mjs" \
    -sEXPORTED_FUNCTIONS=_spike_run -sEXPORTED_RUNTIME_METHODS=UTF8ToString
  emcc "${WASM_LINK[@]}" "${INC[@]}" test/hardening.c "$out/libcudd.a" -o "$out/hardening.mjs" \
    -sEXPORTED_FUNCTIONS=_hardening_run -sEXPORTED_RUNTIME_METHODS=ccall
  # The same checks with a 64 MB ceiling, to reach out-of-memory quickly.
  emcc "${WASM_LINK[@]}" -sMAXIMUM_MEMORY=64MB "${INC[@]}" test/hardening.c "$out/libcudd.a" \
    -o "$out/hardening-64mb.mjs" -sEXPORTED_FUNCTIONS=_hardening_run -sEXPORTED_RUNTIME_METHODS=ccall
  echo "wasm: $out/spike.mjs, $out/hardening.mjs, $out/hardening-64mb.mjs"
}

case "$target" in
  native) build_native ;;
  wasm) build_wasm ;;
  all) build_native; build_wasm ;;
  *) echo "usage: $0 [native|wasm]" >&2; exit 2 ;;
esac
