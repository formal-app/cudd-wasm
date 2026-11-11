#!/usr/bin/env bash
# Install the pinned Emscripten toolchain into ~/emsdk (or $EMSDK_DIR).
# Every WebAssembly build uses this one version, so results are reproducible.
#
#   ./bootstrap.sh                 install (skipped when already installed)
#   source ~/emsdk/emsdk_env.sh    then put emcc on the PATH
set -euo pipefail

EMSCRIPTEN_VERSION=7.0.0
dir="${EMSDK_DIR:-$HOME/emsdk}"

if [ ! -d "$dir/.git" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk "$dir"
fi
cd "$dir"
if ! ./emsdk list 2>/dev/null | grep -qE "^\s+\*?\s*$EMSCRIPTEN_VERSION\s+INSTALLED"; then
  ./emsdk install "$EMSCRIPTEN_VERSION"
fi
./emsdk activate "$EMSCRIPTEN_VERSION" >/dev/null
# shellcheck disable=SC1091
source ./emsdk_env.sh >/dev/null 2>&1
emcc --version | head -1
