/* C glue between CUDD and the cudd-wasm API. */
#include "glue.h"

/*
 * Running out of memory must not end the program (LIB-3). CUDD has two
 * out-of-memory handlers:
 *
 *  - the manager's callback (Cudd_RegisterOutOfMemoryCallback), which CUDD
 *    installs only around its own large allocations: node blocks and the
 *    cache and unique-table resizes;
 *  - the global handler, MMoutOfMemory, which every other allocation uses.
 *    Node allocation also calls it as a last resort, after garbage
 *    collection fails. Its default, MMout_of_memory in util/safe_mem.c,
 *    calls exit(1).
 *
 * Both are set to Cudd_OutOfMemSilent, which returns. The allocation then
 * fails with NULL, CUDD sets CUDD_MEMORY_OUT, and the manager stays usable.
 * In WebAssembly, -sABORTING_MALLOC=0 makes malloc return NULL at the memory
 * ceiling instead of aborting.
 */
DdManager *cw_manager_new(unsigned int nvars) {
  static int installed = 0;
  if (!installed) {
    Cudd_InstallOutOfMemoryHandler(Cudd_OutOfMemSilent);
    installed = 1;
  }
  DdManager *dd = Cudd_Init(nvars, 0, CUDD_UNIQUE_SLOTS, CUDD_CACHE_SLOTS, 0);
  if (dd) Cudd_RegisterOutOfMemoryCallback(dd, Cudd_OutOfMemSilent);
  return dd;
}

const char *cw_error_name(Cudd_ErrorType code) {
  switch (code) {
    case CUDD_NO_ERROR: return "CUDD_NO_ERROR";
    case CUDD_MEMORY_OUT: return "CUDD_MEMORY_OUT";
    case CUDD_TOO_MANY_NODES: return "CUDD_TOO_MANY_NODES";
    case CUDD_MAX_MEM_EXCEEDED: return "CUDD_MAX_MEM_EXCEEDED";
    case CUDD_TIMEOUT_EXPIRED: return "CUDD_TIMEOUT_EXPIRED";
    case CUDD_TERMINATION: return "CUDD_TERMINATION";
    case CUDD_INVALID_ARG: return "CUDD_INVALID_ARG";
    case CUDD_INTERNAL_ERROR: return "CUDD_INTERNAL_ERROR";
  }
  return "unknown";
}
