# cudd-wasm

[CUDD](https://github.com/davidkebo/cudd) 3.0.0, the BDD package, compiled unmodified to WebAssembly with Emscripten. Phase 0 is a feasibility spike: see [SPIKE.md](SPIKE.md). The TypeScript API, `Session` (named BDD functions with time, node and memory budgets), is in `src/session.ts`; `./build.sh` compiles it into `dist/` beside the WebAssembly module.
Install the pinned Emscripten with `./bootstrap.sh`, put it on the `PATH` with `source ~/emsdk/emsdk_env.sh`, then build with `./build.sh` and test with `npm ci && npm test`. The browser test runs Chromium through Playwright: install it with `npx playwright install chromium`, or point `CHROMIUM_PATH` at one. Measure with `node test/measure.mjs`.
