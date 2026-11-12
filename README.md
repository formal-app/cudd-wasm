# cudd-wasm

[CUDD](https://github.com/davidkebo/cudd) 3.0.0, the BDD package, compiled unmodified to WebAssembly, with a TypeScript API. It runs in Node and in browsers, where CUDD runs in a Web Worker. Phase 0, the feasibility spike, is in [SPIKE.md](SPIKE.md).

## Install

Version 0.1.1 is released on GitHub, not on npm:

```sh
npm install https://github.com/formal-app/cudd-wasm/releases/download/v0.1.1/formal-app-cudd-wasm-0.1.1.tgz
```

## Use

`Session` holds named Boolean functions. Once created, its methods are synchronous.

```ts
import { Session } from "@formal-app/cudd-wasm";

const v = (name) => ({ op: "var", name });
const and = (...args) => ({ op: "and", args });

const s = await Session.create({ vars: ["a", "b", "c"], limits: { timeMs: 2000, maxNodes: 200000 } });
s.define("maj", { op: "or", args: [and(v("a"), v("b")), and(v("a"), v("c")), and(v("b"), v("c"))] });
s.size("maj");             // 5 nodes in CUDD's view (complement edges, one terminal)
s.size("maj", "textbook"); // 6 nodes as a textbook ROBDD
s.count("maj");            // 4 satisfying assignments
s.dispose();               // 0: no leaked references
```

An operation that exceeds a budget throws `BudgetError`, and the session continues. In a page, use `WorkerSession` from `@formal-app/cudd-wasm/client`. It has the same methods, returning promises, and stops a call that runs past `hardTimeoutMs`. A session holds at most 1,000 variables, because deeper recursion overflows a browser's call stack.

## Build and test

Install the pinned Emscripten with `./bootstrap.sh` and put it on the `PATH` with `source ~/emsdk/emsdk_env.sh`. Then build with `npm ci && ./build.sh` and test with `npm test`. The browser tests run Chromium through Playwright: install it with `npx playwright install chromium`, or point `CHROMIUM_PATH` at one. `node test/measure.mjs` measures sizes, startup and speed.

## Licence

BSD 3-Clause; see [LICENSE](LICENSE). CUDD and the Emscripten and musl code in the WebAssembly build keep their own licences; see [NOTICE](NOTICE).
