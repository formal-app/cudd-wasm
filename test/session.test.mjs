// Session (LIB-4 wrapper, LIB-6) and library tests 2, 3, 5 and 6: derived
// operations, reordering, budgets, and no leaked references.
// Run ./build.sh first, then: node --test test/session.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Session, BudgetError, MAX_VARS, rng, vars, v, randomAst, evalAst, truthTable, assignments, sessionTable,
} from "./helpers.mjs";

/** f = x0·y0 + ... over n pairs, with the x variables first. */
const xyVars = (n) => [...vars(n, "x"), ...vars(n, "y")];
const xy = (n, base = 0) => ({
  op: "or",
  args: Array.from({ length: n }, (_, i) => ({ op: "and", args: [v(`x${base + i}`), v(`y${base + i}`)] })),
});
const tableOf = (ast, vs) => truthTable((env) => evalAst(ast, env), vs);

// ── Library test 2: derived operations ─────────────────────────────────────

test("quantify, andExists, rename, cofactor and compose match truth tables (library test 2)", async () => {
  const r = rng(2);
  const VS = vars(8);
  const s = await Session.create({ vars: VS });
  for (let k = 0; k < 100; k++) {
    const fa = randomAst(r, VS), ga = randomAst(r, VS), ha = randomAst(r, VS);
    s.define("f", fa);
    s.define("g", ga);
    s.define("h", ha);
    const f = (env) => evalAst(fa, env), g = (env) => evalAst(ga, env), h = (env) => evalAst(ha, env);
    const Q = r.subset(VS).length ? r.subset(VS) : [r.pick(VS)];
    const over = (env, fn) => assignments(Q).map((q) => fn({ ...env, ...q }));
    const where = `case ${k}`;

    s.quantify("e", "exists", "f", Q);
    assert.deepEqual(sessionTable(s, "e", VS), truthTable((env) => (over(env, f).some(Boolean) ? 1 : 0), VS), where);
    s.quantify("a", "forall", "f", Q);
    assert.deepEqual(sessionTable(s, "a", VS), truthTable((env) => (over(env, f).every(Boolean) ? 1 : 0), VS), where);

    s.andExists("ae", "f", "g", Q);
    assert.deepEqual(sessionTable(s, "ae", VS),
      truthTable((env) => (over(env, (e) => f(e) & g(e)).some(Boolean) ? 1 : 0), VS), where);

    const shuffled = r.shuffle(VS);
    const pairs = Array.from({ length: 1 + r.int(4) }, (_, i) => [shuffled[2 * i], shuffled[2 * i + 1]]);
    s.rename("rn", "f", pairs);
    assert.deepEqual(sessionTable(s, "rn", VS), truthTable((env) => {
      const swapped = { ...env };
      for (const [x, y] of pairs) [swapped[x], swapped[y]] = [env[y], env[x]];
      return f(swapped);
    }, VS), where);

    const fixed = Object.fromEntries(r.subset(VS).map((x) => [x, r.int(2)]));
    s.cofactor("cf", "f", fixed);
    assert.deepEqual(sessionTable(s, "cf", VS), truthTable((env) => f({ ...env, ...fixed }), VS), where);
    for (const x of Object.keys(fixed)) assert.ok(!s.support("cf").includes(x), `${x} is fixed, ${where}`);

    const target = r.pick(VS);
    s.compose("cp", "f", target, "h");
    assert.deepEqual(sessionTable(s, "cp", VS), truthTable((env) => f({ ...env, [target]: h(env) }), VS), where);
  }
  assert.equal(s.dispose(), 0);
});

// ── Library test 3: reordering ─────────────────────────────────────────────

test("every order operation preserves every function (library test 3)", async () => {
  const r = rng(3);
  const VS = vars(8);
  const s = await Session.create({ vars: VS });
  const asts = Array.from({ length: 4 }, () => randomAst(r, VS, 5));
  asts.forEach((a, i) => s.define(`f${i}`, a));
  const tables = asts.map((a) => tableOf(a, VS));
  const unchanged = (step) =>
    asts.forEach((_, i) => assert.deepEqual(sessionTable(s, `f${i}`, VS), tables[i], `f${i} after ${step}`));

  s.setOrder(r.shuffle(VS));
  unchanged("setOrder");
  for (let k = 0; k < 5; k++) {
    s.swapAdjacent(r.int(VS.length - 1));
    unchanged("swapAdjacent");
  }
  for (const method of ["sift", "sift-converge", "window2", "window3", "window4", "exact", "random"]) {
    s.setOrder(r.shuffle(VS));
    const out = s.reorder(method);
    unchanged(`reorder ${method}`);
    assert.deepEqual(out.order, s.order(), method);
    assert.deepEqual([...out.order].sort(), [...VS].sort(), `${method}: the order is a permutation`);
    assert.equal(out.size, s.sharedSize(s.names()), `${method}: size is the shared size of every function`);
  }
  assert.equal(s.dispose(), 0);
});

test("reaching a permutation by swapAdjacent steps gives the same size as setOrder (library test 3)", async () => {
  const r = rng(33);
  const VS = vars(8);
  const s = await Session.create({ vars: VS });
  for (let i = 0; i < 3; i++) s.define(`f${i}`, randomAst(r, VS, 5));
  for (let k = 0; k < 10; k++) {
    const target = r.shuffle(VS);
    // Bubble sort the current order into the target, one adjacent swap at a time.
    for (let changed = true; changed;) {
      changed = false;
      const order = s.order();
      for (let level = 0; level < order.length - 1; level++)
        if (target.indexOf(order[level]) > target.indexOf(order[level + 1])) {
          s.swapAdjacent(level);
          [order[level], order[level + 1]] = [order[level + 1], order[level]];
          changed = true;
        }
    }
    assert.deepEqual(s.order(), target);
    const bySwaps = s.sharedSize(s.names());
    s.setOrder(r.shuffle(VS));
    s.setOrder(target);
    assert.equal(s.sharedSize(s.names()), bySwaps, `target ${target.join(" ")}`);
  }
  assert.equal(s.dispose(), 0);
});

