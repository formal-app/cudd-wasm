// cudd-wasm: CUDD 3.0.0 compiled to WebAssembly, with a TypeScript API.
// In a page, import "@formal-app/cudd-wasm/client" instead: WorkerSession runs
// CUDD in a Web Worker and keeps the WebAssembly module off the main thread.
export { Session, MAX_VARS } from './session.js';
export { BudgetError } from './errors.js';
export { WorkerSession, type WorkerSessionOptions } from './client.js';
export type { Ast, Graph, Limits, ReorderMethod, Stats, View } from './types.js';
