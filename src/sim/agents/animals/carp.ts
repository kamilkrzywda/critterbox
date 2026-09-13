/**
 * Carp (PLAN roster, Phase 6). The river omnivore: lives only in the river volume (aquatic.ts) and feeds
 * on SHORE PLANTS — reed preferred, any plant within reach of the water's edge via the shared grazePlant
 * API — plus opportunistic insects that happen to be at the waterline. Behaviour comes from ./base.ts
 * parameterized by this table + per-agent traits; the two aquatic hooks (validTarget / settlePosition) and
 * a shore-filtered decide keep it in the water and pointed at reachable food:
 *   - wander targets must sit inside the river volume (aquaticValidTarget);
 *   - after every act, aquaticSettle clamps back into the volume when a move dried out and seats the fish
 *     at its depth fraction of the water column;
 *   - decide only targets plants whose cell is within CARP_SHORE_REACH above the water line (the bank) —
 *     a plant higher upland is unreachable from the swim line, so chasing it would just park the carp at
 *     the shore. Insects are targeted only when they too are at the waterline. A clamped-against target is
 *     skipped for AQUATIC_BAD_TARGET_COOLDOWN ticks (aquatic.ts) as a safety net against re-chase loops.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.7 – 1.3    (σ 0.10)  move-speed multiplier (m/tick = baseSpeed × speed) — a slow-ish swimmer, always slower than a pike
 *   size        2.0 – 4.0    (σ 0.25)  body scale (rendering) + energy-capacity multiplier (~200–400 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.7 – 1.4    (σ 0.15)  breeding-cooldown divisor — a prolific spawner (replaces pike kills + old age)
 *   lifespan    15000–30000  (σ 1500)  old-age death age in ticks (~8–17 min at 1× — a long-lived fish)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { animalEnergyMax, attemptMate, canAttemptBreed, pickWanderTarget, PLANT_MIN_EDIBLE_FRACTION } from './base';
import { aquaticSettle, aquaticSteerToward, aquaticValidTarget, isBadTarget } from './aquatic';
import type { Agent, PlantSpecies } from '../../types';
import { ANIMAL_STATE_MATE, ANIMAL_STATE_SEEK_FOOD, ANIMAL_STATE_WANDER, STAGE_FRUITING } from '../../types';
import type { Sim } from '../../sim';

/** Meters above the water line a plant may sit and still be reachable from the swim line (the bank zone). */
const CARP_SHORE_REACH = 3; // matches the marsh band — reed/cranberry/grass at the waterline are all in range
/** Meters above the water line an insect may sit and still be strikable (waterline insects only). */
const CARP_INSECT_REACH = 2;
/** Distance score multiplier for reed over other shore plants — "reed preferred" at equal distance. */
const REED_PREFERENCE = 0.5;

export const CARP: AnimalSpecies = {
  id: 'carp',
  kind: 'animal',
  displayName: 'carp',
  traits: {
    speed: { min: 0.7, max: 1.3, sigma: 0.1 },
    size: { min: 2.0, max: 4.0, sigma: 0.25 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.7, max: 1.4, sigma: 0.15 },
    lifespan: { min: 15000, max: 30000, sigma: 1500 },
  },
  baseMetabolism: 0.06, // per tick at metabolism=1 — a large cold-blooded body burns slowly
  moveCostPerMeter: 0.25,
  baseSpeed: 0.08, // m/tick at speed=1 (~2.4 m/s at 1×) — slow-ish; the pike (min 0.135) always outruns it
  senseRadius: 14,
  eatRange: 5, // rooting reach along the bank — plants up to ~5 m from the swim line are within a bite
  eatAmount: 25, // a graze bite of reed/shore grass (the plant's regrowth floor handles the rest)
  digestionEfficiency: 0.7,
  hungerThreshold: 0.8, // forage below 80% of capacity
  maturityAge: 1800, // ~60 s juvenile phase at 1×
  breedEnergyFraction: 0.6,
  breedCooldownBase: 1800, // ÷ fertility → ~1300–2600 ticks between spawns (prolific — must outpace pike predation + old age)
  matingRange: 8,
  wanderRadius: 12, // patrol the local river stretch (validTarget keeps it in the volume)
  roostAnchored: true, // territorial home stretch — keeps carp patches dense so pike encounter prey on every patrol
  popCap: 120, // GLOBAL across all river basins — must cover every disconnected water body: the predator-free
  // western channel fills to its local carrying capacity (~60) first, and at a cap of 70 only ~15 slots were
  // left for the pike's basin, whose prey base six pikes strip before it can breed back (Phase 6 stability
  // forensics: total sat exactly at the old cap while the eastern carp crashed to zero).
  foodSpecies: ['reed', 'grass', 'clover', 'cranberry'], // shore plants — reed preferred by proximity + score bias
  preySpecies: ['insect'], // opportunistic — only waterline insects are ever targeted (see carpDecide)
  bodySize: [0.3, 0.18, 0.6], // world-space meters at mid size trait → rendered ~0.45–0.75 m long (a real carp)
  validTarget: aquaticValidTarget, // river-volume constraint (wander targets only — see module header)
  settlePosition: aquaticSettle, // clamp back into the volume + seat at depth after every act
  decide: carpDecide,
};

