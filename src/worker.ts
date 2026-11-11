// The Web Worker side of WorkerSession: holds one Session and runs the calls
// the main thread sends it, one at a time.
import { Session } from './session.js';

/** The Session methods a WorkerSession may call. */
export const METHODS = new Set([
  'define', 'remove', 'names', 'equal', 'implies', 'count', 'pickCube', 'eval', 'support', 'size',
  'sharedSize', 'quantify', 'andExists', 'rename', 'cofactor', 'compose', 'order', 'setOrder',
  'swapAdjacent', 'reorder', 'graph', 'dot', 'stats', 'dispose',
]);

/** Methods that can change the variable order; their replies carry the order, for restart(). */
export const ORDER_METHODS = new Set(['setOrder', 'swapAdjacent', 'reorder']);

export type Request = { id: number; method: string; args: unknown[] };
export type Reply =
  | { id: number; ok: true; value: unknown; order?: string[] }
  | { id: number; ok: false; error: { name: string; message: string; kind?: string }; order?: string[] };

type Scope = {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply): void;
};

const scope = self as unknown as Scope;
let session: Session | null = null;

scope.onmessage = async (e) => {
  const { id, method, args } = e.data;
  let order: string[] | undefined;
  try {
    let value: unknown;
    if (method === 'create') {
      session = await Session.create(args[0] as Parameters<typeof Session.create>[0]);
    } else {
      if (!session) throw new Error('the session has not been created');
      if (!METHODS.has(method)) throw new TypeError(`not a Session method: ${method}`);
      try {
        value = (session as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
      } finally {
        if (ORDER_METHODS.has(method)) order = session.order();
      }
    }
    scope.postMessage({ id, ok: true, value, order });
  } catch (err) {
    const x = err as Error & { kind?: string };
    scope.postMessage({ id, ok: false, error: { name: x.name, message: x.message, kind: x.kind }, order });
  }
};
