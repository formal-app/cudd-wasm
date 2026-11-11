// T1 hardening: the acceptance criteria of LIB-2 to LIB-5, natively and in
// WebAssembly. Run ./build.sh first, then: node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function native(scenario) {
  return JSON.parse(execFileSync(`${root}build/native/hardening`, [scenario], { encoding: "utf8" }));
}

// A fresh module per scenario, so one scenario's memory use cannot affect another.
async function wasmFrom(file, scenario) {
  const { default: createModule } = await import(`${root}build/wasm/${file}`);
  const m = await createModule();
  return JSON.parse(m.ccall("hardening_run", "string", ["string"], [scenario]));
}
const wasm = (scenario) => wasmFrom("hardening.mjs", scenario);

const PLATFORMS = { native, wasm };

for (const [platform, run] of Object.entries(PLATFORMS)) {
  test(`${platform}: a 50 ms limit stops a longer computation, and a fresh operation then succeeds (LIB-2)`, async () => {
    const r = await run("time");
    assert.equal(r.unlimitedOk, 1, "the computation completes without a limit");
    assert.ok(r.unlimitedMs > 3 * r.limitMs, `the computation is longer than the limit (${r.unlimitedMs} ms)`);
    assert.equal(r.limitedNull, 1, "under the limit the operation returns NULL");
    assert.equal(r.limitedError, "CUDD_TIMEOUT_EXPIRED");
    assert.ok(r.limitedMs < 3 * r.limitMs, `it stops near the limit (${r.limitedMs} ms)`);
    assert.equal(r.freshOk, 1, "after clearing, a fresh operation succeeds");
    assert.equal(r.freshError, "CUDD_NO_ERROR");
    assert.equal(r.freshSize, 31, "x0·y4 + … + x3·y7 in the separated order has 31 nodes");
    assert.equal(r.zeroRef, 0, "no reference leaks after the timeout");
  });

  test(`${platform}: sifting under a 50 ms limit stops early, with every function unchanged (LIB-2)`, async () => {
    const r = await run("reorder");
    assert.equal(r.full.ret, 1);
    assert.ok(r.full.ms > 2 * r.limitMs, `a full sift takes longer than the limit (${r.full.ms} ms)`);
    assert.ok(r.full.sizeAfter < r.full.sizeBefore, "a full sift reduces the diagram");
    assert.equal(r.limited.ret, 1, "a sift stopped by the limit still returns success");
    assert.ok(r.limited.ms < r.full.ms, `the limited sift stops sooner (${r.limited.ms} ms)`);
    assert.ok(r.limited.sizeAfter > r.full.sizeAfter, "the limited sift stops before the full sift's result");
    assert.equal(r.unchanged, 1, `all ${r.functions} functions are the same nodes after the stopped sift`);
    assert.equal(r.zeroRef, 0);
  });
}

test("wasm: memory grows to a 1 GB ceiling (LIB-3)", async () => {
  assert.equal((await wasm("limits")).heapMaxMB, 1024);
});

test("wasm, 64 MB build: running out of memory returns NULL with CUDD_MEMORY_OUT, and the manager stays usable (LIB-3)", async () => {
  assert.equal((await wasmFrom("hardening-64mb.mjs", "limits")).heapMaxMB, 64);
  const r = await wasmFrom("hardening-64mb.mjs", "oom");
  assert.equal(r.managerOk, 1);
  assert.equal(r.failedNull, 1, "the operation that exhausts memory returns NULL");
  assert.equal(r.failedError, "CUDD_MEMORY_OUT");
  assert.equal(r.freshOk, 1, "after clearing, the same manager computes again");
  assert.equal(r.freshError, "CUDD_NO_ERROR");
  assert.equal(r.freshSize, 31);
  assert.equal(r.zeroRef, 0, "no reference leaks after running out of memory");
  assert.equal(r.newManagerOk, 1, "a new manager works after Cudd_Quit");
});