registerSpecies(CARP);

/** Carp decision tick: shore plants (reed preferred) / waterline insects when hungry, else breed or wander. */
function carpDecide(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (!a.data) a.data = {};
  const d = a.data;

  // 1) Hungry → seek the nearest reachable shore plant or waterline insect within sense radius.
  if (a.energy / animalEnergyMax(a) < sp.hungerThreshold) {
    const best = seekShoreFood(sim, a, sp.senseRadius);
    if (best) {
      d.tx = best.pos.x;
      d.tz = best.pos.z;
      d.targetId = best.id;
      delete d.corpseTarget;
      a.state = ANIMAL_STATE_SEEK_FOOD;
      return;
    }
    // Nothing in kill range — steer toward the nearest shore food BEYOND sense radius instead of wandering
    // blindly (the generic decide's directional-foraging pattern, with the same shore filter).
    const far = seekShoreFood(sim, a, sp.senseRadius * 6);
    if (far) {
      const pt = aquaticSteerToward(sim, a, sp, far.pos.x, far.pos.z);
      if (pt) {
        d.tx = pt.x;
        d.tz = pt.z;
        delete d.targetId;
        delete d.corpseTarget;
        a.state = ANIMAL_STATE_WANDER;
        return;
      }
      // No in-volume steer point (the channel doesn't open toward the food): fall through to a validated
      // wander — it keeps moving along the channel, and the next decision retries from there.
    }
  }

  // 2) Not hungry → try to breed with an opposite-sex partner in range (shared logic).
  if (canAttemptBreed(sim, a, sp) && attemptMate(sim, a, sp)) {
    a.state = ANIMAL_STATE_MATE;
    return;
  }

  // 3) Otherwise wander to a fresh random point (validTarget keeps it in the river volume).
  pickWanderTarget(sim, a, sp);
}

/**
 * Nearest edible agent for a carp within `radius`, via the spatial grid: a plant in foodSpecies whose cell
 * sits within CARP_SHORE_REACH above the water line (the bank) and passes the shared edibility rules, or an
 * insect at the waterline. Reed scores half its distance ("reed preferred"). Bad-target cooldowns apply.
 */
function seekShoreFood(sim: Sim, a: Agent, radius: number): Agent | null {
  const w = sim.world;
  let best: Agent | null = null;
  let bestScore = Infinity;
  for (const id of sim.grid.query(a.pos.x, a.pos.z, radius)) {
    const p = sim.agentById(id);
    if (!p || p.id === a.id || p.energy <= 0) continue; // self is never food
    if (isBadTarget(a, sim, p.id)) continue; // recently clamped against — skip for the cooldown window
    const ps = sim.speciesOf(p.id); // dense cache — per-candidate lookups on the carp foraging path
    if (!ps) continue;
    let edible: boolean;
    if (ps.kind === 'plant') {
      const psp = ps as PlantSpecies;
      // Unestablished shoots are inedible — same rule as seekNearestFood in base.ts.
      if (p.state !== STAGE_FRUITING && p.energy < PLANT_MIN_EDIBLE_FRACTION * psp.maxEnergy) continue;
      edible = CARP.foodSpecies.includes(p.species);
      // Shore filter: only plants at the water's edge are reachable from the swim line.
      if (edible && w.heightAt(p.pos.x, p.pos.z) >= w.waterLevel + CARP_SHORE_REACH) edible = false;
    } else {
      // Opportunistic insects — only ones actually at the waterline.
      edible = p.species === 'insect' && w.heightAt(p.pos.x, p.pos.z) < w.waterLevel + CARP_INSECT_REACH;
    }
    if (!edible) continue;
    const dx = p.pos.x - a.pos.x;
    const dz = p.pos.z - a.pos.z;
    let score = dx * dx + dz * dz;
    if (p.species === 'reed') score *= REED_PREFERENCE; // reed preferred at equal distance
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
