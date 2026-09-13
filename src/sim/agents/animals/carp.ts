/**
 * Carp (PLAN roster, Phase 6; v0.12 diet rework). The river omnivore: lives only in the river volume
 * (aquatic.ts) and feeds on IN-WATER plants — algae mats + pondweed beds are its primary food, so it forages
 * across open water instead of parking at the bank. Floating flowers and shore plants (reed/grass/clover/
 * cranberry at the waterline) are FALLBACK only: seekNearestFood considers them when no in-water plant is
 * visible within sense radius ("only eaten if nothing else is seen"). This is the structural fix for the
 * Phase 6 pike problem — carp clustered on the shallows chasing shore reed while pikes starved mid-lake;
 * with food in open water, prey and predator share the same patrol space. Opportunistic waterline insects
 * stay on the menu via the preyReachable filter (a bank insect out of reach is skipped, not chased — the
 * volume clamp would otherwise park the carp at the shore). Behaviour comes from ./base.ts parameterized by
 * this table + per-agent traits; the two aquatic hooks (validTarget / settlePosition) keep it in the water.
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
import { aquaticSettle, aquaticValidTarget, fishFoodReachable } from './aquatic';
import type { Agent } from '../../types';
import type { Sim } from '../../sim';

/** Meters above the water line an insect may sit and still be strikable (waterline insects only). */
const CARP_INSECT_REACH = 2;

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
  eatRange: 5, // rooting reach — in-water plants up to ~5 m from the swim line are within a bite
  eatAmount: 25, // a graze bite of algae/pondweed (the plant's regrowth floor handles the rest)
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
  foodSpecies: ['algae', 'pondweed'], // in-water plants — primary diet (v0.12)
  fallbackFoodSpecies: ['waterlily', 'reed', 'grass', 'clover', 'cranberry'], // flowers + shore plants, last resort only
  preySpecies: ['insect'], // opportunistic — waterline insects only (see preyReachable below)
  preyReachable: (sim: Sim, p: Agent): boolean =>
    p.species !== 'insect' || sim.world.heightAt(p.pos.x, p.pos.z) < sim.world.waterLevel + CARP_INSECT_REACH,
  foodReachable: fishFoodReachable, // in-water plants behind a land barrier are skipped, not chased (v0.12)
  bodySize: [0.3, 0.18, 0.6], // world-space meters at mid size trait → rendered ~0.45–0.75 m long (a real carp)
  validTarget: aquaticValidTarget, // river-volume constraint (wander targets only — see module header)
  settlePosition: aquaticSettle, // clamp back into the volume + seat at depth after every act
};

registerSpecies(CARP);
