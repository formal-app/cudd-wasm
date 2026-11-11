/*
 * Phase 0 spike harness: the same benchmarks on native CUDD 3.0.0 and on its
 * WebAssembly build. Natively, main() prints the JSON to stdout; under
 * Emscripten, spike_run() returns it as a string.
 *
 * Each benchmark runs in its own manager, dereferences everything it built,
 * and records Cudd_CheckZeroRef before Cudd_Quit. Each runs REPS times: the
 * results of every repetition must match the first (the "deterministic"
 * flag), and the reported time is the median. "results" holds only values
 * that must agree between platforms; "timesMs" holds the timings.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "cudd.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

#define REPS 5

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static DdManager *new_manager(int nvars) {
  return Cudd_Init(nvars, 0, CUDD_UNIQUE_SLOTS, CUDD_CACHE_SLOTS, 0);
}

/* ── 1. 8-queens over 64 variables, row-major (var = 8 * row + col) ─────── */

typedef struct { double minterms; int dagSize; int zeroRef; } Queens;

static DdNode *and_into(DdManager *dd, DdNode *acc, DdNode *g) {
  DdNode *t = Cudd_bddAnd(dd, acc, g);
  Cudd_Ref(t);
  Cudd_RecursiveDeref(dd, acc);
  return t;
}

static void bench_queens(Queens *r) {
  const int n = 8;
  DdManager *dd = new_manager(n * n);
  DdNode *f = Cudd_ReadOne(dd);
  Cudd_Ref(f);
  for (int i = 0; i < n; i++) {
    /* At least one queen in row i. */
    DdNode *row = Cudd_ReadLogicZero(dd);
    Cudd_Ref(row);
    for (int j = 0; j < n; j++) {
      DdNode *t = Cudd_bddOr(dd, row, Cudd_bddIthVar(dd, n * i + j));
      Cudd_Ref(t);
      Cudd_RecursiveDeref(dd, row);
      row = t;
    }
    f = and_into(dd, f, row);
    Cudd_RecursiveDeref(dd, row);
    for (int j = 0; j < n; j++) {
      /* A queen on (i, j) attacks nothing else in its row, column or diagonals. */
      DdNode *safe = Cudd_ReadOne(dd);
      Cudd_Ref(safe);
      for (int k = 0; k < n; k++)
        for (int l = 0; l < n; l++) {
          if (k == i && l == j) continue;
          if (k == i || l == j || k - l == i - j || k + l == i + j)
            safe = and_into(dd, safe, Cudd_Not(Cudd_bddIthVar(dd, n * k + l)));
        }
      DdNode *imp = Cudd_bddOr(dd, Cudd_Not(Cudd_bddIthVar(dd, n * i + j)), safe);
      Cudd_Ref(imp);
      Cudd_RecursiveDeref(dd, safe);
      f = and_into(dd, f, imp);
      Cudd_RecursiveDeref(dd, imp);
    }
  }
  r->minterms = Cudd_CountMinterm(dd, f, n * n);
  r->dagSize = Cudd_DagSize(f);
  Cudd_RecursiveDeref(dd, f);
  r->zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);
}

/* ── 2. 16-bit ripple-carry adder: AND/OR carries vs ITE carries ────────── */

#define BITS 16
#define OUTS (BITS + 1) /* sum bits, then carry out */

typedef struct {
  int identical, dagSizeTotal, bugFirstDiff, cubeEvalOne, zeroRef;
  char cube[2 * BITS + 2];
} Adder;

