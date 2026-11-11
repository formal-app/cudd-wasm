/*
 * T1 hardening checks, run natively and in WebAssembly. Each scenario prints
 * (native) or returns (WebAssembly, hardening_run) one JSON object, and
 * test/hardening.test.mjs asserts the acceptance criteria on it.
 *
 *   time     LIB-2: a 50 ms limit stops a longer computation; a fresh
 *            operation succeeds after clearing
 *   reorder  LIB-2: sifting under a 50 ms limit stops early, and every
 *            function is unchanged
 *   oom      LIB-3: running out of memory returns NULL with CUDD_MEMORY_OUT,
 *            and the manager stays usable (run in the 64 MB build)
 *   maxlive  LIB-4: CUDD's own live-node ceiling stops an operation with
 *            CUDD_TOO_MANY_NODES, and the manager stays usable
 *   deep     LIB-5: two 10,000-variable conjunction chains, their AND, then
 *            Cudd_CountMinterm and Cudd_DagSize; the deepest recursion here
 *   limits   the WebAssembly heap ceiling and stack size this build has
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "cudd.h"
#include "glue.h"
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/stack.h>
#endif

static char out[4096];

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

/* Replaces *acc by op(*acc, g), dereferencing both inputs. Returns 0 on failure. */
static int fold(DdManager *dd, DdNode **acc, DdNode *g, DdNode *(*op)(DdManager *, DdNode *, DdNode *)) {
  DdNode *r = op(dd, *acc, g);
  if (r) Cudd_Ref(r);
  Cudd_RecursiveDeref(dd, g);
  Cudd_RecursiveDeref(dd, *acc);
  *acc = r;
  return r != NULL;
}

/* f = x0·y0 + ... + x(n-1)·y(n-1), with xi = variable base+i and yi = variable
 * base+n+i. Built in this separated order it has 2^(n+1) - 1 nodes, and its
 * best order (each yi next to its xi) has 2n + 1. Referenced, or NULL. */
static DdNode *xy_sum(DdManager *dd, int base, int n) {
  DdNode *f = Cudd_ReadLogicZero(dd);
  Cudd_Ref(f);
  for (int i = 0; i < n; i++) {
    DdNode *p = Cudd_bddAnd(dd, Cudd_bddIthVar(dd, base + i), Cudd_bddIthVar(dd, base + n + i));
    if (!p) { Cudd_RecursiveDeref(dd, f); return NULL; }
    Cudd_Ref(p);
    if (!fold(dd, &f, p, Cudd_bddOr)) return NULL;
  }
  return f;
}

/* ── LIB-2: a time limit stops a computation ─────────────────────────────── */

#ifndef TIME_PAIRS
#define TIME_PAIRS 19
#endif
#define LIMIT_MS 50

static void scenario_time(void) {
  /* The computation without a limit, for its length. */
  DdManager *dd = cw_manager_new(2 * TIME_PAIRS);
  double t0 = now_ms();
  DdNode *f = xy_sum(dd, 0, TIME_PAIRS);
  double unlimitedMs = now_ms() - t0;
  int unlimitedOk = f != NULL;
  if (f) Cudd_RecursiveDeref(dd, f);
  Cudd_Quit(dd);

  /* The same computation under a 50 ms limit. */
  dd = cw_manager_new(2 * TIME_PAIRS);
  Cudd_SetTimeLimit(dd, LIMIT_MS);
  Cudd_ResetStartTime(dd);
  t0 = now_ms();
  f = xy_sum(dd, 0, TIME_PAIRS);
  double limitedMs = now_ms() - t0;
  int limitedNull = f == NULL;
  Cudd_ErrorType limitedError = Cudd_ReadErrorCode(dd);
  if (f) Cudd_RecursiveDeref(dd, f);

  /* After clearing, a fresh operation in the same manager succeeds. */
  Cudd_ClearErrorCode(dd);
  Cudd_ResetStartTime(dd);
  DdNode *g = xy_sum(dd, 0, 4);
  int freshOk = g != NULL;
  int freshSize = g ? Cudd_DagSize(g) : -1;
  Cudd_ErrorType freshError = Cudd_ReadErrorCode(dd);
  if (g) Cudd_RecursiveDeref(dd, g);
  int zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);

  snprintf(out, sizeof out,
    "{\"scenario\":\"time\",\"limitMs\":%d,\"unlimitedOk\":%d,\"unlimitedMs\":%.1f,"
    "\"limitedNull\":%d,\"limitedMs\":%.1f,\"limitedError\":\"%s\","
    "\"freshOk\":%d,\"freshSize\":%d,\"freshError\":\"%s\",\"zeroRef\":%d}",
    LIMIT_MS, unlimitedOk, unlimitedMs, limitedNull, limitedMs, cw_error_name(limitedError),
    freshOk, freshSize, cw_error_name(freshError), zeroRef);
}

