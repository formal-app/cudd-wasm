// Session: a synchronous BDD API over named functions, backed by CUDD 3.0.0
// compiled to WebAssembly (specification §4.1). Used by the browser worker and
// by the server's grader.
import createModule, { type CuddModule } from './cudd.mjs';
import type { Ast, Graph, Limits, ReorderMethod, Stats, View } from './types.js';

/** An operation exceeded one of the session's budgets. The session continues. */
export class BudgetError extends Error {
  readonly kind: 'time' | 'nodes' | 'memory';
  constructor(kind: 'time' | 'nodes' | 'memory', message?: string) {
    super(message ?? `exceeded the ${kind} budget`);
    this.name = 'BudgetError';
    this.kind = kind;
  }
}

/**
 * The most variables a session may have (LIB-5; CW_MAX_VARS in src/glue.h).
 * CUDD recurses once per variable level, and in a browser the JavaScript
 * engine's call stack, not WebAssembly's, is the limit: about 2,750 levels in
 * a Chromium Web Worker. 1,000 keeps the deepest recursion under half of that.
 */
export const MAX_VARS = 1000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Cudd_ReorderingType and Cudd_ErrorType values, from cudd.h.
const REORDER: Record<ReorderMethod, number> = {
  random: 2, sift: 4, 'sift-converge': 5, window2: 8, window3: 9, window4: 10, exact: 21,
};
const CUDD_MEMORY_OUT = 1;
const CUDD_TOO_MANY_NODES = 2;
const CUDD_MAX_MEM_EXCEEDED = 3;
const CUDD_TIMEOUT_EXPIRED = 4;

// CUDD marks a complemented edge in the pointer's lowest bit (the Cudd_Not,
// Cudd_Regular and Cudd_IsComplement macros). Memory is at most 1 GB, so every
// pointer is a positive 32-bit integer.
const regular = (f: number) => f & ~1;
const isComplement = (f: number) => (f & 1) === 1;
const complement = (f: number) => f ^ 1;

// A fixed seed for CUDD's random number generator, set before every operation
// that uses it, so the same diagram always gives the same answer.
const SEED = 1;

type Binary = (dd: number, f: number, g: number) => number;

export class Session {
  private readonly m: CuddModule;
  private readonly dd: number;
  private readonly vars: string[];
  private readonly index: Map<string, number>;
  private readonly timeMs: number | undefined;
  /** Named functions; the only CUDD references the session holds. */
  private readonly fns = new Map<string, number>();
  private disposed = false;

  /** Creates a session over the given variables. Async only to load the module. */
  static async create(o: {
    vars: string[];
    order?: string[];
    limits?: Limits;
    wasmUrl?: string;
  }): Promise<Session> {
    const vars = [...o.vars];
    for (const v of vars)
      if (typeof v !== 'string' || !IDENTIFIER.test(v)) throw new TypeError(`not a variable name: ${String(v)}`);
    if (new Set(vars).size !== vars.length) throw new RangeError('a variable is declared twice');
    if (vars.length > MAX_VARS)
      throw new RangeError(`at most ${MAX_VARS} variables are supported; this has ${vars.length}`);
    const limits = o.limits ?? {};
    for (const [k, v] of Object.entries(limits))
      if (v !== undefined && !(Number.isFinite(v) && v > 0)) throw new RangeError(`${k} must be a positive number`);

    const wasmUrl = o.wasmUrl;
    const m = await createModule(
      wasmUrl ? { locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path) } : undefined,
    );
    const dd = m._cw_manager_new(vars.length);
    if (!dd) throw new BudgetError('memory', 'not enough memory to create the BDD manager');
    if (limits.maxNodes !== undefined) m._Cudd_SetMaxLive(dd, Math.floor(limits.maxNodes));
    if (limits.maxMemoryMB !== undefined) m._Cudd_SetMaxMemory(dd, Math.floor(limits.maxMemoryMB * 1048576));

