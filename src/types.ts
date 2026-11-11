// The library's data types (specification §3.3).

/** A Boolean expression tree: the input to Session.define. */
export type Ast =
  | { op: 'const'; value: 0 | 1 }
  | { op: 'var'; name: string }
  | { op: 'ref'; name: string } // a previously defined function
  | { op: 'not'; arg: Ast }
  | { op: 'and' | 'or' | 'xor' | 'xnor' | 'nand' | 'nor' | 'imp' | 'iff'; args: Ast[] }
  | { op: 'ite'; if: Ast; then: Ast; else: Ast }
  | { op: 'exists' | 'forall'; vars: string[]; arg: Ast };

/** Which diagram a size or graph describes. */
export type View = 'cudd' | 'textbook';

/**
 * A diagram, from Session.graph.
 *
 * Node ids are assigned in depth-first order from the roots, in the order the
 * roots were given, visiting a node's then child before its else child.
 * Terminals take ids in the same numbering.
 */
export type Graph = {
  view: View;
  /** Every variable, top to bottom. */
  order: string[];
  nodes: {
    id: number;
    /** CUDD's node identity, for matching animation frames. */
    key: number;
    var: string;
    level: number;
    /** Child ids; terminal ids included. */
    hi: number;
    lo: number;
    /** True when the else edge is complemented; always false in the textbook view. */
    loComplement: boolean;
  }[];
  /**
   * CUDD view: [one], CUDD's single terminal. Textbook view: [zero, one],
   * with -1 for a terminal the diagram does not reach.
   */
  terminals: number[];
  roots: { name: string; id: number; complement: boolean }[];
};

/** Per-session budgets. Each limit applies to every operation. */
export type Limits = {
  /** Time per operation, measured inside CUDD (wall clock in WebAssembly). */
  timeMs?: number;
  /** Live nodes in the manager. */
  maxNodes?: number;
  /** Memory CUDD may use. */
  maxMemoryMB?: number;
};

export type ReorderMethod =
  | 'sift' | 'sift-converge' | 'window2' | 'window3' | 'window4' | 'exact' | 'random';

export type Stats = {
  live: number;
  peakLive: number;
  cacheLookups: number;
  cacheHits: number;
  gcs: number;
  reorderings: number;
  swapSteps: number;
  memoryBytes: number;
};
