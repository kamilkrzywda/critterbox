/**
 * Shared aquatic helpers (Phase 6): everything carp and pike have in common for living IN the river
 * volume instead of on the terrain surface. The base.ts framework is reused as-is — this module only
 * supplies the two species hooks (`validTarget` / `settlePosition`) plus seeding init, so fish keep the
 * exact same energy budget, behaviour state machine, breeding gates and trait inheritance as land animals:
 *   - inRiverVolume: a cell is "in" the river volume when its terrain sits at least AQUATIC_MIN_DEPTH
 *     below the fixed water level (the swim space between floor and surface).
 *   - aquaticSettle (the settlePosition hook, called once per tick after the act phase): when a move
 *     dried out the agent is stepped back to its last valid position (data.ax/az — always in the volume by
 *     induction) and the failed target is remembered (badTargetId/badUntilStep) so decide skips it for a
 *     cooldown instead of re-chasing an unreachable meal. When the move was fine, the agent is seated at
 *     its personal depth fraction of the water column: y = h + depthFrac × (waterLevel − h), strictly
 *     between terrain and surface. Returns true when it clamped — base.ts then drops the pending target so
 *     the animal re-decides instead of grinding against the shore.
 *   - initAquaticAgent: seeding setup — the last-valid-position record + immediate seating at depth (the
 *     per-agent depth fraction is lazily initialized on first use, deterministic in the agent id alone).
 */

import { agentRand } from '../../rng';
import type { Agent } from '../../types';
import type { Sim } from '../../sim';
import { getSpecies } from '../../registry';
import type { AnimalSpecies } from './base';

/** Meters below the water surface a cell must be for an animal to swim in it (movement validity). */
export const AQUATIC_MIN_DEPTH = 0.5;
/** Meters below the water surface required to SEED a fish (deep river cells — never spawn in shallows). */
export const AQUATIC_SEED_DEPTH = 1.0;
/** Skip window for a clamped-against ANIMAL target: it moves, so re-evaluate after this many ticks. */
export const AQUATIC_BAD_TARGET_COOLDOWN_ANIMAL = 300;
/** Skip window for a clamped-against PLANT target: plants never move — an unreachable plant stays
 *  unreachable from the same position, so skip it for a very long time instead of re-chasing it in a loop. */
export const AQUATIC_BAD_TARGET_COOLDOWN_PLANT = 10000;

/** Salt for the per-agent depth-fraction draw (distinct from trait/sex salts in base.ts). */
const DEPTH_SALT = 0x6f1a;

/** True when (x,z) is inside the river volume: terrain at least AQUATIC_MIN_DEPTH below the water level. */
export function inRiverVolume(sim: Sim, x: number, z: number): boolean {
  return sim.world.heightAt(x, z) < sim.world.waterLevel - AQUATIC_MIN_DEPTH;
}

/** WANDER-target validation for aquatic species (base.ts validTarget hook): stay inside the river volume. */
export function aquaticValidTarget(sim: Sim, x: number, z: number): boolean {
  return inRiverVolume(sim, x, z);
}

/** Seeding init: last-valid-position record + seat at depth immediately (the depth fraction is lazily
 *  initialized on first use — see depthFraction — so breeding-born fish get the same per-id value). */
export function initAquaticAgent(sim: Sim, a: Agent): void {
  if (!a.data) a.data = {};
  const d = a.data;
  d.ax = a.pos.x;
  d.az = a.pos.z;
  seatDepth(sim, a);
}

/** The agent's personal depth fraction of the water column (0.25–0.75 — mid column with per-agent variety),
 *  lazily initialized on first use: deterministic in the agent id alone, so a breeding-born fish gets exactly
 *  the same value as if it had been seeded. */
function depthFraction(a: Agent): number {
  if (!a.data) a.data = {}; // defensive — every caller seats through seatDepth which ensures data too
  const d = a.data;
  if (d.depthFrac === undefined) d.depthFrac = 0.25 + 0.5 * agentRand(a.id, 0, DEPTH_SALT);
  return d.depthFrac;
}

