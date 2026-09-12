/**
 * Shared animal framework (Phase 4) — plain functions over the Agent schema, no class hierarchy
 * (Sandfall's entities/animal.ts pattern). Every animal species module registers an AnimalSpecies
 * table; this module provides the generic energy budget, behaviour state machine, breeding gates and
 * trait inheritance that all species share. Behaviour is hand-written here, parameterized by the
 * species table + per-agent traits — no brains (PLAN "Traits & inheritance").
 *
 * Energy budget (Bibites master constraint), one 0–100-scale store per agent:
 *   - metabolism drain per tick = baseMetabolism × metabolism trait × temperature hook (Phase 7; 1.0 now)
 *   - movement cost per meter moved (moveCostPerMeter)
 *   - eating gives a digestion gain (eaten biomass × digestionEfficiency, via the plant graze API)
 *   - breeding spends BREED_COST_FRACTION of EACH parent's energy; the offspring starts with half of
 *     the total spend — i.e. the spend split between both parents, halved into one child (the rest is
 *     lost to reproduction)
 * Death: starvation (energy ≤ 0) or old age (age > lifespan trait). Removal goes through the
 * onAnimalDeath hook registry — Phase 5 attaches corpses; it is a no-op until then.
 *
 * Behaviour state machine (Agent.state): idle/wander → seekFood → eat → mate. Decisions are sampled
 * every DECISION_EVERY ticks, staggered by agent id ((stepCount + id) % DECISION_EVERY === 0), so the
 * work spreads across ticks; between decisions an animal just walks toward its stored target
 * (data.tx/tz). ALL randomness goes through agentRand/agentGaussian(id, stepSeed) — deterministic and
 * independent of processing order.
 *
 * Part B hooks: a species may override `decide` (insects pollinate instead of grazing), supply a
 * `feedOnTarget` action (nectar visits), or list `preySpecies` — arriving at an animal target kills it
 * via Sim.killAgent and digests its energy. attemptMate/pickWanderTarget/canAttemptBreed are exported
 * so custom decides reuse the exact same breeding/wander logic as the generic one.
 */

import { agentGaussian, agentRand } from '../../rng';
import type { Agent, Sex, Species } from '../../types';
import { ANIMAL_STATE_EAT, ANIMAL_STATE_IDLE, ANIMAL_STATE_MATE, ANIMAL_STATE_SEEK_FOOD, ANIMAL_STATE_WANDER } from '../../types';
import { getSpecies } from '../../registry';
import { clampEnergy, metabolismDrain } from '../../energy';
import type { Sim } from '../../sim';
import { grazePlant } from '../../sim';

// --- framework tunables -------------------------------------------------------------------

/** Energy scale ceiling — animals live on a 0..100 store (× the size trait's capacity multiplier). */
export const ANIMAL_ENERGY_MAX = 100;
/** Fraction of max energy a seeded/newborn animal starts with. */
export const INITIAL_ANIMAL_ENERGY_FRACTION = 0.6;
/** Fraction of each parent's energy spent on breeding (the offspring gets half of the total spend). */
export const BREED_COST_FRACTION = 0.3;
/** Ticks between behaviour decisions, staggered by agent id ((stepCount + id) % DECISION_EVERY === 0). */
export const DECISION_EVERY = 5;

// --- trait model ------------------------------------------------------------------------------

/** A heritable numeric trait: bounds for clamping + mutation σ (Gaussian sd applied at birth). */
export interface TraitDef {
  min: number;
  max: number;
  sigma: number;
}

