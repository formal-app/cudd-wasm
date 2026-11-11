// Native CUDD 3.0.0 and its WebAssembly build must agree on every result.
// Run ./build.sh first, then: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export function runNative() {
  return JSON.parse(execFileSync(`${root}build/native/spike`, { encoding: "utf8" }));
}

export async function runWasm() {
  const { default: createModule } = await import(`${root}build/wasm/spike.mjs`);
  const m = await createModule();
  return JSON.parse(m.UTF8ToString(m._spike_run()));
}

const native = runNative();
const wasm = await runWasm();

test("both builds report their platform", () => {
  assert.equal(native.platform, "native");
  assert.equal(wasm.platform, "wasm");
});

test("8-queens has 92 solutions on both", () => {
  assert.equal(native.results.queens.minterms, 92);
  assert.equal(wasm.results.queens.minterms, 92);
});

test("every result and the final variable order are identical", () => {
  assert.deepEqual(wasm.results, native.results);
  assert.deepEqual(wasm.results.ordering.permAfterSift, native.results.ordering.permAfterSift);
});

test("Cudd_CheckZeroRef is 0 in every manager on both", () => {
  for (const r of [native, wasm])
    for (const [bench, refs] of Object.entries(r.results.zeroRef)) assert.equal(refs, 0, `${r.platform} ${bench}`);
});

test("each benchmark gives the same result on every repetition", () => {
  assert.equal(native.deterministic, 1, native.nondeterministic);
  assert.equal(wasm.deterministic, 1, wasm.nondeterministic);
});

test("the planted adder bug is found, with a witness cube", () => {
  for (const r of [native, wasm]) {
    assert.equal(r.results.adder.identical, 1);
    assert.equal(r.results.adder.bugFirstDiff, 8);
    assert.equal(r.results.adder.cubeEvalOne, 1);
  }
});
