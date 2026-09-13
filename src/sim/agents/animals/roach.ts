/**
 * Roach (v0.12). The small forage fish — the "mouse" of the river: tiny, fast-breeding, and the base of
 * the aquatic food chain. Grazes algae + pondweed in open water (floating flowers as fallback), and is
 * itself prey for trout — the dedicated small-fish predator (pike deliberately skip roach; see PIKE).
 * Lives only in the river volume via the shared aquatic hooks; behaviour comes from ./base.ts parameterized
 * by this table + per-agent traits. Self-registers into the species registry at load.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.8 – 1.3    (σ 0.10)  move-speed multiplier — a quick little fish; the fastest can escape even a slow trout
 *   size        0.6 – 1.2    (σ 0.15)  body scale (rendering) + energy-capacity multiplier (~60–120 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.7 – 1.5    (σ 0.15)  breeding-cooldown divisor — a prolific spawner like the mouse
 *   lifespan    5000–11000   (σ 800)   old-age death age in ticks (~3–6 min at 1×). Long on purpose (v0.12 stability
 *                                       tuning): every seeded animal is a newborn, so the founding cohort dies of old age
 *                                       in one synchronized wave; a long, wide wave (±3σ ≈ 6000 ticks) is gentle enough
 *                                       for a growing population to absorb instead of collapsing below mate-finding density
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { aquaticSettle, aquaticValidTarget, fishFoodReachable } from './aquatic';

export const ROACH: AnimalSpecies = {
  id: 'roach',
  kind: 'animal',
  displayName: 'roach',
  traits: {
    speed: { min: 0.8, max: 1.3, sigma: 0.1 },
    size: { min: 0.6, max: 1.2, sigma: 0.15 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.7, max: 1.5, sigma: 0.15 },
    lifespan: { min: 5000, max: 11000, sigma: 800 },
  },
  baseMetabolism: 0.04, // per tick at metabolism=1 — a small body burns little (mouse parity)
  moveCostPerMeter: 0.25,
  baseSpeed: 0.11, // m/tick at speed=1 (~3.3 m/s at 1×) — quicker than the carp it swims with
  senseRadius: 10,
  eatRange: 2.5,
  eatAmount: 8, // small bites of algae/pondweed
  digestionEfficiency: 0.7,
  hungerThreshold: 0.8, // forage below 80% of capacity
  maturityAge: 600, // ~20 s juvenile phase at 1× — fast breeder (mouse parity)
  breedEnergyFraction: 0.6,
  breedCooldownBase: 650, // ÷ fertility → ~433–929 ticks between spawns (mouse-parity fast breeder — must outpace pike/trout predation on the base)
  matingRange: 8, // wide on purpose (v0.12 stability tuning): at low density after the founding cohort's old-age
  // wave, a 5 m range leaves survivors too sparse to find mates and breeding collapses into an extinction vortex;
  // 8 m keeps pairs forming through the trough so the base recovers instead of going extinct
  wanderRadius: 8, // tight local patrol — small fish don't roam far
  popCap: 100, // the river's "mouse" — a fast-turnover base for trout. Capped LOW on purpose (v0.12 stability
  // tuning): an uncapped roach overshoot (~153) lets predator encounter rates spike and crash the population to
  // zero before breeding recovers; at cap 100 the oscillation damps and the base persists.
  foodSpecies: ['algae', 'pondweed'], // in-water plants (v0.12)
  fallbackFoodSpecies: ['waterlily'], // flowers only when nothing else is seen
  foodReachable: fishFoodReachable, // in-water plants behind a land barrier are skipped, not chased (v0.12)
  bodySize: [0.1, 0.07, 0.3], // world-space meters at mid size trait → rendered ~0.2–0.4 m long (a real roach)
  validTarget: aquaticValidTarget, // river-volume constraint (wander targets only — see aquatic.ts)
  settlePosition: aquaticSettle, // clamp back into the volume + seat at depth after every act
};

registerSpecies(ROACH);
