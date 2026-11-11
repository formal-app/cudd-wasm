/* C glue between CUDD and the cudd-wasm API. */
#ifndef CUDD_WASM_GLUE_H
#define CUDD_WASM_GLUE_H

#include <stdio.h> /* cudd.h uses FILE and size_t without including it */
#include "cudd.h"

/*
 * The most variables a manager may have (LIB-5). CUDD's recursions go one call
 * per variable level, and the JavaScript engine's call stack, not Emscripten's,
 * is the limit: about 2,750 levels in a Chromium Web Worker. 1,000 variables
 * keeps the deepest recursion under half of that. Session (T2) enforces it.
 */
#define CW_MAX_VARS 1000

/* A manager with nvars variables and the default table sizes, whose
 * allocation failures return CUDD_MEMORY_OUT instead of ending the program. */
DdManager *cw_manager_new(unsigned int nvars);

/* CUDD's name for a Cudd_ReadErrorCode value, such as "CUDD_TIMEOUT_EXPIRED". */
const char *cw_error_name(Cudd_ErrorType code);

#endif
