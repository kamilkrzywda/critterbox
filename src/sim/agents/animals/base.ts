/**
 * Shared animal framework (Phase 4) — plain functions over the Agent schema, no class hierarchy
 * (Sandfall's entities/animal.ts pattern). Every animal species module registers an AnimalSpecies
 * table; this module provides the generic energy budget, behaviour state machine, breeding gates and
 * trait inheritance that all species share. Behaviour is hand-written here, parameterized by the
 * species table + per-agent traits — no brains (PLAN "Traits & inheritance").
 *
 * Energy budget (Bibites master constraint), one 0–100-scale store per agent:
 *   - metabolism drain per tick = baseMetabolism × metabolism trait × environment.metabolismMult (Phase 7:
 *     cold → up to METAB_MULT_MAX, see sim/environment.ts)
 *   - movement cost per meter moved (moveCostPerMeter)
 *   - eating gives a digestion gain (eaten biomass × digestionEfficiency, via the plant graze API)
 *   - breeding spends BREED_COST_FRACTION of EACH parent's energy; the offspring starts with half of
 *     the total spend — i.e. the spend split between both parents, halved into one child (the rest is
 *     lost to reproduction)
 * Death: starvation (energy ≤ 0) or old age (age > lifespan trait). Removal goes through the
 * onAnimalDeath hook registry — Phase 5 attaches corpses via it (see sim/corpses.ts): every death
 * (starvation, old age OR predation) spawns a decaying corpse at the victim's position.
 *
 * Behaviour state machine (Agent.state): idle/wander → seekFood → eat → mate. Decisions are sampled
 * every DECISION_EVERY ticks, staggered by agent id ((stepCount + id) % DECISION_EVERY === 0), so the
 * work spreads across ticks; between decisions an animal just walks toward its stored target
 * (data.tx/tz). The movement direction is tracked as data.heading (radians, atan2(dz,dx) of the last
 * actual displacement — kept while idle) so the renderer can turn each instance where it's going. ALL
 * randomness goes through agentRand/agentGaussian(id, stepSeed) — deterministic and independent of
 * processing order.
 *
 * Part B hooks: a species may override `decide` (insects pollinate instead of grazing), supply a
 * `feedOnTarget` action (nectar visits), or list `preySpecies` — arriving at an animal target kills it
 * via Sim.killAgent and digests its energy. attemptMate/pickWanderTarget/canAttemptBreed/seekNearestFood
 * are exported so custom decides reuse the exact same breeding/wander/forage logic as the generic one.
 *
 * Phase 5 (predators & scavengers):
 *   - Predation is HUNGER-GATED: an animal only seeks food/prey below its hungerThreshold fraction of
 *     capacity — full predators wander/breed like herbivores (Sandfall's snake lesson: gating prevents
 *     the classic predator-prey overshoot/oscillation).
 *   - SATURATING INTAKE (Holling-type): each kill raises data.sat by SAT_PER_KILL; a kill's yield is
 *     victimEnergy × digestionEfficiency × (1 − sat), and sat decays SAT_DECAY_PER_TICK per tick. A few
 *     kills within seconds pay sharply diminishing returns, so one predator can't wipe a local prey
 *     patch in minutes even while still below its hunger threshold.
 *   - Scavenging: data.corpseTarget marks a SEEK_FOOD target that is a CORPSE POINT (tx/tz, no agent id);
 *     on arrival the animal feeds via Sim.scavengeAt (see sim/corpses.ts) — cheaper than hunting (no pursuit).
 *   - `validTarget` hook: species may validate WANDER targets against the biome/height field (frogs and
 *     storks stay in marsh/water-edge zones); prey pursuit is exempt so they can still catch edge-dwelling
 *     prey. `activityLevel(sim)` hook (Phase 7): returns the current activity multiplier in [0,1] from the
 *     day/night light — owls are nocturnal (high at night), fox/stork diurnal (reduced at night). Hunting
 *     requires activity > 0; below-full activity means the animal only forages on a FRACTION of its decision
 *     ticks (deterministic per id+tick via agentRand) — so "reduced activity" is a reduced hunting RATE, not
 *     just an on/off switch.
 */

