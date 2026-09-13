/**
 * Corpses & scavenging (Phase 5, PLAN "Corpses & scavenging"): when an animal dies — starvation, old age
 * OR predation — the onAnimalDeath hook (base.ts) spawns a corpse entity at its position:
 * { id, originSpecies, pos, mass (= victim's energy), age }. Corpses decay CORPSE_DECAY_PER_TICK of mass
 * per tick and are removed when ≤ 0. Fox & crow feed on them via the scavenging API below — cheaper than
 * hunting (no pursuit) — closing the nutrient loop (Bibites' scavenger→carnivore pathway).
 *
 * Corpses are NOT agents: they live in Sim.corpses, stay out of the spatial grid / population counts /
 * renderers, and are found by a linear scan (concurrent count is low tens — deaths are rare vs. the ~13k
 * agents) which keeps the hot path allocation-free. Death order within a tick follows agent processing
 * order, so the list is deterministic for a given seed.
 *
 * The death hook receives the SIM (hook signature: (sim, agent)) so each corpse lands on its own sim
 * instance — checks run many sims in one process. The hook is registered by initCorpseSystem() (called
 * from the Sim constructor, idempotent). base.ts must NOT import this module (cycle) — scavenging from
 * the behaviour state machine goes through Sim.scavengeAt instead.
 */

import type { Sim } from './sim';
import type { Agent, Vec3 } from './types';
import { agentRand } from './rng';
import { ANIMAL_STATE_MATE, ANIMAL_STATE_SEEK_FOOD, ANIMAL_STATE_WANDER } from './types';
import { ACTIVITY_SALT, FORAGE_SEARCH_MULT, animalEnergyMax, attemptMate, canAttemptBreed, pickWanderTarget, registerAnimalDeathHook, seekNearestFood } from './agents/animals/base';
import type { AnimalSpecies } from './agents/animals/base';

/** A decaying carcass left by a dead animal. `pos` is a COPY of the victim's position at death. */
export interface Corpse {
  id: number; // unique per process (not used for rng — corpses are not agents)
  originSpecies: string; // which species it was (for future scavenger diet rules / rendering)
  pos: Vec3;
  /** Remaining edible mass (= victim's energy at death, minus decay and scavenged bites). */
  mass: number;
  /** Ticks since death. */
  age: number;
}

/** Absolute mass lost per tick — a ~60-mass mouse carcass lasts ~600 ticks (~20 s at 1×). */
export const CORPSE_DECAY_PER_TICK = 0.1;

let nextCorpseId = 1;

/** Spawn a corpse (the death hook's job; exported so checks can create corpses directly). */
export function spawnCorpse(sim: Sim, originSpecies: string, x: number, z: number, mass: number): Corpse {
  const c: Corpse = { id: nextCorpseId++, originSpecies, pos: { x, y: sim.world.heightAt(x, z), z }, mass, age: 0 };
  sim.corpses.push(c);
  return c;
}

/**
 * Register the death→corpse hook ONCE (idempotent). Called from the Sim constructor — NOT at module load:
 * base.ts imports sim.ts (grazePlant) and sim.ts imports this module, so a top-level registration here would
 * run while base.ts is still mid-initialization under CJS (deathHooks in its TDZ). By construction time all
 * modules are fully loaded. The hook itself is stateless routing — one global hook serves every Sim instance.
 */
let corpseSystemInitialized = false;
export function initCorpseSystem(): void {
  if (corpseSystemInitialized) return;
  corpseSystemInitialized = true;
  // Every animal death — starvation/old age in updateAnimal or predation via Sim.killAgent — funnels here.
  registerAnimalDeathHook((sim, a) => {
    spawnCorpse(sim, a.species, a.pos.x, a.pos.z, Math.max(0, a.energy)); // starved animals are emaciated → ~0 mass
  });
}

/** Nearest corpse within `radius` of (x,z), or null. Linear scan — see the module header for why that's fine. */
export function findNearestCorpse(sim: Sim, x: number, z: number, radius: number): Corpse | null {
  let best: Corpse | null = null;
  let bestD2 = Infinity;
  const cs = sim.corpses;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c.mass <= 0) continue;
    const dx = c.pos.x - x;
    const dz = c.pos.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > radius * radius || d2 >= bestD2) continue;
    bestD2 = d2;
    best = c;
  }
  return best;
}

