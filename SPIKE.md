# Phase 0: CUDD 3.0.0 to WebAssembly, feasibility spike

**Verdict: feasible. All five gates pass.** The unmodified CUDD 3.0.0 sources
compile to WebAssembly with no shim. The build gives the same result as
native on every benchmark (40 processes). Its `.wasm` is 61 KiB gzipped, and
it starts in Node in 11.5 ms. It runs at 0.83–0.95x native time on the four
BDD benchmarks and 2.0x on `Cudd_DumpDot`, which is limited by formatted
output. The open items below matter for a later phase, not for this verdict.

## Environment and versions

| Tool | Version |
|---|---|
| OS | Linux 6.18.62 x86_64, Intel Xeon Platinum 8581C @ 2.30 GHz, 4 cores |
| gcc | 13.2.0 |
| make | GNU Make 4.4.1 |
| node | v20.20.0 (runs the tests and measurements) |
| python3 | 3.11.14 |
| Emscripten | `emcc` 7.0.0 (`777e6e5db7b4990bcaeb1b9998ed642cc84e6629`), from emsdk `latest` at emsdk commit `1693ce7` (2026-11-06) |

## CUDD archive

`cudd_versions/cudd-3.0.0.tar.gz` from `davidkebo/cudd` (`main`), 1,175,302 bytes.

SHA-256: `b8e966b4562c96a03e7fbea239729587d7b395d53cadcc39a7203b49cf7eeb69`

It is unpacked into `cudd/` without its top-level `cudd-3.0.0/` directory.
The 257 files are byte-identical to the archive (`diff -r` against a fresh
extract, rerun before the commit). Nothing in `cudd/` is patched.

## Native baseline

The library is built out of tree in `build/native/`, with
`../../cudd/configure && make -j && make check`. The build succeeds, and
`make check` passes 30 of 30 tests (0 fail, 0 skip). gcc 13 reports
warnings in CUDD's own sources (`-Wimplicit-fallthrough` and
`-Wcast-function-type`); the harness and the `emcc` build give none.

**Note:** CUDD's `configure` applies its default flags,
`-Wall -Wextra -g -O3`, only when `CFLAGS` is unset. This environment exports
an empty `CFLAGS`, which builds the library with no `-O` flag, that is at
gcc's `-O0`. The baseline is therefore configured with `env -u CFLAGS`, and
`build.sh` does the same, so the native library is CUDD's own default build.

nanotrav, CUDD's sample program, is used as a native reference point. It is
run on `mult32a.blif` with the test suite's flags
(`-p 1 -autodyn -reordering sifting -trav`). Wall time over five runs: 0.108,
0.100, 0.099, 0.098 and 0.099 s; median **0.099 s**. nanotrav is not part of
the WebAssembly build.

## WebAssembly build

`build.sh wasm` compiles the 76 C files of `cudd/`, `mtr/`, `st/`, `epd/` and
`util/` directly with `emcc -O3`, without autotools. It leaves out `dddmp`,
`cplusplus`, `nanotrav` and the test mains (`testcudd.c`, `testextra.c`,
`testmtr.c`, `testst.c`). It then links them with `src/spike.c` into
`build/wasm/spike.mjs` and `build/wasm/spike.wasm`, in about 6 s on 4 cores.

Link flags: `-O3 -sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1
-sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1`, plus two more:

- `-sEXPORTED_FUNCTIONS=_spike_run` exports the spike entry point and
  nothing else.
- `-sEXPORTED_RUNTIME_METHODS=UTF8ToString` lets JavaScript read the JSON
  string that `spike_run` returns.

## config.h deltas

`src/config.h` is the native `build/native/config.h` with two macros changed
for wasm32:

| Macro | Native (x86-64) | wasm32 |
|---|---|---|
| `SIZEOF_LONG` | 8 | 4 |
| `SIZEOF_VOID_P` | 8 | 4 |

`SIZEOF_INT` (4) and `SIZEOF_LONG_DOUBLE` (16) are unchanged: Emscripten's
`long double` is a 128-bit software float. Before compiling the library,
`build.sh` checks all four macros against `emcc` with `_Static_assert`s, and
all four hold.

## Shims

None. `src/shim.c` does not exist: every `util/` function compiles and links
against Emscripten's C library unchanged. One of them, `util_cpu_time`, links
but always returns 0 under Emscripten (see Open items). No benchmark here
depends on it.

## Results

The harness (`src/spike.c`) runs each benchmark five times, each in a fresh
manager. Every repetition must give the same result as the first, and the
time reported is the median of the five. On native, `main` prints the
results as JSON; under Emscripten, the exported `spike_run()` returns the
same JSON. `test/spike.test.mjs` runs both and requires every value in
`results` to be equal.

