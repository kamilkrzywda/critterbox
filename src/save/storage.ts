/**
 * Minimal hand-rolled IndexedDB wrapper for the world save blob — one database, one object store, one key.
 * No dependency: the whole API is put/get/delete of a single compressed ArrayBuffer under the fixed key
 * 'world'. The save lives here (not localStorage) because a full agent list gzips to well over
 * localStorage's ~5 MiB quota on big worlds; localStorage keeps only the small slider settings. All
 * failures reject — callers treat them as "no save". Browser-only: never imported from src/sim/.
 */

const DB_NAME = 'critterbox';
const STORE = 'saves';
/** The single key holding the world's compressed save blob. */
export const SAVE_KEY = 'world';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
  }
  return dbPromise;
}

/** Run one request against the store and await its outcome. */
async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Store the compressed save blob (replaces any previous one). */
export function putSave(blob: ArrayBuffer): Promise<void> {
  return withStore('readwrite', (s) => s.put(blob, SAVE_KEY)).then(() => undefined);
}

/** Fetch the stored save blob, or null when none exists. */
export async function getSave(): Promise<ArrayBuffer | null> {
  const value = await withStore('readonly', (s) => s.get(SAVE_KEY));
  return value instanceof ArrayBuffer ? value : null;
}

/** Delete the stored save blob (no-op when absent). */
export function deleteSave(): Promise<void> {
  return withStore('readwrite', (s) => s.delete(SAVE_KEY)).then(() => undefined);
}
