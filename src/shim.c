/*
 * util_cpu_time for the WebAssembly build (LIB-2).
 *
 * CUDD's own util_cpu_time (cudd/util/cpu_time.c) reads times(), which
 * Emscripten stubs to zero, so in WebAssembly the clock never advances and
 * CUDD's time limits (Cudd_SetTimeLimit, the reordering limits) never fire.
 * This version, with the same signature, returns wall-clock milliseconds from
 * CLOCK_MONOTONIC instead. In a single-threaded worker, wall time is the time
 * the computation took. It counts from the first call, so the value stays
 * small enough for wasm32's 32-bit long.
 *
 * build.sh compiles this file in place of cpu_time.c in the WebAssembly build
 * only; the native build keeps CUDD's CPU-time clock.
 */
#include <time.h>
#include "util.h"

long util_cpu_time(void) {
  static long long base = -1;
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  long long ms = (long long) t.tv_sec * 1000 + t.tv_nsec / 1000000;
  if (base < 0) base = ms;
  return (long) (ms - base);
}
