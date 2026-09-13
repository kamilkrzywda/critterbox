/**
 * Save orchestration (Phase 8, main thread): snapshot → serialize → compress in the worker → IndexedDB.
 * The main thread only does cheap buffer copies; all deflate work happens off-thread, so a save never
 * janks a frame. Concurrency is coalesced: at most one save runs at a time — a request arriving mid-save
 * is queued and re-runs once with a FRESH snapshot (so the latest state wins).
 *
 * Autosave cadence: every AUTOSAVE_INTERVAL_MS, but skipped when nothing changed since the last stored
 * save (step counter + agent count unchanged) — a paused/settled world costs ~0. Forced flushes on
 * visibilitychange(hidden) and pagehide(capture) always write, so closing/hiding the tab never loses more
 * than one interval of state. navigator.storage.persist() is requested once at startup to reduce eviction
 * risk (Sandfall pattern). The sim reference is passed as a GETTER: "New World" replaces the whole Sim
 * instance, and autosave must keep pointing at the live one.
 */

import type { Sim } from '../sim/sim';
import { serializeWorld, deserializeWorld, type WorldSnapshot } from './serialize';
import { putSave, getSave, deleteSave } from './storage';

/** Autosave period — the tunable cadence constant (PLAN "Saves": every ~30 s). */
export const AUTOSAVE_INTERVAL_MS = 30_000;

// --- worker round-trip ---------------------------------------------------------

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./saveWorker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

interface PendingRequest {
  resolve: (buf: ArrayBuffer) => void;
  reject: (err: Error) => void;
}

const pending = new Map<number, PendingRequest>();
let nextRequestId = 1;

/** Run one compress/decompress round-trip in the worker. Rejects on corrupt input or worker failure. */
function workerRoundTrip(op: 'gzip' | 'gunzip', data: ArrayBuffer): Promise<ArrayBuffer> {
  ensureWorkerListener();
  const w = getWorker();
  const id = nextRequestId++;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, data }, [data]); // transfer — the main thread gives up this buffer
  });
}

function onWorkerMessage(e: MessageEvent): void {
  const msg = e.data as { id: number; ok: boolean; data?: ArrayBuffer; error?: string };
  const req = pending.get(msg.id);
  if (!req) return; // stale (e.g. after a failed save aborted the queue) — ignore
  pending.delete(msg.id);
  if (msg.ok && msg.data instanceof ArrayBuffer) req.resolve(msg.data);
  else req.reject(new Error(msg.error ?? 'worker request failed'));
}

/** Compress `buf` with gzip in the worker (transfers the buffer). */
export function compress(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return workerRoundTrip('gzip', buf);
}

/** Decompress a gzipped save blob in the worker (transfers the buffer). */
export function decompress(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return workerRoundTrip('gunzip', buf);
}

let listenerInstalled = false;
function ensureWorkerListener(): void {
  if (listenerInstalled) return;
  const w = getWorker();
  w.addEventListener('message', onWorkerMessage);
  w.addEventListener('error', (e: ErrorEvent) => {
    // Worker crashed or failed to load — fail every in-flight request so callers fall back
    // (restore → fresh world, save → skipped with a warning) instead of hanging. The worker is
    // dropped and recreated on the next round-trip.
    for (const req of pending.values()) req.reject(new Error(`worker error: ${e.message}`));
    pending.clear();
    worker = null;
    listenerInstalled = false;
  });
  listenerInstalled = true;
}

// --- world save -----------------------------------------------------------------

/** Snapshot the live sim into a serializable payload (agents/corpses are plain objects — JSON-safe). */
export function snapshotSim(sim: Sim): WorldSnapshot {
  return {
    seed: sim.world.seed,
    size: sim.world.size,
    step: sim.stepCount,
    agents: sim.agents.slice(), // copy out: the sim keeps stepping while we compress
    corpses: sim.corpses.slice(),
  };
}

let saving = false;
let saveQueued = false;
/** Step counter + agent count at the last successful store — the autosave activity baseline. */
let savedStep = -1;
let savedAgentCount = -1;