/** Animal species parameters — a plain table row, self-registered by the species module. */
export interface AnimalSpecies extends Species {
  kind: 'animal';
  /** Heritable traits; key order is fixed (it indexes the per-trait rng salts). */
  traits: Record<string, TraitDef>;
  /** Resting drain per tick at metabolism trait = 1 (× temperature hook in Phase 7). */
  baseMetabolism: number;
  /** Energy cost per meter moved. */
  moveCostPerMeter: number;
  /** Move speed in m/tick at speed trait = 1. */
  baseSpeed: number;
  /** Radius (m) of the food-sense disc queried on decision ticks. */
  senseRadius: number;
  /** Distance (m) at which the animal starts eating its target plant. */
  eatRange: number;
  /** Biomass removed per bite from a plant. */
  eatAmount: number;
  /** Fraction of eaten biomass converted to energy. */
  digestionEfficiency: number;
  /** Hunger gate (fraction of capacity): below this the animal seeks food instead of breeding/wandering. */
  hungerThreshold: number;
  /** Age in ticks at which the animal matures (age > maturityAge can breed). */
  maturityAge: number;
  /** Breeding energy gate as a fraction of each parent's capacity. */
  breedEnergyFraction: number;
  /** Base breeding cooldown in ticks, divided by the fertility trait (fitter → more frequent). */
  breedCooldownBase: number;
  /** Mating range (m) — opposite-sex partners must be within this distance. */
  matingRange: number;
  /** Wander target radius (m). */
  wanderRadius: number;
  /** Hard population cap per species — breeding blocked at/above it. */
  popCap: number;
  /** Plant species ids this animal eats. */
  foodSpecies: readonly string[];
  /** Animal species ids this animal preys on (Phase 4 Part B: mice eat insects); prey are killed when fed upon. */
  preySpecies?: readonly string[];
  /** Body box dimensions in meters at size trait = 1 (rendering). */
  bodySize: [number, number, number];
  /** Optional species-specific decision override (insects pollinate instead of grazing). When set, replaces the generic decide(). */
  decide?: (sim: Sim, a: Agent, sp: AnimalSpecies) => void;
  /** Optional species-specific feeding action when arriving at the target plant. Returns energy gained
   *  (0 = nothing eaten → the animal re-decides on its next cycle). Default path grazes via grazePlant. */
  feedOnTarget?: (sim: Sim, a: Agent, sp: AnimalSpecies, target: Agent) => number;
}

/** Energy capacity of an agent: the 0–100 scale × its size trait. */
export function animalEnergyMax(a: Agent): number {
  return ANIMAL_ENERGY_MAX * (a.traits?.size ?? 1);
}

/** Temperature hook — Phase 7 swaps in the weather curve; returns 1.0 for now. */
function temperatureMod(): number {
  return 1;
}

// --- death hooks -------------------------------------------------------------------------------

type AnimalDeathHook = (agent: Agent) => void;
const deathHooks = new Set<AnimalDeathHook>();

/** Register a hook called when an animal dies (Phase 5 attaches corpse creation). Returns an unsubscribe. */
export function registerAnimalDeathHook(hook: AnimalDeathHook): () => void {
  deathHooks.add(hook);
  return () => {
    deathHooks.delete(hook);
  };
}

/** Fire the registered death hooks for a dying animal (starvation, old age, or predation via Sim.killAgent). */
export function notifyAnimalDeath(a: Agent): void {
  for (const h of deathHooks) h(a);
}

// --- traits & birth ------------------------------------------------------------------------------

/** Salt base distinguishing per-trait rng draws from sex/other draws. */
const TRAIT_SALT_BASE = 0x5eed;
const SEX_SALT = 0xa11ce;

/** Deterministic 50/50 sex for a newborn (agentRand by id + step seed). */
export function pickSex(id: number, stepSeed: number): Sex {
  return agentRand(id, stepSeed, SEX_SALT) < 0.5 ? 'f' : 'm';
}

/** Initial traits for a seeded animal: uniform in [min,max] per trait (no parents to average). */
export function initialTraits(sp: AnimalSpecies, id: number): Record<string, number> {
  const out: Record<string, number> = {};
  let i = 0;
  for (const key of Object.keys(sp.traits)) {
    const def = sp.traits[key];
    out[key] = def.min + agentRand(id, 0, TRAIT_SALT_BASE + i) * (def.max - def.min);
    i++;
  }
  return out;
}

