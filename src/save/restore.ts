/**
 * Restore-on-load (Phase 8): read the stored save blob from IndexedDB, decompress it in the worker and
 * parse it BEFORE the first render. Any failure — no blob, corrupt gzip, bad magic or a version mismatch —
 * simply leaves null so the caller generates a fresh world instead (never crashes). The returned snapshot
 * is applied by the host via Sim.loadState: terrain is re-derived from seed+size and the environment needs
 * no saved state (it's a pure function of seed+step), so {seed, size, step, agents, corpses} fully restores
 * the sim.
 */

import type { WorldSnapshot } from './serialize';
import { deserializeWorld } from './serialize';
import { getSave } from './storage';
import { decompress } from './save';

/** What a successful restore put into the world — seed/size let the host rebuild the terrain. */
export interface RestoreResult extends WorldSnapshot {}

/**
 * Try to read + decode the stored save. Returns the parsed snapshot on success, or null when there is no
 * usable save (the caller keeps the fresh world). Never throws.
 */
export async function restoreWorld(): Promise<RestoreResult | null> {
  let blob: ArrayBuffer | null = null;
  try {
    blob = await getSave();
  } catch (err) {
    console.warn('[critterbox] restore: IDB read failed — starting fresh:', err instanceof Error ? err.message : String(err));
    return null;
  }
  if (!blob) return null; // no save yet — first visit

  let raw: ArrayBuffer;
  try {
    raw = await decompress(blob);
  } catch (err) {
    console.warn('[critterbox] restore: corrupt save blob — starting fresh:', err instanceof Error ? err.message : String(err));
    return null; // undecompressable → ignore, start fresh
  }

  const snap = deserializeWorld(raw);
  if (!snap) {
    console.warn('[critterbox] restore: bad magic/version/layout — starting fresh');
    return null; // version mismatch or corrupt layout → ignore save, never crash
  }
  return snap;
}
