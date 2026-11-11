/* C glue between CUDD and the cudd-wasm API. */
#include "glue.h"

DdManager *cw_manager_new(unsigned int nvars) {
  return Cudd_Init(nvars, 0, CUDD_UNIQUE_SLOTS, CUDD_CACHE_SLOTS, 0);
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