    const s = new Session(m, dd, vars, limits.timeMs);
    if (o.order) s.setOrder(o.order);
    return s;
  }

  private constructor(m: CuddModule, dd: number, vars: string[], timeMs: number | undefined) {
    this.m = m;
    this.dd = dd;
    this.vars = vars;
    this.index = new Map(vars.map((v, i) => [v, i]));
    this.timeMs = timeMs;
  }

  // ── Definitions ──────────────────────────────────────────────────────────

  /** Defines (or replaces) a named function. Returns its CUDD-view size. */
  define(name: string, ast: Ast): { size: number } {
    this.begin();
    this.checkNewName(name);
    const f = this.build(ast);
    this.store(name, f);
    return { size: this.m._Cudd_DagSize(f) };
  }

  remove(name: string): void {
    this.begin();
    const f = this.fn(name);
    this.m._Cudd_RecursiveDeref(this.dd, f);
    this.fns.delete(name);
  }

  /** Defined names, in the order they were first defined. */
  names(): string[] {
    this.begin();
    return [...this.fns.keys()];
  }

  // ── Questions about functions ────────────────────────────────────────────

  /** True when a and b are the same function: one node, since BDDs are canonical. */
  equal(a: string, b: string): boolean {
    this.begin();
    return this.fn(a) === this.fn(b);
  }

  /** True when a implies b. */
  implies(a: string, b: string): boolean {
    this.begin();
    return this.m._Cudd_bddLeq(this.dd, this.fn(a), this.fn(b)) === 1;
  }

  /** Minterms over `over` (default: every variable). TypeError if the support is not within it. */
  count(name: string, over?: string[]): number {
    this.begin();
    const f = this.fn(name);
    const idx = this.over(f, over);
    const n = this.m._Cudd_CountMinterm(this.dd, f, idx.length);
    if (n < 0) this.fail();
    return n;
  }

  /**
   * One satisfying assignment over `over` (default: every variable), or null
   * when the function is unsatisfiable. Variables the cube leaves free are 0.
   * TypeError if the support is not within `over`.
   */
  pickCube(name: string, over?: string[]): Record<string, 0 | 1> | null {
    this.begin();
    const f = this.fn(name);
    const idx = this.over(f, over);
    if (f === this.m._Cudd_ReadLogicZero(this.dd)) return null;
    const buf = this.m._malloc(Math.max(1, this.vars.length));
    try {
      this.m._Cudd_Srandom(this.dd, SEED);
      if (!this.m._Cudd_bddPickOneCube(this.dd, f, buf)) this.fail();
      const out: Record<string, 0 | 1> = {};
      for (const i of idx) out[this.vars[i]] = this.m.HEAPU8[buf + i] === 1 ? 1 : 0;
      return out;
    } finally {
      this.m._free(buf);
    }
  }

  /** The function's value on an assignment. Every variable in its support must be given. */
  eval(name: string, a: Record<string, 0 | 1>): 0 | 1 {
    this.begin();
    const f = this.fn(name);
    const values = new Array<number>(this.vars.length).fill(0);
    for (const [v, x] of Object.entries(a)) {
      if (x !== 0 && x !== 1) throw new TypeError(`${v} must be 0 or 1`);
      values[this.varIndex(v)] = x;
    }
    for (const i of this.supportIndices(f))
      if (!(this.vars[i] in a)) throw new TypeError(`no value for ${this.vars[i]}, which ${name} depends on`);
    const buf = this.ints(values);
    try {
      return this.m._Cudd_Eval(this.dd, f, buf) === this.m._Cudd_ReadOne(this.dd) ? 1 : 0;
    } finally {
      this.m._free(buf);
    }
  }

  /** The variables the function depends on, in declaration order. */
  support(name: string): string[] {
    this.begin();
    return this.supportIndices(this.fn(name)).map((i) => this.vars[i]);
  }

  /** Node count including terminals: CUDD's (complement edges, one terminal) or the textbook ROBDD's. */
  size(name: string, view: View = 'cudd'): number {
    this.begin();
    const f = this.fn(name);
    if (view === 'cudd') return this.m._Cudd_DagSize(f);
    if (view !== 'textbook') throw new TypeError(`unknown view: ${String(view)}`);
    const a = this.check(this.m._Cudd_BddToAdd(this.dd, f));
    try {
      return this.m._Cudd_DagSize(a);
    } finally {
      this.m._Cudd_RecursiveDeref(this.dd, a);
    }
  }

  /** Nodes in the functions' shared diagram, CUDD view. */
  sharedSize(names: string[]): number {
    this.begin();
    return this.sharing(names.map((n) => this.fn(n)));
  }

  // ── Derived functions ────────────────────────────────────────────────────

  /** newName = ∃vars. name, or ∀vars. name. */
  quantify(newName: string, kind: 'exists' | 'forall', name: string, vars: string[]): void {
    this.begin();
    this.checkNewName(newName);
    if (kind !== 'exists' && kind !== 'forall') throw new TypeError(`unknown quantifier: ${String(kind)}`);
    const f = this.fn(name);
    this.store(newName, this.abstract(kind, f, vars));
  }

  /** newName = ∃vars. a ∧ b, computed in one pass (Cudd_bddAndAbstract). */
  andExists(newName: string, a: string, b: string, vars: string[]): void {
    this.begin();
    this.checkNewName(newName);
    const f = this.fn(a);
    const g = this.fn(b);
    const cube = this.cube(vars);
    try {
      this.store(newName, this.check(this.m._Cudd_bddAndAbstract(this.dd, f, g, cube)));
    } finally {
      this.m._Cudd_RecursiveDeref(this.dd, cube);
    }
  }

  /** newName = name with each pair of variables swapped. */
  rename(newName: string, name: string, pairs: [string, string][]): void {
    this.begin();
    this.checkNewName(newName);
    const f = this.fn(name);
    const x = pairs.map(([v]) => this.varIndex(v));
    const y = pairs.map(([, w]) => this.varIndex(w));
    if (new Set([...x, ...y]).size !== 2 * pairs.length) throw new RangeError('a variable appears in more than one pair');
    const xs = this.ints(x.map((i) => this.m._Cudd_bddIthVar(this.dd, i)));
    const ys = this.ints(y.map((i) => this.m._Cudd_bddIthVar(this.dd, i)));
    try {
      this.store(newName, this.check(this.m._Cudd_bddSwapVariables(this.dd, f, xs, ys, pairs.length)));
    } finally {
      this.m._free(xs);
      this.m._free(ys);
    }
  }

  /** newName = name with the given variables fixed. */
  cofactor(newName: string, name: string, a: Record<string, 0 | 1>): void {
    this.begin();
    this.checkNewName(newName);
    const f = this.fn(name);
    const literals = Object.entries(a).map(([v, x]) => {
      if (x !== 0 && x !== 1) throw new TypeError(`${v} must be 0 or 1`);
      const lit = this.m._Cudd_bddIthVar(this.dd, this.varIndex(v));
      return x ? lit : complement(lit);
    });
    // The cube of the literals; combine releases it if an AND fails.
    let cube = this.ref(this.m._Cudd_ReadOne(this.dd));
    for (const lit of literals) cube = this.combine(this.m._Cudd_bddAnd, cube, lit, false);
    try {
      this.store(newName, this.check(this.m._Cudd_Cofactor(this.dd, f, cube)));
    } finally {
      this.m._Cudd_RecursiveDeref(this.dd, cube);
    }
  }

  /** newName = name with variable v replaced by the function withName. */
  compose(newName: string, name: string, v: string, withName: string): void {
    this.begin();
    this.checkNewName(newName);
    const f = this.fn(name);
    const g = this.fn(withName);
    this.store(newName, this.check(this.m._Cudd_bddCompose(this.dd, f, g, this.varIndex(v))));
  }

  // ── Variable order ───────────────────────────────────────────────────────

  /** Every variable, top to bottom. */
  order(): string[] {
    this.begin();
    return this.currentOrder();
  }

  /** Moves the variables into the given order (a permutation of every variable). */
  setOrder(names: string[]): void {
    this.begin();
    if (!Array.isArray(names) || names.length !== this.vars.length)
      throw new RangeError(`an order must list all ${this.vars.length} variables`);
    const idx = names.map((v) => {
      const i = this.index.get(v);
      if (i === undefined) throw new RangeError(`not a variable: ${String(v)}`);
      return i;
    });
    if (new Set(idx).size !== idx.length) throw new RangeError('an order lists a variable twice');
    this.shuffle(idx);
  }

  /** Swaps the variables at levels `level` and `level + 1`. */
  swapAdjacent(level: number): void {
    this.begin();
    if (!Number.isInteger(level) || level < 0 || level >= this.vars.length - 1)
      throw new RangeError(`level must be an integer from 0 to ${this.vars.length - 2}`);
    const idx = this.currentOrder().map((v) => this.index.get(v)!);
    [idx[level], idx[level + 1]] = [idx[level + 1], idx[level]];
    this.shuffle(idx);
  }

  /**
   * Reorders with one of CUDD's methods. Returns the new order and the shared
   * size of every named function. Under a time budget, CUDD stops between
   * variables; the functions are unchanged, and BudgetError('time') reports it.
   */
  reorder(method: ReorderMethod): { order: string[]; size: number } {
    this.begin();
    const code = REORDER[method];
    if (code === undefined) throw new TypeError(`unknown reordering method: ${String(method)}`);
    // CUDD compares elapsed time plus all earlier reordering time with the
    // limit, so the limit is raised by that earlier time.
    if (this.timeMs !== undefined)
      this.m._Cudd_SetTimeLimit(this.dd, this.timeMs + this.m._Cudd_ReadReorderingTime(this.dd));
    this.m._Cudd_Srandom(this.dd, SEED);
    if (!this.m._Cudd_ReduceHeap(this.dd, code, 0)) this.fail();
    if (this.timeMs !== undefined && this.m._Cudd_ReadElapsedTime(this.dd) > this.timeMs)
      throw new BudgetError('time');
    return { order: this.currentOrder(), size: this.sharing([...this.fns.values()]) };
  }

  // ── Diagrams ─────────────────────────────────────────────────────────────

  /** The functions' shared diagram, in either view. */
  graph(names: string[], view: View): Graph {
    this.begin();
    if (view !== 'cudd' && view !== 'textbook') throw new TypeError(`unknown view: ${String(view)}`);
    const fs = names.map((n) => this.fn(n));
    const roots = view === 'cudd' ? fs : fs.map((f) => this.check(this.m._Cudd_BddToAdd(this.dd, f)));
    try {
      return this.walk(names, roots, view);
    } finally {
      if (view === 'textbook') for (const a of roots) this.m._Cudd_RecursiveDeref(this.dd, a);
    }
  }

  /** CUDD's own DOT (Cudd_DumpDot) for the functions. */
  dot(names: string[]): string {
    this.begin();
    const fs = names.map((n) => this.fn(n));
    const strings: number[] = [];
    const str = (s: string) => {
      const n = this.m.lengthBytesUTF8(s) + 1;
      const p = this.m._malloc(n);
      this.m.stringToUTF8(s, p, n);
      strings.push(p);
      return p;
    };
    const nodes = this.ints(fs);
    const inames = this.ints(this.vars.map(str));
    const onames = this.ints(names.map(str));
    try {
      const out = this.m._cw_dot(this.dd, fs.length, nodes, inames, onames);
      if (!out) this.fail();
      try {
        return this.m.UTF8ToString(out);
      } finally {
        this.m._free(out);
      }
    } finally {
      for (const p of [nodes, inames, onames, ...strings]) this.m._free(p);
    }
  }

  stats(): Stats {
    this.begin();
    const { m, dd } = this;
    return {
      live: m._Cudd_ReadNodeCount(dd),
      peakLive: m._Cudd_ReadPeakLiveNodeCount(dd),
      cacheLookups: m._Cudd_ReadCacheLookUps(dd),
      cacheHits: m._Cudd_ReadCacheHits(dd),
      gcs: m._Cudd_ReadGarbageCollections(dd),
      reorderings: m._Cudd_ReadReorderings(dd),
      swapSteps: m._Cudd_ReadSwapSteps(dd),
      memoryBytes: m._Cudd_ReadMemoryInUse(dd),
    };
  }

  /** Frees everything. Returns Cudd_CheckZeroRef: 0 means no reference leaked. */
  dispose(): number {
    this.begin();
    for (const f of this.fns.values()) this.m._Cudd_RecursiveDeref(this.dd, f);
    this.fns.clear();
    const leaks = this.m._Cudd_CheckZeroRef(this.dd);
    this.m._Cudd_Quit(this.dd);
    this.disposed = true;
    return leaks;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Starts an operation: the session is live, and the time budget restarts. */
  private begin(): void {
    if (this.disposed) throw new Error('this session has been disposed');
    if (this.timeMs !== undefined) {
      this.m._Cudd_SetTimeLimit(this.dd, this.timeMs);
      this.m._Cudd_ResetStartTime(this.dd);
    }
  }

  /** Turns CUDD's error code into an exception, and clears it. */
  private fail(): never {
    const code = this.m._Cudd_ReadErrorCode(this.dd);
    this.m._Cudd_ClearErrorCode(this.dd);
    if (code === CUDD_TIMEOUT_EXPIRED) throw new BudgetError('time');
    if (code === CUDD_TOO_MANY_NODES) throw new BudgetError('nodes');
    if (code === CUDD_MEMORY_OUT || code === CUDD_MAX_MEM_EXCEEDED) throw new BudgetError('memory');
    throw new Error(`CUDD failed with error code ${code}`);
  }

  /** References a result, or fails when CUDD returned NULL. */
  private check(f: number): number {
    if (!f) this.fail();
    this.m._Cudd_Ref(f);
    return f;
  }

  private ref(f: number): number {
    this.m._Cudd_Ref(f);
    return f;
  }

  private fn(name: string): number {
    const f = this.fns.get(name);
    if (f === undefined) throw new TypeError(`no function named ${String(name)}`);
    return f;
  }

  private varIndex(v: string): number {
    const i = this.index.get(v);
    if (i === undefined) throw new TypeError(`no variable named ${String(v)}`);
    return i;
  }

  private checkNewName(name: string): void {
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) throw new TypeError(`not a function name: ${String(name)}`);
    if (this.index.has(name)) throw new TypeError(`${name} is a variable, so it cannot name a function`);
  }

  /** Stores a referenced node under a name, releasing what the name held before. */
  private store(name: string, f: number): void {
    const old = this.fns.get(name);
    this.fns.set(name, f);
    if (old !== undefined) this.m._Cudd_RecursiveDeref(this.dd, old);
  }

  /** A referenced node for an expression; intermediates are released at once. */
  private build(a: Ast): number {
    const { m, dd } = this;
    switch (a.op) {
      case 'const':
        if (a.value !== 0 && a.value !== 1) throw new TypeError('a constant must be 0 or 1');
        return this.ref(a.value ? m._Cudd_ReadOne(dd) : m._Cudd_ReadLogicZero(dd));
      case 'var':
        return this.ref(m._Cudd_bddIthVar(dd, this.varIndex(a.name)));
      case 'ref':
        return this.ref(this.fn(a.name));
      case 'not':
        return complement(this.build(a.arg));
      case 'and': return this.fold(a.args, m._Cudd_bddAnd);
      case 'or': return this.fold(a.args, m._Cudd_bddOr);
      case 'xor': return this.fold(a.args, m._Cudd_bddXor);
      case 'nand': return complement(this.fold(a.args, m._Cudd_bddAnd));
      case 'nor': return complement(this.fold(a.args, m._Cudd_bddOr));
      case 'xnor': return complement(this.fold(a.args, m._Cudd_bddXor));
      case 'iff': return this.fold(this.pair(a), m._Cudd_bddXnor);
      case 'imp': {
        // a -> b = (not a) or b
        const [p, q] = this.pair(a);
        return this.fold([{ op: 'not', arg: p }, q], m._Cudd_bddOr);
      }
      case 'ite': {
        const i = this.build(a.if);
        let t = 0;
        let e = 0;
        try {
          t = this.build(a.then);
          e = this.build(a.else);
          return this.check(m._Cudd_bddIte(dd, i, t, e));
        } finally {
          m._Cudd_RecursiveDeref(dd, i);
          if (t) m._Cudd_RecursiveDeref(dd, t);
          if (e) m._Cudd_RecursiveDeref(dd, e);
        }
      }
      case 'exists':
      case 'forall': {
        const f = this.build(a.arg);
        try {
          return this.abstract(a.op, f, a.vars);
        } finally {
          m._Cudd_RecursiveDeref(dd, f);
        }
      }
      default:
        throw new TypeError(`unknown operator: ${String((a as { op: unknown }).op)}`);
    }
  }

  private pair(a: { op: string; args: Ast[] }): [Ast, Ast] {
    if (!Array.isArray(a.args) || a.args.length !== 2) throw new TypeError(`${a.op} takes exactly two operands`);
    return [a.args[0], a.args[1]];
  }

  /** args[0] op args[1] op ..., folded from the left; referenced. */
  private fold(args: Ast[], op: Binary): number {
    if (!Array.isArray(args) || args.length === 0) throw new TypeError('an operator needs at least one operand');
    let acc = this.build(args[0]);
    for (const arg of args.slice(1)) {
      let g: number;
      try {
        g = this.build(arg);
      } catch (e) {
        this.m._Cudd_RecursiveDeref(this.dd, acc);
        throw e;
      }
      acc = this.combine(op, acc, g, true);
    }
    return acc;
  }

  /** op(f, g), referenced; releases f, and g when releaseG. On failure, releases them and throws. */
  private combine(op: Binary, f: number, g: number, releaseG: boolean): number {
    const r = op(this.dd, f, g);
    if (r) this.m._Cudd_Ref(r);
    this.m._Cudd_RecursiveDeref(this.dd, f);
    if (releaseG) this.m._Cudd_RecursiveDeref(this.dd, g);
    if (!r) this.fail();
    return r;
  }

  /** ∃vars. f or ∀vars. f, referenced. f stays referenced by the caller. */
  private abstract(kind: 'exists' | 'forall', f: number, vars: string[]): number {
    const cube = this.cube(vars);
    try {
      const op = kind === 'exists' ? this.m._Cudd_bddExistAbstract : this.m._Cudd_bddUnivAbstract;
      return this.check(op(this.dd, f, cube));
    } finally {
      this.m._Cudd_RecursiveDeref(this.dd, cube);
    }
  }

  /** The conjunction of the given variables, referenced. */
  private cube(vars: string[]): number {
    if (!Array.isArray(vars)) throw new TypeError('vars must be a list of variable names');
    const idx = vars.map((v) => this.varIndex(v));
    const buf = this.ints(idx);
    try {
      return this.check(this.m._Cudd_IndicesToCube(this.dd, buf, idx.length));
    } finally {
      this.m._free(buf);
    }
  }

  /** Variable indices for `over` (default: all), checking that f's support is within them. */
  private over(f: number, over?: string[]): number[] {
    const idx = over === undefined ? this.vars.map((_, i) => i) : over.map((v) => this.varIndex(v));
    if (new Set(idx).size !== idx.length) throw new TypeError('a variable is listed twice');
    const within = new Set(idx);
    for (const i of this.supportIndices(f))
      if (!within.has(i)) throw new TypeError(`the function depends on ${this.vars[i]}, which is not listed`);
    return idx;
  }

  private supportIndices(f: number): number[] {
    const out = this.m._malloc(4);
    try {
      const n = this.m._Cudd_SupportIndices(this.dd, f, out);
      if (n < 0) this.fail();
      const arr = this.m.HEAP32[out >> 2];
      const idx = n > 0 ? Array.from(this.m.HEAP32.subarray(arr >> 2, (arr >> 2) + n)) : [];
      if (arr) this.m._free(arr);
      return idx.sort((a, b) => a - b);
    } finally {
      this.m._free(out);
    }
  }

  private sharing(fs: number[]): number {
    const buf = this.ints(fs);
    try {
      return this.m._Cudd_SharingSize(buf, fs.length);
    } finally {
      this.m._free(buf);
    }
  }

  private currentOrder(): string[] {
    return this.vars.map((_, level) => this.vars[this.m._Cudd_ReadInvPerm(this.dd, level)]);
  }

  /** Cudd_ShuffleHeap to the order given as variable indices, top to bottom. */
  private shuffle(idx: number[]): void {
    if (idx.length < 2) return;
    const buf = this.ints(idx);
    try {
      if (!this.m._Cudd_ShuffleHeap(this.dd, buf)) this.fail();
    } finally {
      this.m._free(buf);
    }
  }

  /** Copies integers into module memory; the caller frees the result. */
  private ints(values: number[]): number {
    const p = this.m._malloc(Math.max(4, 4 * values.length));
    this.m.HEAP32.set(values, p >> 2);
    return p;
  }

  /** The graph of a shared diagram, numbering nodes depth-first, then before else. */
  private walk(names: string[], roots: number[], view: View): Graph {
    const { m, dd } = this;
    const ids = new Map<number, number>();
    const order: number[] = [];
    for (const root of roots) {
      const stack = [regular(root)];
      while (stack.length) {
        const n = stack.pop()!;
        if (ids.has(n)) continue;
        ids.set(n, ids.size);
        order.push(n);
        if (!m._Cudd_IsConstant(n)) stack.push(regular(m._Cudd_E(n)), regular(m._Cudd_T(n)));
      }
    }
    const nodes: Graph['nodes'] = [];
    for (const n of order) {
      if (m._Cudd_IsConstant(n)) continue;
      const index = m._Cudd_NodeReadIndex(n);
      const t = m._Cudd_T(n);
      const e = m._Cudd_E(n);
      nodes.push({
        id: ids.get(n)!,
        key: n,
        var: this.vars[index],
        level: m._Cudd_ReadPerm(dd, index),
        hi: ids.get(regular(t))!,
        lo: ids.get(regular(e))!,
        loComplement: isComplement(e),
      });
    }
    const one = m._Cudd_ReadOne(dd);
    const terminals = view === 'cudd'
      ? [ids.get(one)!]
      : [ids.get(m._Cudd_ReadZero(dd)) ?? -1, ids.get(one) ?? -1];
    return {
      view,
      order: this.currentOrder(),
      nodes,
      terminals,
      roots: names.map((name, k) => ({ name, id: ids.get(regular(roots[k]))!, complement: isComplement(roots[k]) })),
    };
  }
}