/**
 * Feed on the nearest corpse within `radius` of (x,z): takes up to `biteAmount` mass, converted at
 * `digestionEfficiency`. The corpse's mass is reduced and it is removed when empty. Returns energy gained
 * (0 when no corpse is in range or it is already empty).
 */
export function scavengeCorpse(sim: Sim, x: number, z: number, radius: number, biteAmount: number, efficiency: number): number {
  const c = findNearestCorpse(sim, x, z, radius);
  if (!c) return 0;
  const taken = Math.min(c.mass, biteAmount);
  c.mass -= taken;
  if (c.mass <= 1e-6) sim.corpses.splice(sim.corpses.indexOf(c), 1);
  return taken * efficiency;
}

/**
 * Scavenger decision tick (fox & crow): when hungry, a corpse in range beats live prey — scavenging is
 * cheaper than hunting (no pursuit). Otherwise fall back to the shared plant/prey search, then breeding,
 * then wander — exactly the generic decide() flow with corpses checked first.
 */
export function scavengerDecide(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (!a.data) a.data = {};
  const d = a.data;

  // 1) Hungry AND active → corpse first (no pursuit cost), then the nearest edible plant/prey. The Phase 7
  //    activity gate mirrors base.decide exactly: below-full activityLevel (fox is diurnal — reduced at night)
  //    reduces the foraging RATE via a deterministic per id+tick probability draw, not an on/off switch; on
  //    skipped ticks a hungry scavenger rests in place instead of patrolling (same energy-balance rationale).
  const active = sp.activityLevel ? sp.activityLevel(sim) : 1;
  if (active > 0 && a.energy / animalEnergyMax(a) < sp.hungerThreshold) {
    if (!(active >= 1 || agentRand(a.id, sim.stepCount, ACTIVITY_SALT) < active)) {
      return; // hungry but inactive — rest in place (see base.decide)
    }
    const c = findNearestCorpse(sim, a.pos.x, a.pos.z, sp.senseRadius);
    if (c) {
      d.tx = c.pos.x;
      d.tz = c.pos.z;
      delete d.targetId;
      d.corpseTarget = 1; // the act phase treats this SEEK_FOOD target as a corpse point
      a.state = ANIMAL_STATE_SEEK_FOOD;
      return;
    }
    const best = seekNearestFood(sim, a, sp);
    if (best) {
      d.tx = best.pos.x;
      d.tz = best.pos.z;
      d.targetId = best.id;
      delete d.corpseTarget;
      a.state = ANIMAL_STATE_SEEK_FOOD;
      return;
    }
    // Nothing in kill range — steer toward the nearest food BEYOND sense radius instead of wandering
    // blindly (the generic decide's directional-foraging pattern, Phase 5). Without it a scavenger whose
    // home range sits in a prey desert patrols an empty patch and starves: v0.6.0 survived on slow attrition
    // + breeding, but the Phase 6 aquatic layer (carp thinning waterline insects → early mouse dip) tipped
    // that balance into fox extinction — the fallback makes desert-patch starvation a transient, not a death spiral.
    const far = seekNearestFood(sim, a, sp, sp.senseRadius * FORAGE_SEARCH_MULT);
    if (far) {
      const dx = far.pos.x - a.pos.x;
      const dz = far.pos.z - a.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz) || 1;
      const step = Math.min(dist * 0.5, sp.wanderRadius); // one wander-step's worth toward the food
      d.tx = a.pos.x + (dx / dist) * step;
      d.tz = a.pos.z + (dz / dist) * step;
      delete d.targetId;
      delete d.corpseTarget;
      a.state = ANIMAL_STATE_WANDER;
      return;
    }
  }

  // 2) Not hungry → try to breed with an opposite-sex partner in range (shared logic).
  if (canAttemptBreed(sim, a, sp) && attemptMate(sim, a, sp)) {
    a.state = ANIMAL_STATE_MATE;
    return;
  }

  // 3) Otherwise wander to a fresh random point.
  pickWanderTarget(sim, a, sp);
}
