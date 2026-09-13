/**
 * Stork (PLAN roster, Phase 5). The marsh hunter: hunts frog + mouse and moves through the
 * marsh/shallow-water zone via the base.ts `validTarget` hook — a WIDER band than the frog's (6 m around
 * the water line vs. MARSH_BAND=3), so storks patrol banks and wet meadow edges too. Prey pursuit is
 * exempt, so it can still catch a mouse that strays upland. Perches on trees when idle is left as an
 * optional visual nicety (not simulated). Slowest breeder of the predators — a handful of pairs persist.
 * Self-registers into the species registry at load; behaviour comes from ./base.ts parameterized by this
 * table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.8 – 1.3    (σ 0.10)  move-speed multiplier — a fast walker, faster than frogs' average
 *   size        2.5 – 3.5    (σ 0.20)  body scale (rendering) + energy-capacity multiplier (~250–350 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.4 – 0.9    (σ 0.10)  breeding-cooldown divisor — the lowest of all species
 *   lifespan    18000–36000  (σ 2000)  old-age death age in ticks (~10–20 min at 1×, long-lived bird)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import type { Sim } from '../../sim';

/** Stork foraging zone: a wider band around the water line than the frog's marsh constraint. */
const STORK_ZONE = 6; // meters either side of the water level (frog uses MARSH_BAND=3)
function inStorkZone(sim: Sim, x: number, z: number): boolean {
  return Math.abs(sim.world.heightAt(x, z) - sim.world.waterLevel) <= STORK_ZONE;
}

export const STORK: AnimalSpecies = {
  id: 'stork',
  kind: 'animal',
  displayName: 'Stork',
  traits: {
    speed: { min: 0.8, max: 1.3, sigma: 0.1 },
    size: { min: 2.5, max: 3.5, sigma: 0.2 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.4, max: 0.9, sigma: 0.1 },
    lifespan: { min: 18000, max: 36000, sigma: 2000 },
  },
  baseMetabolism: 0.03, // per tick at metabolism=1 — Phase 7: was 0.08; diurnal foraging (activity 0.3+0.7×light) compresses the hunting window to ~55% of ticks on average, so resting burn drops to keep the energy budget balanced (20k-step stability tuning)
  moveCostPerMeter: 0.35,
  baseSpeed: 0.14, // m/tick at speed=1 (~4.2 m/s at 1×) — faster than the frog (0.1), catches most mice too
  senseRadius: 20, // wide forager — scans a bigger disc than the fox
  eatRange: 0.9,
  eatAmount: 0, // unused — storks feed on prey only
  digestionEfficiency: 0.75,
  hungerThreshold: 0.88, // hunts below 88% of capacity — frequent meals on frogs/mice (Phase 5 stability tuning)
  maturityAge: 2400, // ~80 s juvenile phase at 1×
  breedEnergyFraction: 0.65,
  breedCooldownBase: 3600, // ÷ fertility → 4000–9000 ticks between chicks (slow breeder — Phase 5 stability tuning)
  matingRange: 8,
  wanderRadius: 14, // patrol the local marsh patch (Phase 5)
  popCap: 16,
  foodSpecies: [], // carnivore — prey only
  preySpecies: ['frog', 'mouse'],
  bodySize: [0.3, 1.0, 0.5], // world-space meters at mid size trait → rendered 0.75–1.25 m tall on the legs (a real stork — the tallest bird)
  validTarget: inStorkZone, // marsh/shallow-water constraint (wander targets only — see module header)
  activityLevel: (sim) => 0.3 + 0.7 * sim.environment.light, // Phase 7: DIURNAL — full foraging by day, reduced at night (see fox.ts)
};

registerSpecies(STORK);