/* ── LIB-2: reordering under a time limit stops early ────────────────────── */

/*
 * CUDD checks the time limit between variables while sifting, not inside one
 * variable's sift. So the workload is many independent blocks: each variable
 * is quick to sift, and a run that stops at the limit stops well before the
 * end. BLOCKS functions, each an xy_sum of PAIRS pairs on its own variables.
 */
#ifndef BLOCKS
#define BLOCKS 30
#endif
#ifndef PAIRS
#define PAIRS 14
#endif
#define NVARS (BLOCKS * 2 * PAIRS)

typedef struct { double ms; int ret, sizeBefore, sizeAfter; Cudd_ErrorType error; } Sift;

static int build_blocks(DdManager *dd, DdNode **fn) {
  for (int b = 0; b < BLOCKS; b++)
    if (!(fn[b] = xy_sum(dd, b * 2 * PAIRS, PAIRS))) return 0;
  return 1;
}

/* Builds the blocks, then sifts with the given limit (0 = none). */
static DdManager *sift(Sift *s, int limitMs, DdNode **fn) {
  DdManager *dd = cw_manager_new(NVARS);
  build_blocks(dd, fn);
  s->sizeBefore = Cudd_SharingSize(fn, BLOCKS);
  if (limitMs) Cudd_SetTimeLimit(dd, limitMs);
  Cudd_ResetStartTime(dd);
  double t0 = now_ms();
  s->ret = Cudd_ReduceHeap(dd, CUDD_REORDER_SIFT, 0);
  s->ms = now_ms() - t0;
  s->error = Cudd_ReadErrorCode(dd);
  s->sizeAfter = Cudd_SharingSize(fn, BLOCKS);
  Cudd_UnsetTimeLimit(dd);
  return dd;
}

static void scenario_reorder(void) {
  DdNode *fn[BLOCKS], *again[BLOCKS];
  Sift full, limited;

  DdManager *dd = sift(&full, 0, fn);
  for (int b = 0; b < BLOCKS; b++) Cudd_RecursiveDeref(dd, fn[b]);
  Cudd_Quit(dd);

  /* Under the limit; then rebuild every function in the reordered manager.
   * BDDs are canonical in one manager, so the same node means the same function. */
  dd = sift(&limited, LIMIT_MS, fn);
  int rebuilt = build_blocks(dd, again);
  int unchanged = rebuilt;
  for (int b = 0; b < BLOCKS; b++) {
    if (again[b] != fn[b]) unchanged = 0;
    Cudd_RecursiveDeref(dd, again[b]);
    Cudd_RecursiveDeref(dd, fn[b]);
  }
  int zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);

  snprintf(out, sizeof out,
    "{\"scenario\":\"reorder\",\"limitMs\":%d,\"functions\":%d,\"vars\":%d,"
    "\"full\":{\"ms\":%.1f,\"ret\":%d,\"sizeBefore\":%d,\"sizeAfter\":%d,\"error\":\"%s\"},"
    "\"limited\":{\"ms\":%.1f,\"ret\":%d,\"sizeBefore\":%d,\"sizeAfter\":%d,\"error\":\"%s\"},"
    "\"unchanged\":%d,\"zeroRef\":%d}",
    LIMIT_MS, BLOCKS, NVARS,
    full.ms, full.ret, full.sizeBefore, full.sizeAfter, cw_error_name(full.error),
    limited.ms, limited.ret, limited.sizeBefore, limited.sizeAfter, cw_error_name(limited.error),
    unchanged, zeroRef);
}

/* ── LIB-3: running out of memory is recoverable ─────────────────────────── */

/* At 2^(OOM_PAIRS+1) nodes, this function needs far more than 64 MB. */
#ifndef OOM_PAIRS
#define OOM_PAIRS 24
#endif

