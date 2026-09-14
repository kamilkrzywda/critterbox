/**
 * Duck (v0.12). The semi-aquatic waterfowl: swims the shallow water AND walks the marsh band around it —
 * its foraging zone is the UNION of the river volume and a DUCK_SHORE_BAND strip either side of the water
 * line, so it can graze shore grass one tick and dip into an algae mat the next without ever leaving valid
 * ground. Diet: shore grass/clover + in-water algae (primary), floating flowers as fallback ("only eaten if
 * nothing else is seen"). No predators (v0.12 stability forensics): a slow-breeding cap-14 species can't
 * sustain fox predation — the founding cluster was stripped faster than clutches replaced it, so ducks are a
 * predator-free niche player. Behaviour comes from ./base.ts parameterized by this table + per-agent traits,
 * with the two zone hooks below. Self-registers into the species registry at load.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.9 – 1.3    (σ 0.10)  move-speed multiplier — a steady walker/swimmer, slower than every predator that takes it
 *   size        1.5 – 2.4    (σ 0.20)  body scale (rendering) + energy-capacity multiplier (~150–240 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.5 – 1.0    (σ 0.12)  breeding-cooldown divisor — a slow breeder like the fox
 *   lifespan    10000–20000  (σ 1000)  old-age death age in ticks (~6–11 min at 1×)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { AQUATIC_BAD_TARGET_COOLDOWN_ANIMAL, AQUATIC_BAD_TARGET_COOLDOWN_PLANT, inRiverVolume } from './aquatic';
import { ANIMAL_STATE_SEEK_FOOD, type Agent } from '../../types';
import { agentRand } from '../../rng';
import type { Sim } from '../../sim';

/** Meters either side of the water line a duck may walk on land (the marsh band it forages). */
const DUCK_SHORE_BAND = 4;

// --- flight (v0.13) ---------------------------------------------------------------------------
/** Meters from a seekFood target at which a duck will consider taking wing — only FAR food is flown to;
 *  near meals are walked/swum (flying is expensive, see FLIGHT_COST_MULT in base.ts). Tuned to the duck's
 *  actual foraging scale: in the standard world its nearest edible rarely exceeds ~10 m (dense grass/clover/
 *  algae), so "far" = a meal at the outer edge of its range (~6 m) — a genuine short flight, not a hop. */
const DUCK_FLIGHT_MIN_DIST = 6;
/** Fraction of far-foraging ticks on which a duck actually flies (deterministic per id+tick via agentRand) —
 *  ducks mostly swim/walk and only occasionally make short flights to distant food. */
const DUCK_FLIGHT_PROB = 0.35;
/** Salt for the duck flight roll — distinguishes it from other per-agent draws at the same (id, step). */
const DUCK_FLIGHT_SALT = 0x7f1a;

/**
 * Flight gate for ducks (base.ts `flightGate` hook, v0.13): a duck takes wing ONLY while SEEKING FOOD with a
 * FAR target (> DUCK_FLIGHT_MIN_DIST m away) AND on a deterministic per-tick roll (< DUCK_FLIGHT_PROB). It
 * never flies while wandering/idle/eating/mating — mostly it swims/walks, with occasional short flights to
 * distant food. Pure in (sim, agent): same id+step → same outcome (agentRand), so the flight pattern is
 * reproducible and independent of processing order.
 */
export function duckFlightGate(sim: Sim, a: Agent): boolean {
  if (a.state !== ANIMAL_STATE_SEEK_FOOD) return false; // ducks never fly outside active foraging
  const d = a.data;
  if (!d || d.tx === undefined || d.tz === undefined) return false;
  const dx = d.tx - a.pos.x;
  const dz = d.tz - a.pos.z;
  if (Math.hypot(dx, dz) <= DUCK_FLIGHT_MIN_DIST) return false; // near food — walk/swim to it
  return agentRand(a.id, sim.stepCount, DUCK_FLIGHT_SALT) < DUCK_FLIGHT_PROB;
}

/** True when (x,z) is in the duck's zone: swimmable river volume OR the shore band around the water line. */
export function duckZone(sim: Sim, x: number, z: number): boolean {
  return inRiverVolume(sim, x, z) || Math.abs(sim.world.heightAt(x, z) - sim.world.waterLevel) <= DUCK_SHORE_BAND;
}

/** Seat height at (x,z): floating just under the surface in water, standing on the terrain on land. */
function seatY(sim: Sim, x: number, z: number): number {
  const w = sim.world;
  return inRiverVolume(sim, x, z) ? w.waterLevel - 0.1 : w.heightAt(x, z);
}