import { agentGaussian, agentRand } from '../../rng';
import type { Agent, PlantSpecies, Sex, Species } from '../../types';
import { ANIMAL_STATE_EAT, ANIMAL_STATE_IDLE, ANIMAL_STATE_MATE, ANIMAL_STATE_SEEK_FOOD, ANIMAL_STATE_WANDER, STAGE_FRUITING } from '../../types';
import { getSpecies } from '../../registry';
import { clampEnergy, metabolismDrain } from '../../energy';
import { BREED_TEMP_MIN } from '../../environment';
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
/** Salt for the Phase 7 activity probability gate (decide/scavengerDecide): below-full activityLevel →
 *  foraging is attempted only when agentRand(id, step, salt) < activity. Exported so scavengerDecide reuses
 *  the exact same draw as the generic decide. */
export const ACTIVITY_SALT = 0x7a2c;
// --- Saturating intake (Phase 5, Holling-type) -----------------------------------------------
/** A kill that fills this fraction of the predator's capacity adds a full point of satiation — smaller
 *  meals add proportionally less (gained / (capacity × SAT_FULL_MEAL_FRACTION)). This keeps the effect
 *  strong for predators on comparable-sized prey (a fox eating mice) while leaving generalists that live
 *  on small meals (crows/frogs on insects) effectively unsaturated. */
export const SAT_FULL_MEAL_FRACTION = 0.5;
/** Per-tick satiation decay — the window over which successive kills pay less (~170 ticks to reset). Tuned
 *  so that a predator's coast between hunting bouts (≥ ~250 ticks at the hunger gate) fully resets
 *  satiation — each bout starts fresh, no chronic deficit — while kills WITHIN a bout (~40–60 ticks apart)
 *  still pay strongly diminishing returns: predators hunt in paced bouts instead of stripping their prey
 *  patch continuously (Phase 5 stability tuning). */