static void scenario_oom(void) {
  DdManager *dd = cw_manager_new(2 * OOM_PAIRS);
  if (!dd) {
    snprintf(out, sizeof out, "{\"scenario\":\"oom\",\"managerOk\":0}");
    return;
  }
  DdNode *f = xy_sum(dd, 0, OOM_PAIRS);
  int failedNull = f == NULL;
  Cudd_ErrorType failedError = Cudd_ReadErrorCode(dd);
  double memoryMB = Cudd_ReadMemoryInUse(dd) / 1048576.0;
  long peakLive = Cudd_ReadPeakLiveNodeCount(dd);
  if (f) Cudd_RecursiveDeref(dd, f);

  /* After clearing, the same manager computes again. */
  Cudd_ClearErrorCode(dd);
  DdNode *g = xy_sum(dd, 0, 4);
  int freshOk = g != NULL;
  int freshSize = g ? Cudd_DagSize(g) : -1;
  Cudd_ErrorType freshError = Cudd_ReadErrorCode(dd);
  if (g) Cudd_RecursiveDeref(dd, g);
  int zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);

  /* The memory is returned: a new manager works after Cudd_Quit. */
  dd = cw_manager_new(8);
  DdNode *h = dd ? xy_sum(dd, 0, 4) : NULL;
  int newManagerOk = h != NULL && Cudd_DagSize(h) == 31;
  if (h) Cudd_RecursiveDeref(dd, h);
  if (dd) Cudd_Quit(dd);

  snprintf(out, sizeof out,
    "{\"scenario\":\"oom\",\"managerOk\":1,\"failedNull\":%d,\"failedError\":\"%s\","
    "\"memoryMB\":%.1f,\"peakLive\":%ld,\"freshOk\":%d,\"freshSize\":%d,\"freshError\":\"%s\","
    "\"zeroRef\":%d,\"newManagerOk\":%d}",
    failedNull, cw_error_name(failedError), memoryMB, peakLive,
    freshOk, freshSize, cw_error_name(freshError), zeroRef, newManagerOk);
}

/* ── LIB-4: CUDD's live-node ceiling ────────────────────────────────────── */

/*
 * Cudd_SetMaxLive is CUDD 3.0.0's own ceiling. CUDD checks it when it needs
 * a new block of DD_MEM_CHUNK (1,022) nodes, counting live nodes only
 * (keys - dead), so an operation stops within about one block of the limit.
 */
#define MAX_LIVE 10000

static void scenario_maxlive(void) {
  DdManager *dd = cw_manager_new(2 * 16);
  Cudd_SetMaxLive(dd, MAX_LIVE);
  DdNode *f = xy_sum(dd, 0, 16);   /* 131,071 nodes when complete */
  int failedNull = f == NULL;
  Cudd_ErrorType failedError = Cudd_ReadErrorCode(dd);
  long peakLive = Cudd_ReadPeakLiveNodeCount(dd);
  if (f) Cudd_RecursiveDeref(dd, f);

  Cudd_ClearErrorCode(dd);
  DdNode *g = xy_sum(dd, 0, 4);
  int freshOk = g != NULL;
  int freshSize = g ? Cudd_DagSize(g) : -1;
  Cudd_ErrorType freshError = Cudd_ReadErrorCode(dd);
  if (g) Cudd_RecursiveDeref(dd, g);
  int zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);

  snprintf(out, sizeof out,
    "{\"scenario\":\"maxlive\",\"maxLive\":%d,\"failedNull\":%d,\"failedError\":\"%s\","
    "\"peakLive\":%ld,\"freshOk\":%d,\"freshSize\":%d,\"freshError\":\"%s\",\"zeroRef\":%d}",
    MAX_LIVE, failedNull, cw_error_name(failedError), peakLive,
    freshOk, freshSize, cw_error_name(freshError), zeroRef);
}

/* ── LIB-5: deep diagrams ─────────────────────────────────────────────────── */

#define CHAIN 10000
static int chainLength = CHAIN;   /* "deep:N" runs chains of N variables */

/* AND of variables first, first+step, ..., first+(n-1)*step. Built from the
 * bottom up, so each AND adds one node on top and recurses one level. */
