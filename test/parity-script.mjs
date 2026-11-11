// The fixed script for LIB-9: the same operations, run in Node through
// Session and in Chromium through WorkerSession, must give byte-identical
// output. Self-contained (no imports), so the browser loads it as it is.
// Every call is awaited, so it works with either class.

export const PARITY_VARS = [
  ...Array.from({ length: 10 }, (_, i) => `x${i}`),
  ...Array.from({ length: 10 }, (_, i) => `y${i}`),
];

/** mulberry32, as in test/helpers.mjs. */
function rng(seed) {
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
  return next;
}

function ast(r, vs, depth) {
  if (depth === 0 || r() < 0.2) return { op: "var", name: r.pick(vs) };
  const k = r();
  if (k < 0.15) return { op: "not", arg: ast(r, vs, depth - 1) };
  if (k < 0.7) {
    const args = Array.from({ length: 2 + r.int(2) }, () => ast(r, vs, depth - 1));
    return { op: r.pick(["and", "or", "xor", "xnor", "nand", "nor"]), args };
  }
  if (k < 0.85) return { op: r.pick(["imp", "iff"]), args: [ast(r, vs, depth - 1), ast(r, vs, depth - 1)] };
  return { op: "ite", if: ast(r, vs, depth - 1), then: ast(r, vs, depth - 1), else: ast(r, vs, depth - 1) };
}

/** Runs the script on a session over PARITY_VARS; returns everything it observed, as JSON. */
export async function parityScript(s) {
  const r = rng(9);
  const out = [];
  const record = async (label, value) => out.push([label, await value]);

  const xy = {
    op: "or",
    args: Array.from({ length: 10 }, (_, i) => ({ op: "and", args: [{ op: "var", name: `x${i}` }, { op: "var", name: `y${i}` }] })),
  };
  await record("define xy", s.define("xy", xy));
  for (let i = 0; i < 6; i++) await record(`define f${i}`, s.define(`f${i}`, ast(r, PARITY_VARS, 6)));
  await s.quantify("q", "exists", "f0", ["x0", "x3", "y5"]);
  await s.andExists("ae", "f1", "f2", ["x1", "y1", "y2"]);
  await s.rename("rn", "f3", [["x0", "y0"], ["x4", "y7"]]);
  await s.cofactor("cf", "f4", { x2: 1, y3: 0 });
  await s.compose("cp", "f5", "x9", "f0");
  const names = await s.names();
  await record("names", names);

  const snapshot = async (label) => {
    await record(`${label} cudd`, s.graph(names, "cudd"));
    await record(`${label} textbook`, s.graph(names, "textbook"));
    await record(`${label} shared`, s.sharedSize(names));
  };
  await snapshot("initial");
  for (const n of names) {
    await record(`count ${n}`, s.count(n));
    await record(`cube ${n}`, s.pickCube(n));
    await record(`support ${n}`, s.support(n));
    await record(`sizes ${n}`, Promise.all([s.size(n, "cudd"), s.size(n, "textbook")]));
  }
  await record("equal", s.equal("f0", "q"));
  await record("implies", s.implies("ae", "q"));

  await s.setOrder([...PARITY_VARS].reverse());
  await s.swapAdjacent(3);
  await snapshot("reordered");
  await record("sift", s.reorder("sift"));
  await snapshot("sifted");
  await record("window3", s.reorder("window3"));
  await record("dot", s.dot(["xy", "f0"]));
  await record("stats", s.stats());
  return JSON.stringify(out);
}