The table shows each benchmark's result. Native and WebAssembly give the
same value in every cell, and in each of 20 processes per platform.

| Benchmark | Result (native = WebAssembly) |
|---|---|
| 1. 8-queens | 92 solutions (`Cudd_CountMinterm`), 2,451 nodes (`Cudd_DagSize`) |
| 2. 16-bit adder | The AND/OR and `Cudd_bddIte` carry chains give the same node for all 17 outputs (474 nodes, summed over the outputs). With the a·b term of bit 7's carry made a + b, output 8 is the first to differ. The cube `Cudd_bddPickOneCube` picks from that pair's XOR is `11-1-1-1-01010010----------------`, and `Cudd_Eval` of the XOR on it is 1 |
| 3. Ordering of f = Σ xᵢ·yᵢ, 10 pairs | 2,047 nodes in the separated order (x₁…x₁₀, then y₁…y₁₀). After `Cudd_ReduceHeap(CUDD_REORDER_SIFT)`: 21 nodes, with perm `1,3,5,…,19,0,2,…,18`, so each yᵢ lies directly above its xᵢ. Built in the interleaved order: 21 nodes |
| 4. Complement edges | The same f: 2,047 nodes as a BDD, 2,048 as an ADD (`Cudd_BddToAdd`) |
| 5. `Cudd_DumpDot` of f | 95,140 bytes, with each node label counted as 3 bytes (see below) |
| 6. Leak check | `Cudd_CheckZeroRef` is 0 in every manager |

**Why DumpDot's raw length is not compared:** `Cudd_DumpDot` names each node
after its address bits, masked and divided by `sizeof(DdNode)`. It writes
each level's nodes in unique-table order, and `ddHash` hashes child
pointers, so that order depends on addresses too. The raw length therefore
changes between native processes under address randomisation (137,448 to
166,799 bytes over 20 runs). It also differs from WebAssembly, whose
allocator places nodes the same way in every run (146,305 bytes in all 20).
The compared value counts every quoted `"0x…"` label as 3 bytes (the length
of `"N"`). That count changes with the graph and the rest of the text, but
not with addresses, their width, or the order the nodes are written in. The
raw length is still reported, under `addressDependent`.

## Measurements

**Size.** The table shows each output file's size, raw and after `gzip -9`.

| File | Raw (bytes) | `gzip -9` (bytes) |
|---|---|---|
| `spike.wasm` | 145,974 | 62,464 |
| `spike.mjs` (JavaScript glue) | 58,029 | 16,093 |

**Node init time.** Each of 10 fresh Node processes times the span from
importing `spike.mjs` to `await createModule()` resolving, which includes
compiling and instantiating the `.wasm`. The median is **11.5 ms** (range
11.0–12.5 ms).

**Speed.** Each harness run reports the median of five repetitions per
benchmark. One `node test/measure.mjs` run compares one native process with
one WebAssembly process. Because a single process is noisy, the table also
uses 20 processes per platform. Columns: the median over the 20 processes,
their ratio (WebAssembly ÷ native), and the largest ratio among the 20
process pairs.

| Benchmark | Native (ms) | WebAssembly (ms) | Ratio | Largest paired ratio |
|---|---|---|---|---|
| 8-queens | 16.68 | 14.67 | 0.88 | 1.01 |
| 16-bit adder | 0.572 | 0.474 | 0.83 | 1.08 |
| Ordering | 1.726 | 1.631 | 0.95 | 1.35 |
| Complement edges | 0.704 | 0.599 | 0.85 | 1.18 |
| DumpDot | 1.495 | 2.989 | **2.00** | **3.04** |

Three runs of `node test/measure.mjs` gave DumpDot ratios of 1.81, 1.67 and
2.29. Every other ratio was between 0.72 and 1.06.

These observations explain the numbers:

- **DumpDot is limited by formatted output.** Timed alone (median of 20
  processes), `Cudd_DumpDot` of f to an in-memory C stream (`fmemopen`, which
  stays inside WebAssembly) takes 1.37 ms against 0.74 ms native, 1.86x: most
  of the gap is the WebAssembly C library's `fprintf`. Writing through
  Emscripten's file system (`tmpfile()`, JavaScript-backed, as the harness
  does) adds about 0.7 ms: 2.07 ms against 0.83 ms native, 2.49x.
- **The BDD benchmarks are limited by memory access, not by instructions.**
  The same harness linked against a native library built at `-O0` and one
  built at `-O3` gives the same times to within noise.