export const SAT_DECAY_PER_TICK = 0.006;

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
  /** When set, WANDER targets are drawn around the animal's ROOST (its position on first decision ≈
   *  placement/birth point) instead of its current position. Unanchored random-walk diffusion carries a
   *  predator 100–200 m from its prey patch over ~10k ticks, past its foraging range — Phase 5 stability
   *  runs showed foxes/owls starving in "prey deserts" between clusters. Roost-anchored predators patrol a
   *  fixed home range and only travel when hungry (directional foraging). */
  roostAnchored?: boolean;
  /** With roostAnchored, normally an animal that ends up >2×wanderRadius from its roost (e.g. chased prey to
   *  another patch) adopts the new position as home. Set this to keep the ORIGINAL roost forever: the animal
   *  may travel while hungry but always wanders back home when full. For pike in a finite set of discrete
   *  prey clusters, relocation lets the whole population converge on and strip the last surviving cluster —
   *  sequential depletion → extinction (Phase 6 stability forensics). Territorial locking keeps predation
   *  distributed across all clusters instead. */
  noRelocate?: boolean;
  /** Hard population cap per species — breeding blocked at/above it. */
  popCap: number;
  /** Plant species ids this animal eats. */
  foodSpecies: readonly string[];
  /** Fallback plant species — considered ONLY when nothing from `foodSpecies` is visible within the search
   *  radius ("only eaten if nothing else is seen"): floating flowers a carp ignores while algae grows in front
   *  of it, shore reed a carp abandons once in-water plants exist. seekNearestFood returns the nearest primary
   *  when any is in range and only falls through to this list otherwise. */
  fallbackFoodSpecies?: readonly string[];
  /** Animal species ids this animal preys on (Phase 4 Part B: mice eat insects); prey are killed when fed upon. */
  preySpecies?: readonly string[];
  /** Optional reachability filter for ANIMAL prey candidates in seekNearestFood — a bank insect is unreachable
   *  from inside the river volume, a roach behind a land barrier sits in another swim-volume component. Prey
   *  failing the check are skipped, not chased: chasing them parks the predator against its zone/volume clamp
   *  until starvation (the Phase 6 pike-frog lesson). `self` is passed so filters can compare positions
   *  (component checks); implementations that don't need it simply omit the parameter. Unset = all listed prey
   *  reachable. */
  preyReachable?: (sim: Sim, self: Agent, prey: Agent) => boolean;
  /** Optional reachability filter for PLANT candidates in seekNearestFood — fish use it to skip plants sitting
   *  in another connected swim-volume component (behind a land barrier): chasing them parks the fish against
   *  its volume clamp until starvation while the unreachable meal sits on the other side of the bank (v0.12
   *  roach forensics — whole families starved at dead-end channel ends steering at algae across a meander).
   *  Plants failing the check are skipped, not chased. Unset = all listed plants reachable (land animals). */
  foodReachable?: (sim: Sim, self: Agent, plant: Agent) => boolean;
  /** Optional WANDER-target validation against the biome/height field (frogs/storks stay in marsh/water-edge).
   *  Prey pursuit is exempt — a frog may still chase an insect that strays upland. */
  validTarget?: (sim: Sim, x: number, z: number) => boolean;
  /** Activity hook (Phase 7): current activity multiplier in [0,1] from the day/night light — e.g. owls are
   *  nocturnal (`1 − light`), fox/stork diurnal (reduced at night). Hunting requires > 0; below-full values
   *  reduce the hunting RATE (probability gate on decision ticks, see decide/scavengerDecide). Unset = always 1. */
  activityLevel?: (sim: Sim) => number;
  /** Optional post-act position fixup (Phase 6 aquatic): called once per tick after the act phase, before
   *  the survival return. Fish use it to clamp back into the river volume when a move dried out and to sit
   *  at their depth fraction of the water column. Returns true when the agent's position was clamped — the
   *  pending target is then dropped so the animal re-decides instead of grinding against the shore. */
  settlePosition?: (sim: Sim, a: Agent) => boolean;
  /** World-space body box dimensions in METERS at the MIDPOINT of the size trait (width, height, depth) —
   *  the explicit per-species size mapping for rendering. The renderer maps the full size-trait range onto
   *  a ±25% band around these values via visualScale() (see below), so an individual's rendered body stays
   *  within [0.75, 1.25] × these dimensions no matter how far the trait drifts over generations. The size
   *  trait ALSO drives energy capacity (animalEnergyMax) on its raw scale — that is unchanged. */
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

// --- visual size mapping ---------------------------------------------------------------------------
// The size trait is a raw heritable number whose bounds are species-specific (mouse 0.7–1.3, deer 3.5–5.5).
// Using it directly as a geometry scale made deer ~10 m tall while trees were ~6 m — the scene read wrong.
// Instead each species declares bodySize in meters at its size-trait MIDPOINT (see AnimalSpecies.bodySize)
// and the renderer maps the full trait range onto this fixed ±25% band around it: a big individual is 1.25×
// the midpoint dimensions, a small one 0.75× — visible variety without breaking world-space sanity.

/** Visual scale at the smallest size trait (maps to 0.75 × bodySize). */
export const VISUAL_SCALE_MIN = 0.75;
/** Visual scale at the largest size trait (maps to 1.25 × bodySize). */
export const VISUAL_SCALE_MAX = 1.25;

/** World-space visual scale for an animal's size trait: linear map of [trait.min, trait.max] → [0.75, 1.25]. */
export function visualScale(sp: AnimalSpecies, sizeTrait: number): number {
  const t = sp.traits.size;
  if (!t) return 1;
  const f = (sizeTrait - t.min) / (t.max - t.min);
  const clamped = f < 0 ? 0 : f > 1 ? 1 : f; // defensive — traits are always within bounds
  return VISUAL_SCALE_MIN + (VISUAL_SCALE_MAX - VISUAL_SCALE_MIN) * clamped;
}

// --- death hooks -------------------------------------------------------------------------------

/** Death hook — receives the SIM the animal belongs to (Phase 5 routes corpses onto it) + the dying agent. */
type AnimalDeathHook = (sim: Sim, agent: Agent) => void;
const deathHooks = new Set<AnimalDeathHook>();