/** Deterministic escape search: nearest in-zone point on fixed rings of radius 1–6 m (8 directions). */
function findNearbyDuckZone(sim: Sim, x: number, z: number): { x: number; z: number } | null {
  for (let r = 1; r <= 6; r++) {
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const nx = x + Math.cos(ang) * r;
      const nz = z + Math.sin(ang) * r;
      if (duckZone(sim, nx, nz)) return { x: nx, z: nz };
    }
  }
  return null;
}

/**
 * Post-act position fixup for ducks (base.ts settlePosition hook): the zone is a union of water + shore
 * band, so a move only "dries out" when it strays beyond both — then step back to the last valid position
 * and remember the failed target (same cooldown pattern as aquaticSettle). Returns true when clamped.
 */
export function duckSettle(sim: Sim, a: Agent): boolean {
  // v0.13 flight: an airborne duck is over whatever ground it's flying to — skip zone enforcement AND the
  // position revert entirely so its flight path isn't snapped back to the last in-zone point. Normal seating
  // resumes automatically on the landing tick (flying=0 → the full settle below runs again).
  if (a.data?.flying) return false;

  if (!a.data) a.data = {};
  const d = a.data;

  if (duckZone(sim, a.pos.x, a.pos.z)) {
    // Fine — record the valid position and seat at surface/ground.
    d.ax = a.pos.x;
    d.az = a.pos.z;
    a.pos.y = seatY(sim, a.pos.x, a.pos.z);
    return false;
  }

  // Out of zone — step back to the last valid position (always in-zone by induction).
  let lx = d.ax;
  let lz = d.az;
  if (lx === undefined || lz === undefined) {
    // No valid position recorded yet: a newborn stranded outside the zone. Deterministic local search.
    const found = findNearbyDuckZone(sim, a.pos.x, a.pos.z);
    if (!found) return false; // nowhere in-zone nearby — stay put and let nature take its course
    lx = found.x;
    lz = found.z;
  }
  a.pos.x = lx;
  a.pos.z = lz;

  const tid = d.targetId;
  if (tid !== undefined) {
    const target = sim.agentById(tid);
    const tSp = target ? sim.speciesOf(target.id) : undefined;
    d.badTargetId = tid;
    d.badUntilStep = sim.stepCount + (tSp?.kind === 'plant' ? AQUATIC_BAD_TARGET_COOLDOWN_PLANT : AQUATIC_BAD_TARGET_COOLDOWN_ANIMAL);
  }

  a.pos.y = seatY(sim, lx, lz);
  return true; // clamped — base.ts drops the pending target so the duck re-decides
}

export const DUCK: AnimalSpecies = {
  id: 'duck',
  kind: 'animal',
  displayName: 'duck',
  traits: {
    speed: { min: 0.9, max: 1.3, sigma: 0.1 },
    size: { min: 1.5, max: 2.4, sigma: 0.2 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.5, max: 1.0, sigma: 0.12 },
    lifespan: { min: 10000, max: 20000, sigma: 1000 },
  },
  baseMetabolism: 0.035, // per tick at metabolism=1 — a medium bird between the hare and the stork
  moveCostPerMeter: 0.3,
  baseSpeed: 0.12, // m/tick at speed=1 (~3.6 m/s at 1×) — slower than fox (min 0.144): a duck can't outrun its predator
  senseRadius: 14,
  eatRange: 1.5,
  eatAmount: 12, // a bite of grass/clover/algae
  digestionEfficiency: 0.7,
  hungerThreshold: 0.8, // forage below 80% of capacity
  maturityAge: 1500, // ~50 s juvenile phase at 1×
  breedEnergyFraction: 0.65,
  breedCooldownBase: 3000, // ÷ fertility → 3000–6000 ticks between clutches (slow breeder)
  matingRange: 6,
  wanderRadius: 10, // patrol the local water/marsh patch
  popCap: 14, // a handful of pairs — fox predation + slow breeding keep it lean
  foodSpecies: ['grass', 'clover', 'algae'], // shore grazer + surface forager (v0.12)
  fallbackFoodSpecies: ['waterlily'], // the floating flower is the last resort, not the menu
  bodySize: [0.25, 0.3, 0.7], // world-space meters at mid size trait → rendered ~0.5 m long (a real mallard)
  canFly: true, // v0.13 — occasional short flights to far food; render adds altitude + wing flap from data.flying
  flightGate: duckFlightGate, // flies only while seeking food >6 m away, and only on a ~35% per-tick roll (see above)
  validTarget: duckZone, // water + shore band constraint (wander targets only — see module header)
  settlePosition: duckSettle, // clamp back into the zone + seat at surface/ground after every act (skipped while flying)
};

registerSpecies(DUCK);