- **WebAssembly uses less memory.** On wasm32 a `DdNode` is 16 bytes against
  32, and pointers are 4 bytes against 8. After the same small workload, a
  64-variable manager reports 6.4 MB in use in WebAssembly against 10.7 MB
  native (`Cudd_ReadMemoryInUse`).
  This is the likely reason WebAssembly matches or beats native on these
  benchmarks. It was not measured further, because there is no profiler in
  this environment.
- **Small benchmarks are mostly manager setup.** `Cudd_Init` with
  `Cudd_Quit` takes about 0.5 ms on both builds, which is most of the adder,
  ordering and complement times. Larger models would weigh the BDD
  operations more.

## Gate verdicts

| Gate | Pass condition | Measured | Verdict |
|---|---|---|---|
| Unmodified source | Builds with `cudd/` byte-identical to the archive | No patch; no shim | **Pass** |
| Correctness | Identical results; 8-queens = 92; zero leaked references | All `results` equal in 20 native and 20 WebAssembly processes; 92; `Cudd_CheckZeroRef` 0 everywhere | **Pass** |
| Size | `.wasm` at most 1 MB gzipped | 62,464 bytes (61 KiB) | **Pass** |
| Speed | WebAssembly within 3x native | Worst ratio of medians 2.00 (DumpDot); BDD benchmarks 0.83–0.95 | **Pass** (see the note) |
| Startup | Node init at most 200 ms | 11.5 ms median of 10 | **Pass** |

**Note:** the speed gate passes on the medians, but DumpDot's single-process
ratio exceeded 3x in 1 of 20 process pairs (3.04). If Phase 1 reads the gate
as "every single run within 3x", DumpDot through Emscripten's file system
fails it now and then. Writing DOT to an in-memory stream instead would avoid
the JavaScript file system: alone, that path is 1.86x native.

## Open items

- **Licence of the glue code.** The JavaScript glue and the runtime linked
  into the `.wasm` come from Emscripten. Emscripten's `LICENSE` says it "is
  available under 2 licenses, the MIT license and the University of
  Illinois/NCSA Open Source License". Its glue also contains parts of
  Node.js (MIT). The `.wasm` also contains musl libc (MIT), compiler-rt
  (Apache License v2.0 with LLVM Exceptions) and dlmalloc (public domain).
  CUDD keeps its own BSD-style licence (`cudd/LICENSE`, © 1995–2004 Regents
  of the University of Colorado). The repository has no top-level `LICENSE`
  yet. Choosing one, and the notices a published package must carry, is
  still to be decided.
- **`util_cpu_time` is always 0.** It calls `times()`, which Emscripten
  stubs, so it never advances (0 ms against 640 ms native over the same
  loop). The library calls it in 39 places. In WebAssembly, `Cudd_SetTimeLimit` and
  the reordering time limits therefore never fire, and the GC and reordering
  time statistics read 0. The fix is a shim: leave `util/cpu_time.c` out of
  the WebAssembly build, and define `util_cpu_time` in `src/shim.c` with
  `clock_gettime(CLOCK_MONOTONIC)`. That gives wall time, which equals CPU
  time for a single-threaded worker.
- **32-bit limits.** With `SIZEOF_VOID_P` 4, `cuddInt.h` makes `DdHalfWord`
  16 bits instead of 32. A WebAssembly manager therefore holds at most 65,534
  variables (`CUDD_MAXINDEX`, the constants' index, is 65,535). A node's
  reference count saturates at 65,535 (`DD_MAXREF`), after which the node is
  never freed. This is CUDD's own 32-bit configuration, not a patch. The
  benchmarks here use at most 64 variables.
- **Memory and stack ceilings.** Emscripten's defaults are a 64 KB stack
  (`STACK_SIZE`) and a 2 GB memory ceiling (`MAXIMUM_MEMORY`). CUDD's
  recursive operations recurse once per variable level, so stack use grows
  with the number of variables. The benchmarks fit in 64 KB. A model with
  thousands of variables must be checked and may need a larger `STACK_SIZE`.
  (A first version of the harness put a 96 KB table on the stack and
  overflowed it. That was the harness's own array, now gone, not CUDD's
  recursion.)
- **Computed-table limit.** `Cudd_Init` caps the computed table at a third
  of its memory limit (256 MB on both builds) divided by the entry size
  (32 bytes native, 16 in WebAssembly), so WebAssembly gets 5,592,405 entries
  against 2,796,202 native. This cannot change a result,
  because the computed table is a cache. It can change memory use and speed
  on large models.
- **The GitHub repository** is `formal-app/cudd-wasm`. Nothing is published
  to npm.