/** Offspring traits: average of both parents + Gaussian(σ), clamped to [min,max] per trait. */
export function inheritTraits(sp: AnimalSpecies, pa: Agent, pb: Agent, id: number, stepSeed: number): Record<string, number> {
  const out: Record<string, number> = {};
  let i = 0;
  for (const key of Object.keys(sp.traits)) {
    const def = sp.traits[key];
    const mid = ((pa.traits?.[key] ?? (def.min + def.max) / 2) + (pb.traits?.[key] ?? (def.min + def.max) / 2)) / 2;
    const v = mid + agentGaussian(id, stepSeed, TRAIT_SALT_BASE + i) * def.sigma;
    out[key] = Math.min(def.max, Math.max(def.min, v));
    i++;
  }
  return out;
}

/** Per-parent breeding cooldown: base divided by the fertility trait. */
export function breedCooldown(sp: AnimalSpecies, a: Agent): number {
  return Math.round(sp.breedCooldownBase / (a.traits?.fertility ?? 1));
}

function inCooldown(sim: Sim, a: Agent, sp: AnimalSpecies): boolean {
  const last = a.data?.lastBreedStep;
  if (last === undefined) return false; // never bred — no cooldown running
  return sim.stepCount - last < breedCooldown(sp, a);
}

// --- breeding -------------------------------------------------------------------------------------

/**
 * Try to breed two animals of the same species. All gates must pass on BOTH parents: opposite sex,
 * mature (age > maturityAge), energy ≥ breedEnergyFraction × capacity, cooldown elapsed, within
 * matingRange, and the species below its popCap. On success each parent spends BREED_COST_FRACTION of
 * its energy; an offspring spawns at their midpoint with half of the total spend as starting energy,
 * inherited traits (mean + mutation) and a 50/50 sex. Returns true when it bred.
 */
export function tryBreed(sim: Sim, a: Agent, b: Agent, sp: AnimalSpecies): boolean {
  if (a.id === b.id || a.species !== b.species) return false;
  if (!a.sex || !b.sex || a.sex === b.sex) return false; // opposite sex required
  if (a.age <= sp.maturityAge || b.age <= sp.maturityAge) return false;
  if (a.energy < sp.breedEnergyFraction * animalEnergyMax(a)) return false;
  if (b.energy < sp.breedEnergyFraction * animalEnergyMax(b)) return false;
  if (inCooldown(sim, a, sp) || inCooldown(sim, b, sp)) return false;
  const dx = a.pos.x - b.pos.x;
  const dz = a.pos.z - b.pos.z;
  if (dx * dx + dz * dz > sp.matingRange * sp.matingRange) return false;
  if ((sim.popCounts.get(sp.id) ?? 0) >= sp.popCap) return false;

  const spendA = a.energy * BREED_COST_FRACTION;
  const spendB = b.energy * BREED_COST_FRACTION;
  a.energy -= spendA;
  b.energy -= spendB;

  const baby = sim.addAgent(sp.id, (a.pos.x + b.pos.x) / 2, (a.pos.z + b.pos.z) / 2);
  baby.sex = pickSex(baby.id, sim.stepCount);
  baby.traits = inheritTraits(sp, a, b, baby.id, sim.stepCount);
  baby.energy = (spendA + spendB) / 2; // the spend split between both parents, halved into one child
  baby.state = ANIMAL_STATE_IDLE;

  if (!a.data) a.data = {};
  if (!b.data) b.data = {};
  a.data.lastBreedStep = sim.stepCount;
  b.data.lastBreedStep = sim.stepCount;
  return true;
}

// --- per-tick update -------------------------------------------------------------------------------

/**
 * Advance one animal by a tick. Mutates the agent; returns true if it survives, false if it dies
 * (starvation or old age — removal is signalled through the death hooks). Call once per live animal
 * per step, after plants (see Sim.step).
 */
