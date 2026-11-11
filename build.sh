#!/usr/bin/env bash
# Build the Phase 0 spike: CUDD 3.0.0 from the vendored cudd/ sources, plus the
# src/spike.c harness, natively and to WebAssembly. cudd/ is never modified.
#
#   ./build.sh          both
#   ./build.sh native   native library (autotools, out of tree) and harness
#   ./build.sh wasm     WebAssembly library (emcc, no autotools) and harness
#
# Output: build/native/spike, build/wasm/spike.mjs and build/wasm/spike.wasm.
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
    # configure applies CUDD's default flags (-Wall -Wextra -g -O3) only when
    # CFLAGS is unset; an exported empty CFLAGS would build it unoptimised.
    (cd build/native && env -u CFLAGS ../../cudd/configure && make -j"$(nproc)")
  fi
  # The harness against the native library; -I build/native for its config.h.
  gcc -O3 -Wall -Wextra -I cudd/cudd -I cudd/mtr -I cudd/st -I cudd/epd -I cudd/util -I build/native \
    src/spike.c build/native/cudd/.libs/libcudd.a -lm -o build/native/spike
  echo "native: build/native/spike"
}

build_wasm() {
  command -v emcc >/dev/null || { echo "emcc not found: source ~/emsdk/emsdk_env.sh" >&2; exit 1; }
  local out=build/wasm
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

  local objs=() jobs=0
  for f in "${SRCS[@]}"; do
    local o="$out/obj/$(basename "$(dirname "$f")")_$(basename "${f%.c}").o"
    objs+=("$o")
    emcc -O3 "${INC[@]}" -c "$f" -o "$o" &
    if (( ++jobs >= $(nproc) )); then wait -n; jobs=$((jobs - 1)); fi
  done
  wait

  local shim=()
  [ -f src/shim.c ] && shim=(src/shim.c)
  emcc -O3 "${INC[@]}" src/spike.c "${shim[@]}" "${objs[@]}" -o "$out/spike.mjs" \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1 \
    -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1 \
    -sEXPORTED_FUNCTIONS=_spike_run -sEXPORTED_RUNTIME_METHODS=UTF8ToString
  echo "wasm: $out/spike.mjs, $out/spike.wasm"
}

case "$target" in
  native) build_native ;;
  wasm) build_wasm ;;
  all) build_native; build_wasm ;;
  *) echo "usage: $0 [native|wasm]" >&2; exit 2 ;;
esac
