/* C glue between CUDD and the cudd-wasm API. */
#ifndef CUDD_WASM_GLUE_H
#define CUDD_WASM_GLUE_H

#include <stdio.h> /* cudd.h uses FILE and size_t without including it */
#include "cudd.h"

/* A manager with nvars variables, the default table sizes and no memory limit. */
DdManager *cw_manager_new(unsigned int nvars);

/* CUDD's name for a Cudd_ReadErrorCode value, such as "CUDD_TIMEOUT_EXPIRED". */
const char *cw_error_name(Cudd_ErrorType code);

#endif