/**
 * Post-act position fixup for aquatic species (base.ts settlePosition hook). Returns true when the agent's
 * move dried out and it was clamped back — base.ts drops the pending target so the animal re-decides.
 */
export function aquaticSettle(sim: Sim, a: Agent): boolean {
  if (!a.data) a.data = {};
  const d = a.data;

  if (inRiverVolume(sim, a.pos.x, a.pos.z)) {
    // Fine — record the valid position and seat at depth.
    d.ax = a.pos.x;
    d.az = a.pos.z;
    seatDepth(sim, a);
    return false;
  }

  // The move dried out — step back to the last valid position (always in the volume by induction).
  let lx = d.ax;
  let lz = d.az;
  if (lx === undefined || lz === undefined) {
    // No valid position recorded yet: a newborn stranded outside the volume (born at the midpoint of two
    // parents across a bend). Deterministic local search — fixed ring pattern, no rng needed.
    const found = findNearbyVolume(sim, a.pos.x, a.pos.z);
    if (!found) return false; // nowhere deep nearby — stay put and let nature take its course
    lx = found.x;
    lz = found.z;
  }
  a.pos.x = lx;
  a.pos.z = lz;

  // Remember the failed target so decide skips it for a cooldown window instead of re-chasing it. Plants never
  // move (an unreachable plant stays unreachable from here — long skip); animals do (shorter re-evaluation).
  const tid = d.targetId;
  if (tid !== undefined) {
    const target = sim.agentById(tid);
    const tSp = target ? getSpecies(target.species) : undefined;
    d.badTargetId = tid;
    d.badUntilStep = sim.stepCount + (tSp?.kind === 'plant' ? AQUATIC_BAD_TARGET_COOLDOWN_PLANT : AQUATIC_BAD_TARGET_COOLDOWN_ANIMAL);
  }

  seatDepth(sim, a);
  return true; // clamped — base.ts drops the pending target so the animal re-decides
}

/** Seat the agent at its depth fraction of the water column: y strictly between terrain and surface. */
function seatDepth(sim: Sim, a: Agent): void {
  if (!a.data) a.data = {};
  const w = sim.world;
  const h = w.heightAt(a.pos.x, a.pos.z);
  a.pos.y = h + (w.waterLevel - h) * depthFraction(a);
}

/** Deterministic escape search: nearest in-volume point on fixed rings of radius 1–6 m (8 directions). */
function findNearbyVolume(sim: Sim, x: number, z: number): { x: number; z: number } | null {
  for (let r = 1; r <= 6; r++) {
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const nx = x + Math.cos(ang) * r;
      const nz = z + Math.sin(ang) * r;
      if (inRiverVolume(sim, nx, nz)) return { x: nx, z: nz };
    }
  }
  return null;
}

/** True while `id` is inside the bad-target cooldown window (see aquaticSettle). */
export function isBadTarget(a: Agent, sim: Sim, id: number): boolean {
  const d = a.data;
  if (!d || d.badTargetId !== id) return false;
  const until = d.badUntilStep;
  if (until === undefined) return false;
  return sim.stepCount < until;
}

/** Per-world cache of connected swim-volume components (see riverComponentAt). */
const volumeComponents = new WeakMap<object, Int16Array>();

/**
 * Connected-component id of the swim volume at (x,z), or -1 when the point is out of the volume. The map is
 * built once per world (the terrain is static): a deterministic row-major flood fill over cells with
 * h < waterLevel − AQUATIC_MIN_DEPTH — exactly the cells inRiverVolume accepts. Two points in DIFFERENT
 * components can never be swum between (a land barrier separates them), so straight-line distance to prey in
 * another component is meaningless: a pike steering at it would loop against the volume clamp and starve
 * while reachable carp swim on the other side of the barrier (Phase 6 stability forensics, seed 1337).
 */