/** Register a hook called when an animal dies (starvation, old age, or predation). Returns an unsubscribe. */
export function registerAnimalDeathHook(hook: AnimalDeathHook): () => void {
  deathHooks.add(hook);
  return () => {
    deathHooks.delete(hook);
  };
}

/** Fire the registered death hooks for a dying animal (starvation, old age, or predation via Sim.killAgent). */
export function notifyAnimalDeath(sim: Sim, a: Agent): void {
  for (const h of deathHooks) h(sim, a);
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
 * matingRange, and the species below its popCap — plus the Phase 7 cold-snap gate: breeding is suppressed
 * while the environment temperature is below BREED_TEMP_MIN (°C). On success each parent spends
 * BREED_COST_FRACTION of its energy; an offspring spawns at their midpoint with half of the total spend as
 * starting energy, inherited traits (mean + mutation) and a 50/50 sex. Returns true when it bred.
 */
export function tryBreed(sim: Sim, a: Agent, b: Agent, sp: AnimalSpecies): boolean {
  if (a.id === b.id || a.species !== b.species) return false;
  if (!a.sex || !b.sex || a.sex === b.sex) return false; // opposite sex required
  if (a.age <= sp.maturityAge || b.age <= sp.maturityAge) return false;
  if (sim.environment.temperature < BREED_TEMP_MIN) return false; // cold-snap gate (Phase 7): no breeding below the threshold
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
  const sp = sim.speciesOf(a.id) ?? getSpecies(a.species); // dense cache first (hot path), registry fallback
  if (!sp || sp.kind !== 'animal') return true; // defensive — plants are handled by updatePlant
  const as_ = sp as AnimalSpecies;
  const t = a.traits ?? {};

  // --- age + vital death (checked first: last tick's drain/movement may have emptied the store) ---
  a.age += 1;
  if (a.energy <= 0) {
    notifyAnimalDeath(sim, a);
    return false; // starvation
  }
  if (a.age > (t.lifespan ?? as_.maturityAge * 20)) {
    notifyAnimalDeath(sim, a);
    return false; // old age
  }

  // --- metabolism drain (Phase 7: cold raises the multiplier — see sim/environment.ts) --------------
  a.energy -= metabolismDrain(as_.baseMetabolism * (t.metabolism ?? 1), sim.environment.metabolismMult);

  // --- satiation decay (Phase 5): the "short window" of saturating intake shrinks every tick -------
  const mem0 = a.data;
  if (mem0 && mem0.sat !== undefined && mem0.sat > 0) {
    const s = mem0.sat - SAT_DECAY_PER_TICK;
    mem0.sat = s <= 0 ? 0 : s;
  }

  // --- behaviour decision, sampled every DECISION_EVERY ticks, staggered by id --------------------
  if ((sim.stepCount + a.id) % DECISION_EVERY === 0) decide(sim, a, as_);

  // --- act: walk toward the stored target; eat when close enough -----------------------------------
  const mem = a.data;
  if (mem && mem.tx !== undefined && mem.tz !== undefined) {
    const dx = mem.tx - a.pos.x;
    const dz = mem.tz - a.pos.z;
    const d2 = dx * dx + dz * dz;

    if (a.state === ANIMAL_STATE_SEEK_FOOD) {
      if (mem.corpseTarget !== undefined) {
        // Scavenging target (Phase 5): a corpse POINT, not an agent — feed on arrival.
        if (d2 <= as_.eatRange * as_.eatRange) {
          const gained = sim.scavengeAt(mem.tx, mem.tz, as_.eatRange, as_.eatAmount, as_.digestionEfficiency);
          if (gained > 0) a.energy = clampEnergy(a.energy + gained, animalEnergyMax(a));
          delete mem.tx;
          delete mem.tz;
          delete mem.corpseTarget;
          a.state = ANIMAL_STATE_EAT; // corpse gone or empty — re-decide on the next cycle
        } else {
          moveToward(sim, a, as_, t, dx, dz, d2);
        }
      } else {
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
          // Predation (Phase 4 Part B): the prey is killed and its energy digested — with Phase 5's
          // saturating intake: each kill raises satiation (scaled by how much of the predator's capacity
          // the meal fills), so quick successive kills pay diminishing returns.
          sim.killAgent(plant);
          const sat = mem.sat ?? 0;
          gained = plant.energy * as_.digestionEfficiency * (1 - sat);
          mem.sat = Math.min(1, sat + gained / (animalEnergyMax(a) * SAT_FULL_MEAL_FRACTION));
        } else if (as_.feedOnTarget) {
          gained = as_.feedOnTarget(sim, a, as_, plant); // e.g. insects take nectar + pollinate
        } else {
          const removed = grazePlant(plant, as_.eatAmount);
          if (removed > 0) {
            gained = removed * as_.digestionEfficiency;
            disperseSeed(sim, plant); // every consumer is a disperser (Sandfall dung-seed pattern)
          }
        }
        if (gained > 0) a.energy = clampEnergy(a.energy + gained, animalEnergyMax(a));
        delete mem.tx;
        delete mem.tz;
        delete mem.targetId;
        a.state = ANIMAL_STATE_EAT;
      } else {
        moveToward(sim, a, as_, t, dx, dz, d2);
      }
      } // end non-corpse SEEK_FOOD branch
    } else if (d2 > 1e-9) {
      // wander / mate: just walk to the target point
      moveToward(sim, a, as_, t, dx, dz, d2);
    }
  }

  // --- aquatic fixup (Phase 6): species with a settlePosition hook re-seat themselves after acting — fish
  // clamp back into the river volume when a move dried out and sit at their depth fraction of the column.
  // A clamped move drops the pending target so the animal re-decides instead of grinding against the shore.
  if (as_.settlePosition) {
    const clamped = as_.settlePosition(sim, a);
    if (clamped && mem && mem.tx !== undefined) {
      delete mem.tx;
      delete mem.tz;
      delete mem.targetId;
      delete mem.corpseTarget;
      a.state = ANIMAL_STATE_IDLE;
    }
  }

  return true;
}