export function updateAnimal(sim: Sim, a: Agent): boolean {
  const sp = getSpecies(a.species);
  if (!sp || sp.kind !== 'animal') return true; // defensive — plants are handled by updatePlant
  const as_ = sp as AnimalSpecies;
  const t = a.traits ?? {};

  // --- age + vital death (checked first: last tick's drain/movement may have emptied the store) ---
  a.age += 1;
  if (a.energy <= 0) {
    notifyAnimalDeath(a);
    return false; // starvation
  }
  if (a.age > (t.lifespan ?? as_.maturityAge * 20)) {
    notifyAnimalDeath(a);
    return false; // old age
  }

  // --- metabolism drain (temperature hook → Phase 7) ---------------------------------------------
  a.energy -= metabolismDrain(as_.baseMetabolism * (t.metabolism ?? 1), temperatureMod());

  // --- behaviour decision, sampled every DECISION_EVERY ticks, staggered by id --------------------
  if ((sim.stepCount + a.id) % DECISION_EVERY === 0) decide(sim, a, as_);

  // --- act: walk toward the stored target; eat when close enough -----------------------------------
  const mem = a.data;
  if (mem && mem.tx !== undefined && mem.tz !== undefined) {
    const dx = mem.tx - a.pos.x;
    const dz = mem.tz - a.pos.z;
    const d2 = dx * dx + dz * dz;

    if (a.state === ANIMAL_STATE_SEEK_FOOD) {
      const targetId = mem.targetId;
      const plant = targetId !== undefined ? sim.agentById(targetId) : undefined;
      if (!plant || plant.energy <= 0) {
        // Target gone (died / overgrazed to zero) — drop it and re-decide on the next cycle.
        delete mem.tx;
        delete mem.tz;
        delete mem.targetId;
        a.state = ANIMAL_STATE_IDLE;
      } else if (d2 <= as_.eatRange * as_.eatRange) {
        // Arrived at the target: feed on it, then stop foraging until the next decision re-evaluates hunger.
        let gained = 0;
        const targetSp = getSpecies(plant.species);
        if (targetSp?.kind === 'animal') {
          // Predation (Phase 4 Part B): the prey is killed and its energy digested.
          sim.killAgent(plant);
          gained = plant.energy * as_.digestionEfficiency;
        } else if (as_.feedOnTarget) {
          gained = as_.feedOnTarget(sim, a, as_, plant); // e.g. insects take nectar + pollinate
        } else {
          const removed = grazePlant(plant, as_.eatAmount);
          if (removed > 0) gained = removed * as_.digestionEfficiency;
        }
        if (gained > 0) a.energy = clampEnergy(a.energy + gained, animalEnergyMax(a));
        delete mem.tx;
        delete mem.tz;
        delete mem.targetId;
        a.state = ANIMAL_STATE_EAT;
      } else {
        moveToward(sim, a, as_, t, dx, dz, d2);
      }
    } else if (d2 > 1e-9) {
      // wander / mate: just walk to the target point
      moveToward(sim, a, as_, t, dx, dz, d2);
    }
  }

  return true;
}