export function riverComponentAt(sim: Sim, x: number, z: number): number {
  const w = sim.world;
  const n = w.width;
  const d = w.depth;
  let comp = volumeComponents.get(w);
  if (!comp) {
    comp = new Int16Array(n * d).fill(-1);
    let next = 0;
    for (let cz = 0; cz < d; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cz * n + cx;
        if (comp[i] !== -1 || w.heights[i] >= w.waterLevel - AQUATIC_MIN_DEPTH) continue;
        comp[i] = next;
        const stack: number[] = [i];
        while (stack.length > 0) {
          const c = stack.pop() as number;
          const px = c % n;
          if (px > 0 && comp[c - 1] === -1 && w.heights[c - 1] < w.waterLevel - AQUATIC_MIN_DEPTH) { comp[c - 1] = next; stack.push(c - 1); }
          if (px < n - 1 && comp[c + 1] === -1 && w.heights[c + 1] < w.waterLevel - AQUATIC_MIN_DEPTH) { comp[c + 1] = next; stack.push(c + 1); }
          if (c >= n && comp[c - n] === -1 && w.heights[c - n] < w.waterLevel - AQUATIC_MIN_DEPTH) { comp[c - n] = next; stack.push(c - n); }
          if (c < (d - 1) * n && comp[c + n] === -1 && w.heights[c + n] < w.waterLevel - AQUATIC_MIN_DEPTH) { comp[c + n] = next; stack.push(c + n); }
        }
        next++;
      }
    }
    volumeComponents.set(w, comp);
  }
  const cx = Math.floor(x + w.width / 2);
  const cz = Math.floor(z + w.depth / 2);
  if (cx < 0 || cx >= n || cz < 0 || cz >= d) return -1;
  return comp[cz * n + cx];
}

/** Angular offsets (radians) tried when steering toward food: the direct direction first, then widening
 *  arcs on both sides — a river channel may bend away from the straight line to the food. */
const STEER_ANGLE_OFFSETS = [0, -0.6, 0.6, -1.2, 1.2, -1.8, 1.8];

/**
 * `foodReachable` hook for river fish (v0.12): an IN-WATER plant is only reachable when it sits in the SAME
 * connected swim-volume component as the fish — behind a land barrier it is unreachable no matter how close
 * the straight line looks, and steering at it parks the fish against the volume clamp until starvation while
 * the meal sits on the other side of the bank (20k-step roach forensics: whole families starved at dead-end
 * channel ends). Shore/shallow plants (component -1) are left to the existing eatRange + volume-clamp handling —
 * a carp grazing waterline reed from adjacent deep water is legitimate Phase 6 behaviour.
 */
export function fishFoodReachable(sim: Sim, self: Agent, plant: Agent): boolean {
  const pc = riverComponentAt(sim, plant.pos.x, plant.pos.z);
  if (pc === -1) return true; // shore/shallow — reachable from adjacent water within eatRange
  return pc === riverComponentAt(sim, self.pos.x, self.pos.z);
}

/**
 * A volume-validated steer point toward (fx,fz) for directional foraging: distance min(dist/2, wanderRadius),
 * the direct direction first and then angular offsets until a candidate sits inside the river volume
 * (validTarget). Returns null when no candidate is in the volume — the caller falls back to a validated
 * wander instead of setting an unreachable target. Without this, a straight-line steer across a meander is
 * clamped back into the volume every tick and the fish starves in place (Phase 6 stability forensics).
 */
export function aquaticSteerToward(sim: Sim, a: Agent, sp: AnimalSpecies, fx: number, fz: number): { x: number; z: number } | null {
  const dx = fx - a.pos.x;
  const dz = fz - a.pos.z;
  const dist = Math.hypot(dx, dz) || 1;
  const baseAng = Math.atan2(dz, dx);
  const step = Math.min(dist * 0.5, sp.wanderRadius);
  for (const off of STEER_ANGLE_OFFSETS) {
    const ang = baseAng + off;
    const px = a.pos.x + Math.cos(ang) * step;
    const pz = a.pos.z + Math.sin(ang) * step;
    if (!sp.validTarget || sp.validTarget(sim, px, pz)) return { x: px, z: pz };
  }
  return null;
}
