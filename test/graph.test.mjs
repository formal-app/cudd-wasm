// Graph export and DOT (LIB-7), and library test 4: animation keys across
// one adjacent swap. Run ./build.sh first, then: node --test test/graph.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, rng, vars, randomAst, truthTable, evalNode } from "./helpers.mjs";

const VS = vars(8);

/** A session with a few random functions; the same seed gives the same operations. */
async function program(seed, count = 3) {
  const r = rng(seed);
  const s = await Session.create({ vars: VS });
  const names = [];
  for (let i = 0; i < count; i++) {
    s.define(`f${i}`, randomAst(r, VS, 5));
    names.push(`f${i}`);
  }
  return { s, names, r };
}

/** The ids the specification prescribes: depth first from the roots in order, then before else. */
function expectedIds(g) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ids = new Map();
  const visit = (id) => {
    if (ids.has(id)) return;
    ids.set(id, ids.size);
    const n = byId.get(id);
    if (n) {
      visit(n.hi);
      visit(n.lo);
    }
  };
  for (const root of g.roots) visit(root.id);
  return ids;
}

test("graph ids are depth first from the roots in the given order, then before else (LIB-7)", async () => {
  for (let seed = 0; seed < 50; seed++) {
    const { s, names, r } = await program(seed);
    for (const view of ["cudd", "textbook"]) {
      const g = s.graph(r.shuffle(names), view);
      for (const [id, expected] of expectedIds(g)) assert.equal(id, expected, `seed ${seed}, ${view} view`);
      const all = [...g.nodes.map((n) => n.id), ...g.terminals.filter((t) => t >= 0)];
      assert.deepEqual([...all].sort((a, b) => a - b), all.map((_, i) => i), "ids are 0..n-1");
    }
    assert.equal(s.dispose(), 0);
  }
});

test("each view has its terminals and edges, and levels follow the order (LIB-7)", async () => {
  for (let seed = 100; seed < 130; seed++) {
    const { s, names, r } = await program(seed);
    s.setOrder(r.shuffle(VS));
    const cudd = s.graph(names, "cudd");
    const textbook = s.graph(names, "textbook");
    for (const g of [cudd, textbook]) {
      assert.deepEqual(g.order, s.order());
      for (const n of g.nodes) {
        assert.equal(n.level, g.order.indexOf(n.var), "a node's level is its variable's place in the order");
        for (const child of [n.hi, n.lo]) {
          const c = g.nodes.find((m) => m.id === child);
          if (c) assert.ok(c.level > n.level, "edges point down");
        }
      }
      assert.deepEqual(g.roots.map((x) => x.name), names);
    }
    assert.equal(cudd.terminals.length, 1, "CUDD view: one terminal");
    assert.equal(textbook.terminals.length, 2, "textbook view: [zero, one]");
    assert.ok(textbook.nodes.every((n) => !n.loComplement), "no complement edges in the textbook view");
    assert.ok(textbook.roots.every((x) => !x.complement));
    assert.equal(s.dispose(), 0);
  }
});

test("constant functions: a complemented root in the CUDD view, one terminal in the textbook view (LIB-7)", async () => {
  const s = await Session.create({ vars: ["a"] });
  s.define("zero", { op: "const", value: 0 });
  s.define("one", { op: "const", value: 1 });
  const cudd = s.graph(["zero", "one"], "cudd");
  assert.deepEqual(cudd.nodes, []);
  assert.deepEqual(cudd.roots, [
    { name: "zero", id: cudd.terminals[0], complement: true },
    { name: "one", id: cudd.terminals[0], complement: false },
  ]);
  const zero = s.graph(["zero"], "textbook");
  assert.deepEqual(zero.terminals, [0, -1], "only the zero terminal is reached");
  assert.equal(s.size("zero", "textbook"), 1);
  assert.equal(s.dispose(), 0);
});

test("the same operations give identical graphs and DOT, keys included (LIB-7)", async () => {
  for (let seed = 200; seed < 210; seed++) {
    const a = await program(seed);
    const b = await program(seed);
    for (const view of ["cudd", "textbook"])
      assert.equal(JSON.stringify(a.s.graph(a.names, view)), JSON.stringify(b.s.graph(b.names, view)), `seed ${seed}`);
    assert.equal(a.s.dot(a.names), b.s.dot(b.names));
    assert.equal(a.s.dispose(), 0);
    assert.equal(b.s.dispose(), 0);
  }
});

test("dot returns CUDD's DOT for the named functions (LIB-7)", async () => {
  const s = await Session.create({ vars: ["a", "b", "c"] });
  s.define("maj", {
    op: "or",
    args: [
      { op: "and", args: [{ op: "var", name: "a" }, { op: "var", name: "b" }] },
      { op: "and", args: [{ op: "var", name: "a" }, { op: "var", name: "c" }] },
      { op: "and", args: [{ op: "var", name: "b" }, { op: "var", name: "c" }] },
    ],
  });
  const dot = s.dot(["maj"]);
  assert.match(dot, /^digraph "DD" \{/);
  // CUDD pads function names with two spaces and variable names with one.
  assert.match(dot, /"  maj  " -> "0x[0-9a-f]+"/, "an edge from the function's name to its root");
  for (const x of ["a", "b", "c"]) assert.match(dot, new RegExp(`\\{ rank = same; " ${x} ";`));
  // Two edges from each internal node: the CUDD view has size - 1 of them.
  const nodeEdges = dot.split("\n").filter((line) => /^"0x[0-9a-f]+" -> /.test(line));
  assert.equal(nodeEdges.length, 2 * (s.size("maj") - 1));
  assert.equal(s.dispose(), 0);
});

test("a node key present before and after one adjacent swap denotes the same function (library test 4)", async () => {
  let compared = 0;
  for (let seed = 300; seed < 500; seed++) {
    const { s, names, r } = await program(seed, 2);
    s.setOrder(r.shuffle(VS));
    const before = s.graph(names, "cudd");
    s.swapAdjacent(r.int(VS.length - 1));
    const after = s.graph(names, "cudd");
    const nodeTable = (g) => {
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      return new Map(g.nodes.map((n) => [n.key, truthTable((env) => evalNode(g, byId, n.id, env), VS).join("")]));
    };
    const a = nodeTable(before);
    const b = nodeTable(after);
    for (const [key, table] of a)
      if (b.has(key)) {
        assert.equal(b.get(key), table, `seed ${seed}: key ${key} changed function`);
        compared++;
      }
    assert.equal(s.dispose(), 0);
  }
  assert.ok(compared > 1000, `enough shared keys were compared (${compared})`);
});