/** Pick the animal's next goal on its decision tick: food when hungry, otherwise breeding or wander. */
function decide(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (sp.decide) {
    sp.decide(sim, a, sp); // species-specific behaviour (insects pollinate instead of grazing)
    return;
  }
  if (!a.data) a.data = {};
  const d = a.data;

  // 1) Hungry → seek the nearest edible plant or prey animal within sense radius.
  if (a.energy / animalEnergyMax(a) < sp.hungerThreshold) {
    let best: Agent | null = null;
    let bestD2 = Infinity;
    for (const id of sim.grid.query(a.pos.x, a.pos.z, sp.senseRadius)) {
      const p = sim.agentById(id);
      if (!p || p.id === a.id || p.energy <= 0) continue; // self is never food
      const ps = getSpecies(p.species);
      if (!ps) continue;
      let edible: boolean;
      if (ps.kind === 'plant') edible = sp.foodSpecies.includes(p.species);
      else edible = sp.preySpecies?.includes(p.species) ?? false; // prey animal (mice eat insects)
      if (!edible) continue;
      const dx = p.pos.x - a.pos.x;
      const dz = p.pos.z - a.pos.z;
      const dist2 = dx * dx + dz * dz;
      if (dist2 < bestD2) {
        bestD2 = dist2;
        best = p;
      }
    }
    if (best) {
      d.tx = best.pos.x;
      d.tz = best.pos.z;
      d.targetId = best.id;
      a.state = ANIMAL_STATE_SEEK_FOOD;
      return;
    }
  }

  // 2) Not hungry → try to breed with an opposite-sex partner in range.
  if (canAttemptBreed(sim, a, sp) && attemptMate(sim, a, sp)) {
    a.state = ANIMAL_STATE_MATE;
    return;
  }

  // 3) Otherwise wander to a fresh random point.
  pickWanderTarget(sim, a, sp);
}

/** Search for an opposite-sex partner within matingRange and try to breed with the first eligible one. */
export function attemptMate(sim: Sim, a: Agent, sp: AnimalSpecies): boolean {
  for (const id of sim.grid.query(a.pos.x, a.pos.z, sp.matingRange)) {
    const p = sim.agentById(id);
    if (!p || p.id === a.id || p.species !== a.species) continue;
    if (p.sex === a.sex) continue; // opposite sex required
    const dx = p.pos.x - a.pos.x;
    const dz = p.pos.z - a.pos.z;
    if (dx * dx + dz * dz > sp.matingRange * sp.matingRange) continue;
    if (tryBreed(sim, a, p, sp)) return true;
  }
  return false;
}

/** Pick a fresh random wander point within wanderRadius (clamped to the world) and set state WANDER. */
export function pickWanderTarget(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (!a.data) a.data = {};
  const d = a.data;
  const angle = agentRand(a.id, sim.stepCount, 0x7a11) * Math.PI * 2;
  const dist = (0.3 + 0.7 * agentRand(a.id, sim.stepCount, 0x7a12)) * sp.wanderRadius;
  const half = sim.world.size / 2 - 1;
  d.tx = clampN(a.pos.x + Math.cos(angle) * dist, -half, half);
  d.tz = clampN(a.pos.z + Math.sin(angle) * dist, -half, half);
  delete d.targetId;
  a.state = ANIMAL_STATE_WANDER;
}

/** Cheap pre-gates before spending a grid query on partner search. */
export function canAttemptBreed(sim: Sim, a: Agent, sp: AnimalSpecies): boolean {
  if (a.age <= sp.maturityAge) return false;
  if (a.energy < sp.breedEnergyFraction * animalEnergyMax(a)) return false;
  if (inCooldown(sim, a, sp)) return false;
  if ((sim.popCounts.get(sp.id) ?? 0) >= sp.popCap) return false;
  return true;
}

/** Walk toward (tx,tz) at the species speed × speed trait, paying movement cost per meter. */
function moveToward(sim: Sim, a: Agent, sp: AnimalSpecies, t: Record<string, number>, dx: number, dz: number, d2: number): void {
  const dist = Math.sqrt(d2);
  const stepLen = Math.min(sp.baseSpeed * (t.speed ?? 1), dist);
  a.pos.x += (dx / dist) * stepLen;
  a.pos.z += (dz / dist) * stepLen;

  // Keep the animal on the terrain and inside the world.
  const half = sim.world.size / 2 - 1;
  if (a.pos.x < -half) a.pos.x = -half;
  else if (a.pos.x > half) a.pos.x = half;
  if (a.pos.z < -half) a.pos.z = -half;
  else if (a.pos.z > half) a.pos.z = half;
  a.pos.y = sim.world.heightAt(a.pos.x, a.pos.z);

  a.energy -= sp.moveCostPerMeter * stepLen; // movement cost per meter moved
}

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
