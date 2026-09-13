/**
 * Dedicated module worker for save (de)compression. fflate's sync deflate runs HERE, off the main thread
 * — a ~2 MB agent list compresses without ever janking a frame (fflate's own async pool would spawn nested
 * blob workers; a dedicated worker with the sync API gives the same off-main-thread guarantee with no
 * nesting to break under bundling).
 *
 * Protocol: { id, op: 'gzip' | 'gunzip', data: ArrayBuffer } in —
 *            { id, ok: true, data: ArrayBuffer } or { id, ok: false, error: string } out.
 * Buffers are transferred (zero-copy) both ways; `id` correlates concurrent requests.
 */

import { gzipSync, gunzipSync } from 'fflate';

/** Gzip level for saves: 6 — the classic speed/size balance (Sandfall convention). */
const GZIP_LEVEL = 6;

interface InMessage {
  id: number;
  op: 'gzip' | 'gunzip';
  data: ArrayBuffer;
}

// `self` is a DedicatedWorkerGlobalScope here, but the project's tsconfig only loads the DOM lib —
// narrow it to the two members we use instead of pulling in the WebWorker lib.
const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e: MessageEvent): void => {
  const msg = e.data as InMessage;
  try {
    const input = new Uint8Array(msg.data);
    const out = msg.op === 'gzip' ? gzipSync(input, { level: GZIP_LEVEL }) : gunzipSync(input);
    scope.postMessage({ id: msg.id, ok: true, data: out.buffer }, [out.buffer]);
  } catch (err) {
    scope.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
