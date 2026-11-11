// Errors shared by Session and WorkerSession. Kept apart from session.ts so
// the page's main thread can use them without loading the WebAssembly module.

/** An operation exceeded one of the session's budgets. The session continues. */
export class BudgetError extends Error {
  readonly kind: 'time' | 'nodes' | 'memory';
  constructor(kind: 'time' | 'nodes' | 'memory', message?: string) {
    super(message ?? `exceeded the ${kind} budget`);
    this.name = 'BudgetError';
    this.kind = kind;
  }
}
