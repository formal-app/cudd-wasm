// Library test 1, the truth-table oracle: 500 seeded random expressions over
// up to 10 variables, each checked against a truth table computed without CUDD.
// Run ./build.sh first, then: node --test test/oracle.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, rng, vars, randomAst, evalAst, truthTable, evalGraph } from "./helpers.mjs";

const CASES = 500;
const PER_SESSION = 50;
const VS = vars(10);

const COMMUTATIVE = new Set(["and", "or", "xor", "xnor", "nand", "nor", "iff"]);

/** An equivalent expression: De Morgan, double negation and commuted operands, applied at random. */
function rewrite(a, r) {
  const sub = (x) => rewrite(x, r);
  let out;
  switch (a.op) {
    case "const":
    case "var":
    case "ref":
      out = a;
      break;
    case "not":
      out = { op: "not", arg: sub(a.arg) };
      break;
    case "ite":
      out = { op: "ite", if: sub(a.if), then: sub(a.then), else: sub(a.else) };
      break;
    case "exists":
    case "forall":
      out = { op: a.op, vars: a.vars, arg: sub(a.arg) };
      break;
    default: {
      let args = a.args.map(sub);
      if (COMMUTATIVE.has(a.op) && r() < 0.5) args = r.shuffle(args);
      out = { op: a.op, args };
      // De Morgan: and(x, y) = not(or(not x, not y)), and dually.
      if ((a.op === "and" || a.op === "or") && r() < 0.4)
        out = { op: "not", arg: { op: a.op === "and" ? "or" : "and", args: args.map((x) => ({ op: "not", arg: x })) } };
    }
  }
  return r() < 0.15 ? { op: "not", arg: { op: "not", arg: out } } : out;
}

/** The same expression with one node changed. */
function mutate(a, r, vs) {
  const nodes = [];
  const collect = (x, set) => {
    nodes.push({ x, set });
    if (x.op === "not" || x.op === "exists" || x.op === "forall") collect(x.arg, (y) => (x.arg = y));
    else if (x.op === "ite") {
      collect(x.if, (y) => (x.if = y));
      collect(x.then, (y) => (x.then = y));
      collect(x.else, (y) => (x.else = y));
    } else if (x.args) x.args.forEach((c, i) => collect(c, (y) => (x.args[i] = y)));
  };
  const copy = structuredClone(a);
  let top = copy;
  collect(copy, (y) => (top = y));
  const { x, set } = r.pick(nodes);
  if (x.op === "var") set({ op: "var", name: r.pick(vs.filter((w) => w !== x.name)) });
  else if (x.op === "const") set({ op: "const", value: 1 - x.value });
  else if (x.op === "not") set(x.arg);
  else if (x.op === "ite") set({ op: "ite", if: x.if, then: x.else, else: x.then });
  else if (x.op === "exists" || x.op === "forall") set({ ...x, op: x.op === "exists" ? "forall" : "exists" });
  else if (x.op === "imp" || x.op === "iff") set({ op: x.op === "imp" ? "iff" : "imp", args: x.args });
  else set({ op: r.pick(["and", "or", "xor", "xnor", "nand", "nor"].filter((o) => o !== x.op)), args: x.args });
  return top;
}

test(`${CASES} random expressions agree with their truth tables`, async () => {
  const r = rng(20261111);
  let checked = 0;
  const seen = { unsatisfiable: 0, mutatedSame: 0, mutatedDifferent: 0 };
  for (let batch = 0; batch < CASES / PER_SESSION; batch++) {
    const s = await Session.create({ vars: VS });
    for (let k = 0; k < PER_SESSION; k++) {
      const n = 1 + r.int(VS.length);
      const used = VS.slice(0, n);
      const ast = randomAst(r, used);
      const table = truthTable((env) => evalAst(ast, env), VS);
      const ones = table.reduce((a, b) => a + b, 0);
      const where = `case ${checked}: ${JSON.stringify(ast)}`;

      s.define("f", ast);

      // Both views, evaluated on every assignment, match the expression.
      for (const view of ["cudd", "textbook"]) {
        const g = s.graph(["f"], view);
        assert.deepEqual(truthTable((env) => evalGraph(g, "f", env), VS), table, `${view} view, ${where}`);
        const terminals = g.terminals.filter((t) => t >= 0).length;
        assert.equal(s.size("f", view), g.nodes.length + terminals, `size counts terminals, ${view} view, ${where}`);
      }

      // count matches the truth table, over every variable and over the ones used.
      assert.equal(s.count("f"), ones, where);
      assert.equal(s.count("f", used), ones / 2 ** (VS.length - n), where);

      // pickCube satisfies the function, or is null exactly when there is none.
      const cube = s.pickCube("f");
      if (ones === 0) {
        assert.equal(cube, null, where);
        seen.unsatisfiable++;
      } else assert.equal(evalAst(ast, cube), 1, `pickCube ${JSON.stringify(cube)}, ${where}`);

      // An equivalent rewriting gives the same node.
      s.define("same", rewrite(ast, r));
      assert.equal(s.equal("f", "same"), true, where);

      // After a one-node change, equal agrees with the truth tables.
      const changed = mutate(ast, r, used.length > 1 ? used : VS.slice(0, 2));
      s.define("changed", changed);
      const changedTable = truthTable((env) => evalAst(changed, env), VS);
      const same = changedTable.every((x, i) => x === table[i]);
      assert.equal(s.equal("f", "changed"), same, `mutated ${JSON.stringify(changed)}, ${where}`);
      seen[same ? "mutatedSame" : "mutatedDifferent"]++;
      checked++;
    }
    assert.equal(s.dispose(), 0, "no leaked references");
  }
  // Guard the guard: every branch of the checks above was exercised.
  assert.equal(checked, CASES);
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `no case had ${k}`);
});