static DdNode *chain(DdManager *dd, int first, int step, int n) {
  DdNode *f = Cudd_ReadOne(dd);
  Cudd_Ref(f);
  for (int i = n - 1; i >= 0; i--) {
    DdNode *v = Cudd_bddIthVar(dd, first + i * step);
    Cudd_Ref(v);
    if (!fold(dd, &f, v, Cudd_bddAnd)) return NULL;
  }
  return f;
}

/*
 * The chains use interleaved variables (even and odd), so their AND recurses
 * through all 20,000 levels, as do Cudd_DagSize and the minterm counts on the
 * result. Cudd_CountMinterm returns CUDD_OUT_OF_MEM (-1) without recursing for
 * more than 2,043 variables, because 2^nvars no longer fits in a double; so
 * the count is also taken with Cudd_ApaCountMinterm, CUDD's arbitrary-precision
 * count, which recurses through every level and must give exactly 1.
 */
static void scenario_deep(void) {
  int n = chainLength, nvars = 2 * n;
  DdManager *dd = cw_manager_new(nvars);
  double t0 = now_ms();
  DdNode *a = chain(dd, 0, 2, n);
  DdNode *b = chain(dd, 1, 2, n);
  DdNode *ab = a && b ? Cudd_bddAnd(dd, a, b) : NULL;
  if (ab) Cudd_Ref(ab);
  int dagSize = ab ? Cudd_DagSize(ab) : -1;
  double minterms = ab ? Cudd_CountMinterm(dd, ab, nvars) : -2;
  int digits = 0, apaIsOne = 0;
  DdApaNumber count = ab ? Cudd_ApaCountMinterm(dd, ab, nvars, &digits) : NULL;
  if (count) {
    DdApaNumber one = Cudd_NewApaNumber(digits);
    Cudd_ApaSetToLiteral(digits, one, 1);
    apaIsOne = Cudd_ApaCompare(digits, count, digits, one) == 0;
    Cudd_FreeApaNumber(one);
    Cudd_FreeApaNumber(count);
  }
  double ms = now_ms() - t0;
  if (ab) Cudd_RecursiveDeref(dd, ab);
  if (a) Cudd_RecursiveDeref(dd, a);
  if (b) Cudd_RecursiveDeref(dd, b);
  int zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);

  snprintf(out, sizeof out,
    "{\"scenario\":\"deep\",\"chain\":%d,\"vars\":%d,\"andOk\":%d,\"dagSize\":%d,"
    "\"countMinterm\":%.17g,\"apaCountIsOne\":%d,\"ms\":%.1f,\"zeroRef\":%d}",
    n, nvars, ab != NULL, dagSize, minterms, apaIsOne, ms, zeroRef);
}

/* ── The limits this build has ───────────────────────────────────────────── */

static void scenario_limits(void) {
#ifdef __EMSCRIPTEN__
  double heapMaxMB = emscripten_get_heap_max() / 1048576.0;
  double stackKB = (emscripten_stack_get_base() - emscripten_stack_get_end()) / 1024.0;
#else
  double heapMaxMB = 0, stackKB = 0;
#endif
  snprintf(out, sizeof out, "{\"scenario\":\"limits\",\"heapMaxMB\":%.1f,\"stackKB\":%.1f}", heapMaxMB, stackKB);
}

/* ── Entry points ────────────────────────────────────────────────────────── */

static const struct { const char *name; void (*run)(void); } SCENARIOS[] = {
  {"time", scenario_time},
  {"reorder", scenario_reorder},
  {"oom", scenario_oom},
  {"maxlive", scenario_maxlive},
  {"deep", scenario_deep},
  {"limits", scenario_limits},
};
#define NSCENARIOS ((int) (sizeof SCENARIOS / sizeof SCENARIOS[0]))

const char *hardening_run_named(const char *name) {
  if (!strncmp(name, "deep:", 5)) {
    chainLength = atoi(name + 5);
    scenario_deep();
    chainLength = CHAIN;
    return out;
  }
  for (int i = 0; i < NSCENARIOS; i++)
    if (!strcmp(SCENARIOS[i].name, name)) { SCENARIOS[i].run(); return out; }
  snprintf(out, sizeof out, "{\"error\":\"unknown scenario\"}");
  return out;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE const char *hardening_run(const char *name) { return hardening_run_named(name); }
#else
int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s <scenario>\n", argv[0]);
    return 2;
  }
  puts(hardening_run_named(argv[1]));
  return 0;
}
#endif
