// WorkerSession: the asynchronous, browser-side mirror of Session (LIB-8).
// CUDD runs in a Web Worker, so a long computation never blocks the page, and
// a call that runs past its hard timeout is stopped by terminating the worker.
import { BudgetError } from './errors.js';
import type { Ast, Graph, Limits, ReorderMethod, Stats, View } from './types.js';
import type { Reply } from './worker.js';

export type WorkerSessionOptions = {
  vars: string[];
  order?: string[];
  limits?: Limits;
  /** The .wasm file, when it is not beside cudd.mjs. */
  wasmUrl?: string;
  /** The worker script, when it is not beside this file. */
  workerUrl?: string | URL;
  /** Per call: past this, the worker is terminated and the call rejects with BudgetError('time'). Default 10,000. */
  hardTimeoutMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Rebuilds the error a worker reported, with its original class. */
function revive(e: { name: string; message: string; kind?: string }): Error {
  if (e.name === 'BudgetError') return new BudgetError(e.kind as 'time' | 'nodes' | 'memory', e.message);
  if (e.name === 'TypeError') return new TypeError(e.message);
  if (e.name === 'RangeError') return new RangeError(e.message);
  return new Error(e.message);
}

export class WorkerSession {
  private readonly options: WorkerSessionOptions;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** The last order the worker reported, restored by restart(). */
  private lastOrder: string[] | undefined;
  private stopped: Error | null = null;

  private constructor(options: WorkerSessionOptions) {
    this.options = { ...options, vars: [...options.vars] };
    this.lastOrder = options.order ? [...options.order] : undefined;
  }

  /** Starts a worker and creates its Session. */
  static async create(options: WorkerSessionOptions): Promise<WorkerSession> {
    const s = new WorkerSession(options);
    try {
      await s.start();
    } catch (e) {
      s.stop(e as Error);
      throw e;
    }
    return s;
  }

  /**
   * Replaces the worker with a new one that has the same variables and the
   * last known order. Definitions are not restored; the caller re-applies them.
   */
  async restart(): Promise<void> {
    this.stop(new Error('the session was restarted'));
    await this.start();
  }

  /** "ready" while the worker runs; "stopped" after a hard timeout, a crash or dispose. */
  get status(): 'ready' | 'stopped' {
    return this.stopped ? 'stopped' : 'ready';
  }

  // ── Session methods, as promises ─────────────────────────────────────────

  define(name: string, ast: Ast): Promise<{ size: number }> { return this.call('define', name, ast); }
  remove(name: string): Promise<void> { return this.call('remove', name); }
  names(): Promise<string[]> { return this.call('names'); }
  equal(a: string, b: string): Promise<boolean> { return this.call('equal', a, b); }
  implies(a: string, b: string): Promise<boolean> { return this.call('implies', a, b); }
  count(name: string, over?: string[]): Promise<number> { return this.call('count', name, over); }
  pickCube(name: string, over?: string[]): Promise<Record<string, 0 | 1> | null> { return this.call('pickCube', name, over); }
  eval(name: string, a: Record<string, 0 | 1>): Promise<0 | 1> { return this.call('eval', name, a); }
  support(name: string): Promise<string[]> { return this.call('support', name); }
  size(name: string, view?: View): Promise<number> { return this.call('size', name, view); }
  sharedSize(names: string[]): Promise<number> { return this.call('sharedSize', names); }
  quantify(newName: string, kind: 'exists' | 'forall', name: string, vars: string[]): Promise<void> {
    return this.call('quantify', newName, kind, name, vars);
  }
  andExists(newName: string, a: string, b: string, vars: string[]): Promise<void> {
    return this.call('andExists', newName, a, b, vars);
  }
  rename(newName: string, name: string, pairs: [string, string][]): Promise<void> {
    return this.call('rename', newName, name, pairs);
  }
  cofactor(newName: string, name: string, a: Record<string, 0 | 1>): Promise<void> {
    return this.call('cofactor', newName, name, a);
  }
  compose(newName: string, name: string, v: string, withName: string): Promise<void> {
    return this.call('compose', newName, name, v, withName);
  }
  order(): Promise<string[]> { return this.call('order'); }
  setOrder(names: string[]): Promise<void> { return this.call('setOrder', names); }
  swapAdjacent(level: number): Promise<void> { return this.call('swapAdjacent', level); }
  reorder(m: ReorderMethod): Promise<{ order: string[]; size: number }> { return this.call('reorder', m); }
  graph(names: string[], view: View): Promise<Graph> { return this.call('graph', names, view); }
  dot(names: string[]): Promise<string> { return this.call('dot', names); }
  stats(): Promise<Stats> { return this.call('stats'); }

  /** Frees the session and ends the worker. Resolves to Cudd_CheckZeroRef: 0 means no leaks. */
  async dispose(): Promise<number> {
    const leaks = await this.call<number>('dispose');
    this.stop(new Error('the session has been disposed'));
    return leaks;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    const url = this.options.workerUrl ?? new URL('./worker.js', import.meta.url);
    const worker = new Worker(url, { type: 'module' });
    this.worker = worker;
    this.stopped = null;
    worker.onmessage = (e: MessageEvent<Reply>) => this.receive(e.data);
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.stop(new Error(`the worker failed: ${e.message}`));
    };
    const { workerUrl: _w, hardTimeoutMs: _h, ...create } = this.options;
    await this.send('create', [{ ...create, order: this.lastOrder }]);
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    // Trailing undefined arguments are dropped, so the Session sees its defaults.
    while (args.length && args[args.length - 1] === undefined) args.pop();
    return this.send(method, args) as Promise<T>;
  }

  private send(method: string, args: unknown[]): Promise<unknown> {
    if (this.stopped || !this.worker) {
      return Promise.reject(new Error(`the worker is stopped (${this.stopped?.message ?? 'not started'}); call restart()`));
    }
    const id = this.nextId++;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The worker is stuck in CUDD: end it. Its state is lost; restart() recreates it.
        this.pending.delete(id);
        this.stop(new Error('a call ran past the hard timeout'));
        reject(new BudgetError('time', `stopped after the ${this.hardTimeoutMs} ms hard timeout`));
      }, this.hardTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, args });
    });
  }

  private get hardTimeoutMs(): number {
    return this.options.hardTimeoutMs ?? 10_000;
  }

  private receive(reply: Reply): void {
    if (reply.order) this.lastOrder = reply.order;
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply.value);
    else p.reject(revive(reply.error));
  }

  /** Ends the worker, and rejects every call still waiting with the reason. */
  private stop(reason: Error): void {
    this.stopped = reason;
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }
}

export { BudgetError };
export type { Ast, Graph, Limits, ReorderMethod, Stats, View };