/* Variables: cin = 0, a_i = 1 + 2i, b_i = 2 + 2i (interleaved). */
static void build_adder(DdManager *dd, int carryStyle, int bugBit, DdNode **out) {
  DdNode *c = Cudd_bddIthVar(dd, 0);
  Cudd_Ref(c);
  for (int i = 0; i < BITS; i++) {
    DdNode *a = Cudd_bddIthVar(dd, 1 + 2 * i), *b = Cudd_bddIthVar(dd, 2 + 2 * i);
    DdNode *p = Cudd_bddXor(dd, a, b);
    Cudd_Ref(p);
    out[i] = Cudd_bddXor(dd, p, c);
    Cudd_Ref(out[i]);
    DdNode *next;
    if (carryStyle == 0) {
      /* (a AND b) OR (c AND (a XOR b)); the bug turns the first AND into an OR. */
      DdNode *g = i == bugBit ? Cudd_bddOr(dd, a, b) : Cudd_bddAnd(dd, a, b);
      Cudd_Ref(g);
      DdNode *h = Cudd_bddAnd(dd, c, p);
      Cudd_Ref(h);
      next = Cudd_bddOr(dd, g, h);
      Cudd_Ref(next);
      Cudd_RecursiveDeref(dd, g);
      Cudd_RecursiveDeref(dd, h);
    } else {
      /* ITE(a XOR b, c, a): propagate the carry, else generate it from a (= b). */
      next = Cudd_bddIte(dd, p, c, a);
      Cudd_Ref(next);
    }
    Cudd_RecursiveDeref(dd, p);
    Cudd_RecursiveDeref(dd, c);
    c = next;
  }
  out[BITS] = c;
}

static void bench_adder(Adder *r) {
  DdManager *dd = new_manager(1 + 2 * BITS);
  DdNode *andOr[OUTS], *ite[OUTS], *bug[OUTS];
  build_adder(dd, 0, -1, andOr);
  build_adder(dd, 1, -1, ite);
  build_adder(dd, 0, 7, bug);

  r->identical = 1;
  r->dagSizeTotal = 0;
  for (int k = 0; k < OUTS; k++) {
    if (andOr[k] != ite[k]) r->identical = 0;
    r->dagSizeTotal += Cudd_DagSize(andOr[k]);
  }

  r->bugFirstDiff = -1;
  r->cubeEvalOne = 0;
  r->cube[0] = '\0';
  for (int k = 0; k < OUTS; k++)
    if (andOr[k] != bug[k]) { r->bugFirstDiff = k; break; }
  if (r->bugFirstDiff >= 0) {
    int nv = Cudd_ReadSize(dd);
    DdNode *x = Cudd_bddXor(dd, andOr[r->bugFirstDiff], bug[r->bugFirstDiff]);
    Cudd_Ref(x);
    char *cube = malloc(nv);
    int *inputs = malloc(nv * sizeof(int));
    if (Cudd_bddPickOneCube(dd, x, cube)) {
      for (int v = 0; v < nv; v++) {
        inputs[v] = cube[v] == 1;
        r->cube[v] = cube[v] == 2 ? '-' : (char) ('0' + cube[v]);
      }
      r->cube[nv] = '\0';
      r->cubeEvalOne = Cudd_Eval(dd, x, inputs) == Cudd_ReadOne(dd);
    }
    free(cube);
    free(inputs);
    Cudd_RecursiveDeref(dd, x);
  }
  for (int k = 0; k < OUTS; k++) {
    Cudd_RecursiveDeref(dd, andOr[k]);
    Cudd_RecursiveDeref(dd, ite[k]);
    Cudd_RecursiveDeref(dd, bug[k]);
  }
  r->zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);
}

/* ── 3-5. f = x1·y1 + ... + x10·y10: ordering, complement edges, DumpDot ── */

#define PAIRS 10

typedef struct {
  int dagSizeSeparated, dagSizeAfterSift, perm[2 * PAIRS], dagSizeInterleaved, zeroRef;
} Ordering;
typedef struct { int bddDagSize, addDagSize, zeroRef; } Complement;
typedef struct { long normalizedBytes; int zeroRef; } DumpDot;
/* Address-dependent, so kept out of the repetition check: the first run's value. */
static long dumpdotBytes = -1;

