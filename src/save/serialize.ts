/**
 * Save payload serialization (Phase 8) — pure binary layout, no DOM/browser APIs, so it runs in the
 * headless sim-check suite as well. The world itself is NOT stored: terrain + biomes + water level are a
 * deterministic function of (seed, size), and the day/night + weather environment is a pure function of
 * (seed, step) — so the payload only carries what can't be re-derived: seed, size, the tick counter, and
 * every live agent (+ decaying corpses). Agents are plain objects (see sim/types.ts — that shape IS the
 * save/load contract) and round-trip verbatim through the JSON tail. Restoring {seed, size, step, agents}
 * fully restores the entire sim state: the next tick continues the deterministic per-agent hash-randomness
 * sequence exactly where it left off (checked in scripts/checks/save.mjs).
 *
 *   offset  size  field
 *   ------  ----  ----------------------------------------------------------
 *        0     4  magic "CRBX" (u8 × 4)
 *        4     4  format version (u32 LE) — mismatch on load → ignore save, start fresh
 *        8     4  world seed (u32 LE)
 *       12     4  world size in meters (u32 LE)
 *       16     4  sim step counter (u32 LE) — keeps the deterministic randomness sequence continuous
 *       20   N    JSON tail (UTF-8): { agents: [...], corpses: [...] } — everything after the header
 */

import type { Agent, Vec3 } from '../sim/types';
import type { Corpse } from '../sim/corpses';

/** Magic bytes identifying a Critterbox save: "CRBX". */
export const SAVE_MAGIC = new Uint8Array([0x43, 0x52, 0x42, 0x58]);
/** Current payload format version. A load with any other version is ignored (fresh world). */
export const SAVE_VERSION = 1;

/** Header size in bytes: magic(4) + version(4) + seed(4) + size(4) + step(4). */
const HEADER_SIZE = 20;
/** Sanity cap on agent count for a loadable save (far above any real world — ~13k at default size). */
const MAX_AGENTS = 1_000_000;

/** Everything a save captures about the sim. The terrain is re-derived from seed+size on restore. */
export interface WorldSnapshot {
  seed: number;
  size: number;
  /** Sim step counter to restore (keeps the deterministic randomness sequence continuous). */
  step: number;
  agents: Agent[];
  corpses: Corpse[];
}

/** Encode a world snapshot into the binary payload layout above. Throws on bad input (caller bug). */
export function serializeWorld(snap: WorldSnapshot): ArrayBuffer {
  if (!Number.isInteger(snap.seed) || snap.seed < 0 || snap.seed > 0xffffffff) throw new Error('serializeWorld: bad seed');
  if (!Number.isInteger(snap.size) || snap.size <= 0) throw new Error('serializeWorld: bad size');
  if (!Number.isInteger(snap.step) || snap.step < 0 || snap.step > 0xffffffff) throw new Error('serializeWorld: bad step');
  const jsonBytes = new TextEncoder().encode(JSON.stringify({ agents: snap.agents, corpses: snap.corpses }));
  const buf = new ArrayBuffer(HEADER_SIZE + jsonBytes.length);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  u8.set(SAVE_MAGIC, 0);
  dv.setUint32(4, SAVE_VERSION, true);
  dv.setUint32(8, snap.seed >>> 0, true);
  dv.setUint32(12, snap.size, true);
  dv.setUint32(16, snap.step, true);
  u8.set(jsonBytes, HEADER_SIZE);
  return buf;
}

/** Light structural check on one parsed agent — a hand-edited/corrupt blob must not crash the sim layer. */
function validAgent(a: unknown): boolean {
  if (typeof a !== 'object' || a === null) return false;
  const x = a as Agent;
  if (typeof x.id !== 'number' || !Number.isInteger(x.id) || x.id < 1) return false;
  if (typeof x.species !== 'string') return false;
  const p: Vec3 | undefined = x.pos;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false;
  if (typeof x.energy !== 'number' || !Number.isFinite(x.energy)) return false;
  if (typeof x.age !== 'number' || typeof x.state !== 'string') return false;
  return true;
}

/** Light structural check on one parsed corpse. */
function validCorpse(c: unknown): boolean {
  if (typeof c !== 'object' || c === null) return false;
  const x = c as Corpse;
  if (typeof x.id !== 'number' || typeof x.originSpecies !== 'string') return false;
  const p: Vec3 | undefined = x.pos;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false;
  if (typeof x.mass !== 'number' || !Number.isFinite(x.mass) || typeof x.age !== 'number') return false;
  return true;
}

/**
 * Parse a payload produced by {@link serializeWorld}. Returns null — never throws — when the buffer is not
 * a valid current-version save (bad magic, version mismatch, truncated header/JSON, unparseable tail or an
 * agent/corpse failing the structural check), so callers simply start from a fresh world.
 */
export function deserializeWorld(buf: ArrayBuffer): WorldSnapshot | null {
  const u8 = new Uint8Array(buf);
  if (u8.length < HEADER_SIZE) return null;
  for (let i = 0; i < SAVE_MAGIC.length; i++) if (u8[i] !== SAVE_MAGIC[i]) return null;

  const dv = new DataView(buf);
  if (dv.getUint32(4, true) !== SAVE_VERSION) return null; // version mismatch → ignore save
  const seed = dv.getUint32(8, true);
  const size = dv.getUint32(12, true);
  const step = dv.getUint32(16, true);
  if (size < 1 || size > 0xffff) return null; // sanity: worlds are 100–800 m in practice

  let tail: { agents?: unknown; corpses?: unknown };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(u8.subarray(HEADER_SIZE)));
    if (typeof parsed !== 'object' || parsed === null) return null;
    tail = parsed as { agents?: unknown; corpses?: unknown };
  } catch {
    return null; // corrupt JSON tail → treat as no save
  }

  const agentsRaw = Array.isArray(tail.agents) ? tail.agents : [];
  if (agentsRaw.length > MAX_AGENTS) return null;
  for (const a of agentsRaw) if (!validAgent(a)) return null;
  const corpsesRaw = Array.isArray(tail.corpses) ? tail.corpses : [];
  for (const c of corpsesRaw) if (!validCorpse(c)) return null;

  return { seed, size, step, agents: agentsRaw as Agent[], corpses: corpsesRaw as Corpse[] };
}
