// Shared test helpers: a seeded random number generator, random expressions,
// and reference truth tables computed without CUDD.
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const { Session, BudgetError, MAX_VARS } = await import(`${root}dist/index.js`);

/** mulberry32: a small deterministic generator, returning floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (xs) => xs[next.int(xs.length)];
  next.subset = (xs) => xs.filter(() => next() < 0.5);
  next.shuffle = (xs) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = next.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  return next;
}

export const vars = (n, prefix = "x") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
export const v = (name) => ({ op: "var", name });

const NARY = ["and", "or", "xor", "xnor", "nand", "nor"];
const BINARY = ["imp", "iff"];

/** A random expression over the given variables. */
export function randomAst(r, vs, depth = 4) {
  if (depth === 0 || r() < 0.2) {
    if (r() < 0.08) return { op: "const", value: r.int(2) };
    return v(r.pick(vs));
  }
  const k = r();
  if (k < 0.12) return { op: "not", arg: randomAst(r, vs, depth - 1) };
  if (k < 0.62) {
    const n = 2 + r.int(2);
    return { op: r.pick(NARY), args: Array.from({ length: n }, () => randomAst(r, vs, depth - 1)) };
  }
  if (k < 0.8) return { op: r.pick(BINARY), args: [randomAst(r, vs, depth - 1), randomAst(r, vs, depth - 1)] };
  if (k < 0.92)
    return { op: "ite", if: randomAst(r, vs, depth - 1), then: randomAst(r, vs, depth - 1), else: randomAst(r, vs, depth - 1) };
  const q = r.subset(vs).slice(0, 3);
  return { op: r() < 0.5 ? "exists" : "forall", vars: q.length ? q : [r.pick(vs)], arg: randomAst(r, vs, depth - 1) };
}

/** The value of an expression on an assignment (an object of 0 and 1), without CUDD. */
export function evalAst(a, env, defs = {}) {
  switch (a.op) {
    case "const": return a.value;
    case "var": return env[a.name];
    case "ref": return evalAst(defs[a.name], env, defs);
    case "not": return 1 - evalAst(a.arg, env, defs);
    case "and": return a.args.every((x) => evalAst(x, env, defs)) ? 1 : 0;
    case "or": return a.args.some((x) => evalAst(x, env, defs)) ? 1 : 0;
    case "xor": return a.args.reduce((s, x) => s ^ evalAst(x, env, defs), 0);
    case "nand": return a.args.every((x) => evalAst(x, env, defs)) ? 0 : 1;
    case "nor": return a.args.some((x) => evalAst(x, env, defs)) ? 0 : 1;
    case "xnor": return 1 - a.args.reduce((s, x) => s ^ evalAst(x, env, defs), 0);
    case "imp": return evalAst(a.args[0], env, defs) ? evalAst(a.args[1], env, defs) : 1;
    case "iff": return evalAst(a.args[0], env, defs) === evalAst(a.args[1], env, defs) ? 1 : 0;
    case "ite": return evalAst(a.if, env, defs) ? evalAst(a.then, env, defs) : evalAst(a.else, env, defs);
    case "exists":
    case "forall": {
      const results = assignments(a.vars).map((sub) => evalAst(a.arg, { ...env, ...sub }, defs));
      return a.op === "exists" ? (results.some(Boolean) ? 1 : 0) : (results.every(Boolean) ? 1 : 0);
    }
  }
  throw new Error(`unknown op ${a.op}`);
}

/** Every assignment to the variables, in binary counting order (the first variable is bit 0). */
export function assignments(vs) {
  return Array.from({ length: 2 ** vs.length }, (_, k) =>
    Object.fromEntries(vs.map((x, i) => [x, (k >> i) & 1])));
}

/** A truth table: an array of 0 and 1 over assignments(vs). */
export const truthTable = (f, vs) => assignments(vs).map(f);

/** The value of a graph's root on an assignment, by walking the exported diagram. */
export function evalGraph(g, rootName, env) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const root = g.roots.find((x) => x.name === rootName);
  return walkFrom(g, byId, root.id, root.complement, env);
}

/** The value of the function a graph node denotes (its regular, uncomplemented function). */
export function evalNode(g, byId, id, env) {
  return walkFrom(g, byId, id, false, env);
}

function walkFrom(g, byId, id, complemented, env) {
  let neg = complemented;
  for (;;) {
    const n = byId.get(id);
    if (!n) {
      // A terminal. CUDD view: the one terminal. Textbook view: [zero, one].
      const value = g.view === "cudd" ? 1 : g.terminals.indexOf(id);
      if (value < 0) throw new Error(`unknown node ${id}`);
      return neg ? 1 - value : value;
    }
    if (env[n.var]) id = n.hi;
    else {
      id = n.lo;
      if (n.loComplement) neg = !neg;
    }
  }
}

/** A function's truth table over vs, read from its CUDD-view graph. */
export function sessionTable(s, name, vs) {
  const g = s.graph([name], "cudd");
  return truthTable((env) => evalGraph(g, name, env), vs);
}