/** Pick the animal's next goal on its decision tick: food when hungry (and active), otherwise breeding or wander. */
function decide(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (sp.decide) {
    sp.decide(sim, a, sp); // species-specific behaviour (insects pollinate instead of grazing)
    return;
  }
  if (!a.data) a.data = {};
  const d = a.data;

  // 1) Hungry AND active → seek the nearest edible plant or prey animal within sense radius.
  //    The activityLevel hook (Phase 7: light → activity — owls nocturnal, fox/stork diurnal) gates hunting;
  //    below-full activity reduces the hunting RATE instead of switching it off: foraging is attempted only on
  //    a FRACTION of decision ticks (deterministic per id+tick via agentRand). On skipped ticks a hungry
  //    animal RESTS in place (no patrol burn) — see the gate below.
  const active = sp.activityLevel ? sp.activityLevel(sim) : 1;
  if (active > 0 && a.energy / animalEnergyMax(a) < sp.hungerThreshold) {
    if (!(active >= 1 || agentRand(a.id, sim.stepCount, ACTIVITY_SALT) < active)) {
      // Phase 7: hungry but below full activity — REST in place instead of patrolling. A predator that
      // can't hunt right now waits for prey to come within sense radius on its next active tick; a random
      // patrol would burn movement energy without hunting (Phase 7 stability tuning — the wasted-wander
      // drain is what tipped fox/stork energy budgets negative under compressed hunting windows). Any
      // pending target from an earlier decision keeps being pursued by the act phase.
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
    // blindly. Predators that drift out of their prey patch would otherwise starve: random-walk diffusion
    // carries them past the cluster and they never find their way back (Phase 5 stability tuning). The
    // target is a step partway toward the food, not a full chase — once in range, the next decide switches
    // to proper pursuit.
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

  // 2) Not hungry → try to breed with an opposite-sex partner in range.
  if (canAttemptBreed(sim, a, sp) && attemptMate(sim, a, sp)) {
    a.state = ANIMAL_STATE_MATE;
    return;
  }

  // 3) Otherwise wander to a fresh random point.
  pickWanderTarget(sim, a, sp);
}

/** Minimum energy fraction (of maxEnergy) at which a non-fruiting plant is edible: below this, one graze
 *  bite drops the plant under its regrowth floor and mows it back — grazers skip unestablished shoots.
 *  FRUITING plants are always edible regardless of energy. Stage/energy-based (not age-based) so headless
 *  checks that create a fresh FRUITING plant and expect immediate grazing still work, while freshly
 *  dispersed seedlings in the live sim stay protected until they're robust enough to survive a bite
 *  (Phase 5 stability tuning — replaces an earlier age-based grace period). */
export const PLANT_MIN_EDIBLE_FRACTION = 0.6;

/** How far beyond senseRadius a hungry animal scans when nothing is in kill range (directional foraging,
 *  see decide / scavengerDecide). Only used as a fallback — the common case stays a cheap local query. ×6
 *  covers the gaps between prey clusters on the default world (fox: ~108 m, owl: ~180 m) so a stranded
 *  predator can always find its way back to food (Phase 5 stability tuning). Exported because the
 *  scavenger decide (corpses.ts) reuses the exact same fallback. */
export const FORAGE_SEARCH_MULT = 6;

/**
 * Nearest edible agent within `radius` (default: the species' senseRadius), via the spatial grid — null when
 * nothing is in range. Exported so custom decides (scavengers, insects) reuse it. Plants are two-tiered: a
 * nearest PRIMARY (foodSpecies) wins whenever one is visible; only with NO primary in range does the search
 * fall through to fallbackFoodSpecies ("only eaten if nothing else is seen"). Animal prey must be listed AND
 * pass the optional preyReachable filter. One grid pass tracks both tiers at once.
 */
export function seekNearestFood(sim: Sim, a: Agent, sp: AnimalSpecies, radius?: number): Agent | null {
  let bestPrimary: Agent | null = null;
  let bestPrimaryD2 = Infinity;
  let bestFallback: Agent | null = null;
  let bestFallbackD2 = Infinity;
  for (const id of sim.grid.query(a.pos.x, a.pos.z, radius ?? sp.senseRadius)) {
    const p = sim.agentById(id);
    if (!p || p.id === a.id || p.energy <= 0) continue; // self is never food
    const ps = sim.speciesOf(p.id); // dense cache — per-candidate lookups on the hottest animal path (Phase 7 perf: seasonal foraging made this loop ~2× busier)
    if (!ps) continue;
    let tier: 'primary' | 'fallback' | null = null;
    if (ps.kind === 'plant') {
      const psp = ps as PlantSpecies;
      // Unestablished shoots are inedible — see PLANT_MIN_EDIBLE_FRACTION.
      if (p.state !== STAGE_FRUITING && p.energy < PLANT_MIN_EDIBLE_FRACTION * psp.maxEnergy) continue;
      // Reachability: a plant in another swim-volume component is behind a land barrier for fish (see foodReachable).
      if (sp.foodReachable && !sp.foodReachable(sim, a, p)) continue;
      if (sp.foodSpecies.includes(p.species)) tier = 'primary';
      else if (sp.fallbackFoodSpecies?.includes(p.species)) tier = 'fallback'; // last resort — only wins when no primary is visible
    } else {
      // Prey animal — listed AND reachable (e.g. a bank insect is unreachable from inside the river volume; see preyReachable).
      if (sp.preySpecies?.includes(p.species) && (!sp.preyReachable || sp.preyReachable(sim, a, p))) tier = 'primary';
    }
    if (!tier) continue;
    const dx = p.pos.x - a.pos.x;
    const dz = p.pos.z - a.pos.z;
    const dist2 = dx * dx + dz * dz;
    if (tier === 'primary') {
      if (dist2 < bestPrimaryD2) { bestPrimaryD2 = dist2; bestPrimary = p; }
    } else if (dist2 < bestFallbackD2) {
      bestFallbackD2 = dist2;
      bestFallback = p;
    }
  }
  return bestPrimary ?? bestFallback; // a visible primary always beats the fallback tier
}

/**
 * Seed dispersal via consumers (Sandfall "every consumer is also a disperser" — dung seeds / frugivory):
 * after a successful graze, the plant drops a seedling of its own species within SEED_DROP_RANGE on dry
 * land, with probability PLANT_SEED_PROB. Deterministic per (plant id, tick) via agentRand — independent
 * of processing order. This is what keeps plant populations alive past old-age death in long runs
 * (Phase 5 stability gate): birth rate is bounded by the capped herbivore base, so it self-limits.
 */
const PLANT_SEED_PROB = 0.6; // per successful graze event (tuned in Phase 5 stability runs)
/** Meters — short-range canopy/dung drop around the parent plant (Sandfall monkey pattern). */
export const SEED_DROP_RANGE = 3;
/** Same-species exclusion radius for new seedlings: no seed lands within this of an existing conspecific.
 *  This is the plant carrying capacity — it bounds populations by area (~1 per 8 m², close to the seeded
 *  densities) so self-seeding can never stack agents unboundedly. */
export const SEED_EXCLUDE_RADIUS = 3;

/** True when a seedling of `speciesId` may stand at (x,z) — no conspecific within the species' exclusion radius. */
export function canDropSeed(sim: Sim, x: number, z: number, speciesId: string, excludeId?: number): boolean {
  const sp = getSpecies(speciesId);
  const r = sp?.kind === 'plant' ? (sp as PlantSpecies).seedExcludeRadius ?? SEED_EXCLUDE_RADIUS : SEED_EXCLUDE_RADIUS;
  const ex2 = r * r;
  // The grid query is a cell-based superset — the exact distance test happens here.
  for (const id of sim.grid.query(x, z, r)) {
    if (id === excludeId) continue; // the parent plant itself never blocks its own seed
    const p = sim.agentById(id);
    if (!p || p.species !== speciesId) continue;
    const dx = p.pos.x - x;
    const dz = p.pos.z - z;
    if (dx * dx + dz * dz <= ex2) return false;
  }
  return true;
}

/**
 * Draw a drop point within SEED_DROP_RANGE of the parent plant (deterministic per plant+tick via agentRand),
 * check water + the same-species exclusion, and spawn the seedling when allowed. Returns true when it did.
 */
export function dropSeedlingNearby(sim: Sim, plant: Agent): boolean {
  const ang = agentRand(plant.id, sim.stepCount, 0x5ee1) * Math.PI * 2;
  const dist = (0.4 + 0.6 * agentRand(plant.id, sim.stepCount, 0x5ee2)) * SEED_DROP_RANGE;
  const nx = plant.pos.x + Math.cos(ang) * dist;
  const nz = plant.pos.z + Math.sin(ang) * dist;
  const aqua = (getSpecies(plant.species) as PlantSpecies | undefined)?.aquatic;
  if (aqua) {
    // Aquatic spread: the seedling must land in water whose depth is within the species' window — algae mats
    // creep across any open surface, pondweed roots only where there is a real bottom. No biome check: the
    // whole connected water body is one habitat (the "flowing on water and spreading around" rule).
    const depth = sim.world.waterLevel - sim.world.heightAt(nx, nz);
    if (depth < aqua.minDepth || (aqua.maxDepth !== undefined && depth > aqua.maxDepth)) return false;
  } else {
    if (sim.world.heightAt(nx, nz) < sim.world.waterLevel) return false; // no seeds underwater
    // Biome fidelity: a seedling only establishes in the parent's biome — habitat suitability keeps species
    // on their home ground. Without it, iterative ≤3 m hops compound over long runs and marsh cranberries
    // crept ~40 m into dry meadow where nothing grazes them, growing unbounded (Phase 5 stability tuning).
    if (sim.world.biomeAt(nx, nz) !== sim.world.biomeAt(plant.pos.x, plant.pos.z)) return false;
  }
  if (!canDropSeed(sim, nx, nz, plant.species, plant.id)) return false; // carrying capacity (parent excluded)
  sim.addAgent(plant.species, nx, nz); // seedling stage at the initial energy fraction
  return true;
}

function disperseSeed(sim: Sim, plant: Agent): void {
  if (agentRand(plant.id, sim.stepCount, 0x5eed) >= PLANT_SEED_PROB) return;
  dropSeedlingNearby(sim, plant);
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

/**
 * Pick a fresh random wander point within wanderRadius (clamped to the world) and set state WANDER. When
 * the species has a validTarget hook (frogs/storks), up to 8 candidates are drawn until one passes — if
 * none do, the animal stays put (its current position is always its own valid zone).
 */
export function pickWanderTarget(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (!a.data) a.data = {};
  const d = a.data;
  delete d.targetId;
  delete d.corpseTarget; // a fresh wander drops any pending scavenging target
  const half = sim.world.size / 2 - 1;
  // Roost-anchored species (foxes/owls) draw their wander point around the roost — lazily captured on the
  // first decision, which for seeded animals is t≈0 and for offspring is the birth spot near its parents.
  let ax = a.pos.x;
  let az = a.pos.z;
  if (sp.roostAnchored) {
    if (d.roostX === undefined) d.roostX = a.pos.x;
    if (d.roostZ === undefined) d.roostZ = a.pos.z;
    // Relocation: an animal that has moved far from its roost (e.g. chased prey to another patch and fed
    // there) adopts its current position as the new home — otherwise it would waste energy walking back to
    // an empty patch on every full-belly wander. noRelocate species keep their original roost forever
    // (territorial lock — see the flag's doc).
    if (!sp.noRelocate) {
      const dxr = a.pos.x - d.roostX;
      const dzr = a.pos.z - d.roostZ;
      if (dxr * dxr + dzr * dzr > 4 * sp.wanderRadius * sp.wanderRadius) {
        d.roostX = a.pos.x;
        d.roostZ = a.pos.z;
      }
    }
    ax = d.roostX;
    az = d.roostZ;
  }
  let tx: number | undefined;
  let tz: number | undefined;
  for (let i = 0; i < 8 && tx === undefined; i++) {
    // Salted per attempt so the retries are independent draws, all pure in (id, step).
    const angle = agentRand(a.id, sim.stepCount, 0x7a11 + i) * Math.PI * 2;
    const dist = (0.3 + 0.7 * agentRand(a.id, sim.stepCount, 0x7b11 + i)) * sp.wanderRadius;
    const cx = clampN(ax + Math.cos(angle) * dist, -half, half);
    const cz = clampN(az + Math.sin(angle) * dist, -half, half);
    if (sp.validTarget ? sp.validTarget(sim, cx, cz) : true) {
      tx = cx;
      tz = cz;
    }
  }
  d.tx = tx ?? a.pos.x; // no valid candidate → stay put
  d.tz = tz ?? a.pos.z;
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

/** Walk toward (tx,tz) at the species speed × speed trait, paying movement cost per meter. Whenever the
 *  animal actually moves, its heading is updated from the ACTUAL (post-clamp) displacement: data.heading =
 *  atan2(dz, dx) in radians on the x/z plane. While idle the last heading is kept — animals never snap to
 *  zero. render/animals.ts turns each instance by this value (+Z is the geometry's front axis). */
function moveToward(sim: Sim, a: Agent, sp: AnimalSpecies, t: Record<string, number>, dx: number, dz: number, d2: number): void {
  const dist = Math.sqrt(d2);
  const stepLen = Math.min(sp.baseSpeed * (t.speed ?? 1), dist);
  const px = a.pos.x;
  const pz = a.pos.z;
  a.pos.x += (dx / dist) * stepLen;
  a.pos.z += (dz / dist) * stepLen;

  // Keep the animal on the terrain and inside the world.
  const half = sim.world.size / 2 - 1;
  if (a.pos.x < -half) a.pos.x = -half;
  else if (a.pos.x > half) a.pos.x = half;
  if (a.pos.z < -half) a.pos.z = -half;
  else if (a.pos.z > half) a.pos.z = half;
  a.pos.y = sim.world.heightAt(a.pos.x, a.pos.z);

  // Heading: the actual displacement direction — only when it really moved (clamping can zero out a step).
  const mx = a.pos.x - px;
  const mz = a.pos.z - pz;
  if (mx * mx + mz * mz > 0) {
    if (!a.data) a.data = {};
    a.data.heading = Math.atan2(mz, mx);
  }

  a.energy -= sp.moveCostPerMeter * stepLen; // movement cost per meter moved
}

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
