// Bundlers find WorkerSession's worker, and the worker finds cudd.wasm, only
// when each URL is written in the one form they recognise. Vite and webpack
// bundle a worker written as new Worker(new URL('./worker.js',
// import.meta.url), ...), and emit an asset written as new URL('file',
// import.meta.url). Anything else (a URL computed first, a variable) is left
// for the browser, and the worker then loads unbundled. Run ./build.sh first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { root } from "./helpers.mjs";

test("WorkerSession creates its worker in the form bundlers recognise", () => {
  const client = readFileSync(`${root}dist/client.js`, "utf8");
  assert.match(client, /new Worker\(new URL\('\.\/worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.doesNotMatch(client, /new Worker\(url\b/, "no worker from a precomputed URL");
});

test("the Emscripten module finds cudd.wasm in the form bundlers recognise", () => {
  const glue = readFileSync(`${root}dist/cudd.mjs`, "utf8");
  assert.match(glue, /new URL\("cudd\.wasm", ?import\.meta\.url\)/);
});
