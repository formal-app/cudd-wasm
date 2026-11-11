// Browser tests in headless Chromium: the Phase 0 harness, on the main thread
// and in a module Web Worker, gives the same results as native CUDD; and a
// worker handles twice the recursion depth the 1,000-variable cap allows.
// Run ./build.sh first, then: node --test test/browser.test.mjs
// CHROMIUM_PATH selects a Chromium binary; otherwise Playwright's own is used
// (npx playwright install chromium).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };

// The page and the worker script are served from memory; everything else from build/wasm.
const PAGES = {
  "/": "<!doctype html><meta charset=utf-8><title>cudd-wasm</title>",
  "/worker.mjs": `import createModule from "/build/wasm/spike.mjs";
const m = await createModule();
postMessage(m.UTF8ToString(m._spike_run()));`,
  "/deep-worker.mjs": `import createModule from "/build/wasm/hardening.mjs";
const m = await createModule();
postMessage(m.ccall("hardening_run", "string", ["string"], ["deep:1000"]));`,
  // Every Session operation on 1,000-level diagrams, the deepest the cap allows.
  "/session-worker.mjs": `import { Session, MAX_VARS } from "/dist/index.js";
const done = [];
try {
  const vs = Array.from({ length: MAX_VARS }, (_, i) => "v" + i);
  const v = (name) => ({ op: "var", name });
  const s = await Session.create({ vars: vs });
  // Two interleaved chains: their AND has a node on every one of the 1,000 levels.
  s.define("a", { op: "and", args: vs.filter((_, i) => i % 2 === 0).map(v) });
  s.define("b", { op: "and", args: vs.filter((_, i) => i % 2 === 1).map(v) });
  s.define("ab", { op: "and", args: [{ op: "ref", name: "a" }, { op: "ref", name: "b" }] });
  s.define("x", { op: "xor", args: [{ op: "ref", name: "ab" }, v("v999")] });
  done.push("define");
  const r = {
    size: s.size("ab"), textbook: s.size("ab", "textbook"), count: s.count("ab"),
    cube: Object.values(s.pickCube("ab")).every((x) => x === 1),
    support: s.support("ab").length,
    eval: s.eval("ab", Object.fromEntries(vs.map((x) => [x, 1]))),
    implies: s.implies("ab", "a"),
  };
  done.push("queries");
  s.quantify("q", "exists", "ab", vs.slice(0, 500));
  s.quantify("u", "forall", "x", vs.slice(500));
  s.andExists("ae", "a", "b", vs.slice(250, 750));
  s.rename("rn", "ab", [["v0", "v999"], ["v1", "v998"]]);
  s.cofactor("cf", "x", { v500: 1 });
  s.compose("cp", "ab", "v999", "a");
  done.push("derived");
  r.cudd = s.graph(["ab", "x"], "cudd").nodes.length;
  r.textbookGraph = s.graph(["ab", "x"], "textbook").nodes.length;
  r.dot = s.dot(["ab"]).length > 0;
  done.push("graph");
  s.swapAdjacent(0);
  s.reorder("sift");
  done.push("reorder");
  r.leaks = s.dispose();
  postMessage(JSON.stringify(r));
} catch (e) {
  postMessage(JSON.stringify({ error: String(e), after: done }));
}`,
};

let server, base, browser, page;

before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const page = PAGES[path];
    if (page !== undefined) {
      res.writeHead(200, { "content-type": TYPES[extname(path) || ".html"] });
      return res.end(page);
    }
    const file = normalize(join(root, path));
    if (![join(root, "build/wasm/"), join(root, "dist/")].some((dir) => file.startsWith(dir))) {
      res.writeHead(404);
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  page = await browser.newPage();
  await page.goto(`${base}/`);
});

after(async () => {
  await browser?.close();
  server?.close();
});

const native = () => JSON.parse(execFileSync(`${root}build/native/spike`, { encoding: "utf8" }));

test("Chromium, main thread: the Phase 0 harness gives native CUDD's results", async () => {
  const json = await page.evaluate(async () => {
    const { default: createModule } = await import("/build/wasm/spike.mjs");
    const m = await createModule();
    return m.UTF8ToString(m._spike_run());
  });
  const r = JSON.parse(json);
  assert.equal(r.platform, "wasm");
  assert.equal(r.results.queens.minterms, 92);
  assert.equal(r.deterministic, 1, r.nondeterministic);
  assert.deepEqual(r.results, native().results);
});

test("Chromium, Web Worker: the Phase 0 harness gives native CUDD's results", async () => {
  const json = await page.evaluate(() => new Promise((resolve, reject) => {
    const w = new Worker("/worker.mjs", { type: "module" });
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate(); };
  }));
  const r = JSON.parse(json);
  assert.equal(r.platform, "wasm");
  assert.equal(r.results.queens.minterms, 92);
  assert.equal(r.deterministic, 1, r.nondeterministic);
  assert.deepEqual(r.results, native().results);
});

// LIB-5. Session caps a manager at 1,000 variables, so no recursion goes deeper
// than 1,000 levels. Two 1,000-variable chains recurse through 2,000 levels;
// a Chromium worker's stack overflows at about 2,750.
test("Chromium, Web Worker: two 1,000-variable chains, twice the depth the cap allows, run without overflow (LIB-5)", async () => {
  const json = await page.evaluate(() => new Promise((resolve, reject) => {
    const w = new Worker("/deep-worker.mjs", { type: "module" });
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate(); };
  }));
  const r = JSON.parse(json);
  assert.equal(r.vars, 2000);
  assert.equal(r.andOk, 1);
  assert.equal(r.dagSize, 2001);
  assert.equal(r.countMinterm, 1, "below 2,044 variables, Cudd_CountMinterm counts exactly");
  assert.equal(r.apaCountIsOne, 1);
  assert.equal(r.zeroRef, 0);
});

test("Chromium, Web Worker: every Session operation works on 1,000-level diagrams, the most the cap allows (LIB-5)", async () => {
  const json = await page.evaluate(() => new Promise((resolve, reject) => {
    const w = new Worker("/session-worker.mjs", { type: "module" });
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate(); };
  }));
  const r = JSON.parse(json);
  assert.equal(r.error, undefined, `${r.error}, after: ${r.after}`);
  assert.equal(r.size, 1001);
  assert.equal(r.textbook, 1002);
  assert.equal(r.count, 1);
  assert.equal(r.cube, true);
  assert.equal(r.support, 1000);
  assert.equal(r.eval, 1);
  assert.equal(r.implies, true);
  assert.ok(r.cudd >= 1000 && r.textbookGraph >= 1000);
  assert.equal(r.dot, true);
  assert.equal(r.leaks, 0);
});