/* x_i has index xs[i], y_i has index ys[i]; the manager's order is index order. */
static DdNode *build_f(DdManager *dd, const int *xs, const int *ys) {
  DdNode *f = Cudd_ReadLogicZero(dd);
  Cudd_Ref(f);
  for (int i = 0; i < PAIRS; i++) {
    DdNode *t = Cudd_bddAnd(dd, Cudd_bddIthVar(dd, xs[i]), Cudd_bddIthVar(dd, ys[i]));
    Cudd_Ref(t);
    DdNode *g = Cudd_bddOr(dd, f, t);
    Cudd_Ref(g);
    Cudd_RecursiveDeref(dd, t);
    Cudd_RecursiveDeref(dd, f);
    f = g;
  }
  return f;
}

static int SEP_X[PAIRS], SEP_Y[PAIRS], INT_X[PAIRS], INT_Y[PAIRS];

static void init_orders(void) {
  for (int i = 0; i < PAIRS; i++) {
    SEP_X[i] = i;          SEP_Y[i] = PAIRS + i;   /* x1..x10, y1..y10 */
    INT_X[i] = 2 * i;      INT_Y[i] = 2 * i + 1;   /* x1, y1, x2, y2, ... */
  }
}

static void bench_ordering(Ordering *r) {
  DdManager *dd = new_manager(2 * PAIRS);
  DdNode *f = build_f(dd, SEP_X, SEP_Y);
  r->dagSizeSeparated = Cudd_DagSize(f);
  Cudd_ReduceHeap(dd, CUDD_REORDER_SIFT, 0);
  r->dagSizeAfterSift = Cudd_DagSize(f);
  for (int v = 0; v < 2 * PAIRS; v++) r->perm[v] = Cudd_ReadPerm(dd, v);
  Cudd_RecursiveDeref(dd, f);
  r->zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);

  dd = new_manager(2 * PAIRS);
  f = build_f(dd, INT_X, INT_Y);
  r->dagSizeInterleaved = Cudd_DagSize(f);
  Cudd_RecursiveDeref(dd, f);
  r->zeroRef |= Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);
}

/* f under the separated order (x1..x10, y1..y10), as built in benchmark 3. */
static void bench_complement(Complement *r) {
  DdManager *dd = new_manager(2 * PAIRS);
  DdNode *f = build_f(dd, SEP_X, SEP_Y);
  r->bddDagSize = Cudd_DagSize(f);
  DdNode *a = Cudd_BddToAdd(dd, f);
  Cudd_Ref(a);
  r->addDagSize = Cudd_DagSize(a);
  Cudd_RecursiveDeref(dd, a);
  Cudd_RecursiveDeref(dd, f);
  r->zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);
}

/*
 * Cudd_DumpDot names each node by its address bits (masked, divided by
 * sizeof(DdNode)), and writes each level's nodes in unique-table order, which
 * hashes on addresses too. So the raw text depends on where the allocator put
 * the nodes. normalizedBytes counts every quoted "0x..." label as 3 bytes, the
 * length of "N": it changes with the graph and the rest of the text, but not
 * with the addresses, their width, or the order the nodes are written in.
 */
static long normalized_length(const char *s, long n) {
  long len = 0;
  for (long i = 0; i < n;) {
    if (s[i] == '"' && i + 2 < n && s[i + 1] == '0' && s[i + 2] == 'x') {
      long j = i + 3;
      while (j < n && s[j] != '"') j++;
      len += 3;
      i = j + 1;
    } else {
      len++;
      i++;
    }
  }
  return len;
}

static void bench_dumpdot(DumpDot *r) {
  DdManager *dd = new_manager(2 * PAIRS);
  DdNode *f = build_f(dd, SEP_X, SEP_Y);
  FILE *fp = tmpfile();
  r->normalizedBytes = -1;
  if (fp && Cudd_DumpDot(dd, 1, &f, NULL, NULL, fp)) {
    fflush(fp);
    long bytes = ftell(fp);
    if (dumpdotBytes < 0) dumpdotBytes = bytes;
    char *buf = malloc(bytes + 1);
    rewind(fp);
    if (fread(buf, 1, bytes, fp) == (size_t) bytes) r->normalizedBytes = normalized_length(buf, bytes);
    free(buf);
  }
  if (fp) fclose(fp);
  Cudd_RecursiveDeref(dd, f);
  r->zeroRef = Cudd_CheckZeroRef(dd);
  Cudd_Quit(dd);
}