test("x1·y1 + … + x10·y10: 2,047 nodes in the separated order, 21 interleaved (library test 3)", async () => {
  const s = await Session.create({ vars: xyVars(10) });
  assert.equal(s.define("f", xy(10)).size, 2047);
  assert.equal(s.size("f", "textbook"), 2048);
  s.setOrder(vars(10, "x").flatMap((x, i) => [x, `y${i}`]));
  assert.equal(s.size("f"), 21);
  assert.equal(s.dispose(), 0);
});

// ── Library test 5: budgets ────────────────────────────────────────────────

/** Each budget throws BudgetError; the earlier definition survives and the session continues. */
async function budget(limits, vs, big, kind) {
  const s = await Session.create({ vars: vs, limits });
  s.define("small", xy(3));
  const before = s.size("small");
  assert.throws(() => s.define("big", big), (e) => e instanceof BudgetError && e.kind === kind);
  assert.deepEqual(s.names(), ["small"], "the failed definition is not stored");
  assert.equal(s.size("small"), before, "the earlier definition survives");
  s.define("next", xy(4));
  assert.equal(s.size("next"), 31, "the session continues");
  return s;
}

test("a time budget throws BudgetError('time'), and the session continues (library test 5)", async () => {
  const s = await budget({ timeMs: 50 }, xyVars(19), xy(19), "time");
  assert.equal(s.dispose(), 0);
});

test("a node budget throws BudgetError('nodes'), and the session continues (LIB-4, library test 5)", async () => {
  const s = await budget({ maxNodes: 1000 }, xyVars(12), xy(12), "nodes");
  assert.equal(s.dispose(), 0);
});

test("a memory budget throws BudgetError('memory'), and the session continues (library test 5)", async () => {
  const s = await budget({ maxMemoryMB: 12 }, xyVars(20), xy(20), "memory");
  assert.equal(s.dispose(), 0);
});

test("reordering over its time budget throws BudgetError('time'), with every function unchanged (library test 5)", async () => {
  // Independent blocks, as in the T1 hardening test, so each variable sifts
  // quickly. With 32 blocks of 15 pairs (960 variables), the slowest define
  // took 28-93 ms and a full sift 635-660 ms, so a 200 ms budget leaves room
  // on both sides; a 50 ms budget once failed a define under load.
  const blocks = 32, pairs = 15;
  const vs = Array.from({ length: blocks }, (_, b) => xyVars(pairs).map((x) => `${x}_${b}`)).flat();
  const block = (b) => ({
    op: "or",
    args: Array.from({ length: pairs }, (_, i) => ({ op: "and", args: [v(`x${i}_${b}`), v(`y${i}_${b}`)] })),
  });
  const s = await Session.create({ vars: vs, limits: { timeMs: 200 } });
  for (let b = 0; b < blocks; b++) s.define(`f${b}`, block(b));
  const before = s.sharedSize(s.names());
  assert.throws(() => s.reorder("sift"), (e) => e instanceof BudgetError && e.kind === "time");
  for (let b = 0; b < blocks; b++) {
    s.define("again", block(b));
    assert.ok(s.equal(`f${b}`, "again"), `f${b} is unchanged`);
  }
  assert.ok(s.sharedSize(s.names().filter((n) => n !== "again")) <= before, "the stopped sift kept what it gained");
  assert.equal(s.dispose(), 0);
});

// ── Errors ─────────────────────────────────────────────────────────────────

test("unknown names throw TypeError; invalid orders and too many variables throw RangeError", async () => {
  const s = await Session.create({ vars: ["a", "b", "c"] });
  s.define("f", { op: "and", args: [v("a"), v("b")] });
  assert.throws(() => s.define("g", v("z")), TypeError);
  assert.throws(() => s.define("g", { op: "ref", name: "nope" }), TypeError);
  assert.throws(() => s.size("nope"), TypeError);
  assert.throws(() => s.equal("f", "nope"), TypeError);
  assert.throws(() => s.define("a", v("b")), TypeError, "a function cannot take a variable's name");
  assert.throws(() => s.count("f", ["a"]), TypeError, "the support is not within over");
  assert.throws(() => s.eval("f", { a: 1 }), TypeError, "b has no value");
  assert.throws(() => s.setOrder(["a", "b"]), RangeError);
  assert.throws(() => s.setOrder(["a", "b", "b"]), RangeError);
  assert.throws(() => s.setOrder(["a", "b", "z"]), RangeError);
  assert.throws(() => s.swapAdjacent(2), RangeError);
  assert.equal(s.dispose(), 0);
  assert.throws(() => s.names(), /disposed/);
  await assert.rejects(Session.create({ vars: vars(MAX_VARS + 1) }), RangeError);
  await assert.rejects(Session.create({ vars: ["a", "a"] }), RangeError);
  await assert.rejects(Session.create({ vars: ["a", "b"], order: ["b"] }), RangeError);
});

test("a session with the maximum 1,000 variables works", async () => {
  const s = await Session.create({ vars: vars(MAX_VARS) });
  s.define("all", { op: "and", args: vars(MAX_VARS).map(v) });
  assert.equal(s.size("all"), MAX_VARS + 1);
  assert.equal(s.count("all"), 1);
  assert.equal(s.dispose(), 0);
});