/**
 * Save the world now: snapshot → serialize → gzip (worker) → IndexedDB. Coalesced — a call made while one
 * is in flight queues a single re-run with a fresh snapshot instead of running twice. Resolves once the
 * blob is stored (or the queued re-run has been scheduled).
 */
export async function saveSim(sim: Sim): Promise<void> {
  if (saving) {
    saveQueued = true; // in-flight save will re-run with a fresh snapshot when it finishes
    return;
  }
  saving = true;
  try {
    const raw = serializeWorld(snapshotSim(sim));
    const packed = await compress(raw);
    await putSave(packed);
    savedStep = sim.stepCount; // activity baseline for the next autosave tick
    savedAgentCount = sim.agents.length;
  } catch (err) {
    console.warn('[critterbox] save failed:', err instanceof Error ? err.message : String(err));
  } finally {
    saving = false;
    if (saveQueued) {
      saveQueued = false;
      void saveSim(sim); // re-run with a fresh snapshot — latest state wins
    }
  }
}

/** True when the sim changed since the last stored save (the autosave activity gate). */
export function hasUnsavedChanges(sim: Sim): boolean {
  return sim.stepCount !== savedStep || sim.agents.length !== savedAgentCount;
}

// --- autosave + flush events ------------------------------------------------------

/**
 * Start the autosave loop: a timer every AUTOSAVE_INTERVAL_MS (skipped when nothing changed since the last
 * store) plus forced flushes on visibilitychange(hidden) and pagehide(capture). `getSim` is a getter —
 * "New World" swaps the Sim instance and the loop must follow it. Returns a stop function that removes all
 * listeners/timers.
 */
export function startAutosave(getSim: () => Sim | null): () => void {
  const timer = window.setInterval(() => {
    const sim = getSim();
    if (sim && hasUnsavedChanges(sim)) void saveSim(sim);
  }, AUTOSAVE_INTERVAL_MS);

  const onVisibility = (): void => {
    const sim = getSim();
    if (document.visibilityState === 'hidden' && sim) void saveSim(sim); // forced flush
  };
  const onPageHide = (): void => {
    const sim = getSim();
    if (sim) void saveSim(sim); // forced flush — closing the tab must not lose state
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide, true); // capture phase per PLAN "Save / load"

  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide, true);
  };
}

/** Request durable storage once at startup (reduces IndexedDB eviction risk). Fire-and-forget. */
export function requestStoragePersistence(): void {
  const storage = navigator.storage;
  if (!storage || typeof storage.persist !== 'function') return; // not supported — non-fatal
  storage
    .persist()
    .then((granted) => console.log('[critterbox] storage persistence:', granted ? 'granted' : 'not granted'))
    .catch((err: unknown) => console.warn('[critterbox] storage persist failed:', err instanceof Error ? err.message : String(err)));
}

// --- debug surface (window.__critterbox.saveNow / hasSave / loadStateInfo) --------

/** Force an immediate save regardless of the activity gate — for e2e and manual testing. */
export async function saveNow(sim: Sim): Promise<void> {
  await saveSim(sim);
}

/** Describe the stored save without restoring it (has-save flag + seed/size/step when valid). */
export async function loadStateInfo(): Promise<{ hasSave: boolean; seed?: number; size?: number; step?: number; agentCount?: number }> {
  let blob: ArrayBuffer | null = null;
  try {
    blob = await getSave();
  } catch (err) {
    console.warn('[critterbox] loadStateInfo: IDB read failed:', err instanceof Error ? err.message : String(err));
    return { hasSave: false };
  }
  if (!blob) return { hasSave: false };
  try {
    const raw = await decompress(blob);
    const snap = deserializeWorld(raw);
    if (!snap) return { hasSave: true }; // stored but not a valid current-version save
    return { hasSave: true, seed: snap.seed, size: snap.size, step: snap.step, agentCount: snap.agents.length };
  } catch (err) {
    console.warn('[critterbox] loadStateInfo: decode failed:', err instanceof Error ? err.message : String(err));
    return { hasSave: true };
  }
}

export { deleteSave };
