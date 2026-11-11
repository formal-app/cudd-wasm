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

for (const [platform, run] of Object.entries(PLATFORMS)) {
  test(`${platform}: CUDD's live-node ceiling stops an operation with CUDD_TOO_MANY_NODES (LIB-4)`, async () => {
    const r = await run("maxlive");
    assert.equal(r.failedNull, 1);
    assert.equal(r.failedError, "CUDD_TOO_MANY_NODES");
    // CUDD checks the ceiling when it allocates a block of 1,022 nodes.
    assert.ok(r.peakLive <= r.maxLive + 1022, `stops within one node block of the limit (peak ${r.peakLive})`);
    assert.equal(r.freshOk, 1, "after clearing, the same manager computes again");
    assert.equal(r.freshError, "CUDD_NO_ERROR");
    assert.equal(r.freshSize, 31);
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

// LIB-5. The deep test recurses through 20,000 variable levels. Emscripten's
// stack (STACK_SIZE) is sized for it, but V8's own call stack runs out first
// unless it is raised, so the WebAssembly run uses a child Node process with
// --stack-size=4000 (4 MB, inside the usual 8 MB thread stack). Browsers do
// not allow that, which is why Session caps a manager at 1,000 variables; the
// browser test checks that cap's headroom in a Chromium Web Worker.
function deepChecks(r) {
  assert.equal(r.vars, 20000);
  assert.equal(r.andOk, 1, "the AND of the two chains succeeds");
  assert.equal(r.dagSize, 20001, "Cudd_DagSize: 20,000 nodes and the constant");
  // Cudd_CountMinterm gives up (CUDD_OUT_OF_MEM, -1) above 2,043 variables,
  // because 2^nvars no longer fits in a double; the exact count is 1.
  assert.equal(r.countMinterm, -1);
  assert.equal(r.apaCountIsOne, 1, "Cudd_ApaCountMinterm counts exactly 1 minterm");
  assert.equal(r.zeroRef, 0);
}

test("native: two 10,000-variable chains, their AND, then the minterm count and size (LIB-5)", () => {
  deepChecks(native("deep"));
});

test("wasm, Node with a 4 MB V8 stack: two 10,000-variable chains, their AND, then the minterm count and size (LIB-5)", () => {
  const script = `const { default: c } = await import(process.argv[1]);
const m = await c();
console.log(m.ccall("hardening_run", "string", ["string"], [process.argv[2]]));`;
  const out = execFileSync(process.execPath,
    ["--stack-size=4000", "--input-type=module", "-e", script, `${root}build/wasm/hardening.mjs`, "deep"],
    { encoding: "utf8" });
  deepChecks(JSON.parse(out));
});

test("wasm: the Emscripten stack is 640 KB, twice the 316 KB the deep test needs (LIB-5)", async () => {
  assert.equal((await wasm("limits")).stackKB, 640);
});