/* ── Running and reporting ───────────────────────────────────────────────── */

static int cmp_double(const void *a, const void *b) {
  double x = *(const double *) a, y = *(const double *) b;
  return x < y ? -1 : x > y;
}

/* Runs fn REPS times into slot 0, checks every repetition matches it, returns the median ms. */
static char nondet[128] = "";

#define RUN(fn, Type, first, deterministic, medianMs) do {                     \
    double t[REPS];                                                          \
    for (int rep = 0; rep < REPS; rep++) {                                   \
      Type cur;                                                              \
      memset(&cur, 0, sizeof cur);                                           \
      double t0 = now_ms();                                                  \
      fn(&cur);                                                              \
      t[rep] = now_ms() - t0;                                                \
      if (rep == 0) first = cur;                                             \
      else if (memcmp(&cur, &first, sizeof cur)) {                           \
        deterministic = 0;                                                   \
        if (!strstr(nondet, #fn)) { strcat(nondet, nondet[0] ? "," : ""); strcat(nondet, #fn); } \
      }                                                                      \
    }                                                                        \
    qsort(t, REPS, sizeof t[0], cmp_double);                                 \
    medianMs = t[REPS / 2];                                                  \
  } while (0)

static char out[8192];

const char *spike_run_impl(void) {
  Queens q; Adder a; Ordering o; Complement c; DumpDot d;
  double tq, ta, to, tc, td;
  int det = 1;
  init_orders();
  RUN(bench_queens, Queens, q, det, tq);
  RUN(bench_adder, Adder, a, det, ta);
  RUN(bench_ordering, Ordering, o, det, to);
  RUN(bench_complement, Complement, c, det, tc);
  RUN(bench_dumpdot, DumpDot, d, det, td);

  char perm[256] = "";
  for (int v = 0; v < 2 * PAIRS; v++) {
    char x[16];
    snprintf(x, sizeof x, "%s%d", v ? "," : "", o.perm[v]);
    strcat(perm, x);
  }
  snprintf(out, sizeof out,
    "{\"platform\":\"%s\",\"cudd\":\"%s\",\"deterministic\":%d,\"nondeterministic\":\"%s\","
    "\"results\":{"
      "\"queens\":{\"minterms\":%.0f,\"dagSize\":%d},"
      "\"adder\":{\"identical\":%d,\"dagSizeTotal\":%d,\"bugFirstDiff\":%d,\"cube\":\"%s\",\"cubeEvalOne\":%d},"
      "\"ordering\":{\"dagSizeSeparated\":%d,\"dagSizeAfterSift\":%d,\"permAfterSift\":[%s],\"dagSizeInterleaved\":%d},"
      "\"complement\":{\"bddDagSize\":%d,\"addDagSize\":%d},"
      "\"dumpdot\":{\"normalizedBytes\":%ld},"
      "\"zeroRef\":{\"queens\":%d,\"adder\":%d,\"ordering\":%d,\"complement\":%d,\"dumpdot\":%d}},"
    "\"addressDependent\":{\"dumpdotBytes\":%ld},"
    "\"timesMs\":{\"queens\":%.3f,\"adder\":%.3f,\"ordering\":%.3f,\"complement\":%.3f,\"dumpdot\":%.3f}}",
#ifdef __EMSCRIPTEN__
    "wasm",
#else
    "native",
#endif
    "3.0.0", det, nondet,
    q.minterms, q.dagSize,
    a.identical, a.dagSizeTotal, a.bugFirstDiff, a.cube, a.cubeEvalOne,
    o.dagSizeSeparated, o.dagSizeAfterSift, perm, o.dagSizeInterleaved,
    c.bddDagSize, c.addDagSize,
    d.normalizedBytes,
    q.zeroRef, a.zeroRef, o.zeroRef, c.zeroRef, d.zeroRef,
    dumpdotBytes,
    tq, ta, to, tc, td);
  return out;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE const char *spike_run(void) { return spike_run_impl(); }
#else
int main(void) {
  puts(spike_run_impl());
  return 0;
}
#endif
