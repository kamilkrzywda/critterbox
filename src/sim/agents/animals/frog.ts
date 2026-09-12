/**
 * Frog (PLAN roster, Phase 5). The marsh insectivore: eats INSECTS as prey and is constrained to
 * the marsh/water-edge zone via the base.ts `validTarget` hook — wander targets must sit within
 * MARSH_BAND of the water line (the marsh biome IS that band, so frogs live on wet ground and in shallow
 * water). Prey pursuit is exempt from the constraint, so a frog can still catch an insect that strays to
 * a bank. Breeding happens near water automatically: both parents never leave the zone. Prey of stork &
 * crow (and pike later, Phase 6). Self-registers into the species registry at load; behaviour comes from
 * ./base.ts parameterized by this table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.7 – 1.3    (σ 0.10)  move-speed multiplier (m/tick = baseSpeed × speed) — an ambush hopper, slower than a mouse
 *   size        0.8 – 1.4    (σ 0.12)  body scale (rendering) + energy-capacity multiplier
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.6 – 1.3    (σ 0.15)  breeding-cooldown divisor
 *   lifespan    5400–10800   (σ 700)   old-age death age in ticks (~3–6 min at 1×)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import type { Sim } from '../../sim';
import { MARSH_BAND } from '../../../worldgen/worldgen';

/** Marsh/water-edge zone: within the marsh band of the water line (shallow water included). */
function inMarshZone(sim: Sim, x: number, z: number): boolean {
  return Math.abs(sim.world.heightAt(x, z) - sim.world.waterLevel) <= MARSH_BAND;
}

export const FROG: AnimalSpecies = {
  id: 'frog',
  kind: 'animal',
  displayName: 'Frog',
  traits: {
    speed: { min: 0.7, max: 1.3, sigma: 0.1 },
    size: { min: 0.8, max: 1.4, sigma: 0.12 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.6, max: 1.3, sigma: 0.15 },
    lifespan: { min: 5400, max: 10800, sigma: 700 },
  },
  baseMetabolism: 0.04, // per tick at metabolism=1 — a small body like the mouse's
  moveCostPerMeter: 0.25,
  baseSpeed: 0.1, // m/tick at speed=1 (~3 m/s at 1×) — slower than the mouse (0.12): ambush, not pursuit
  senseRadius: 16, // wide enough to reach insects on the banks from shallow water
  eatRange: 0.8,
  eatAmount: 15, // a browse bite from cranberry bushes (the insect fallback diet); insects are eaten as prey
  digestionEfficiency: 0.7,
  hungerThreshold: 0.8, // forage below 80% of capacity
  maturityAge: 900, // ~30 s juvenile phase at 1×
  breedEnergyFraction: 0.6,
  breedCooldownBase: 900, // ÷ fertility → ~690–1500 ticks between spawns (tuned in Phase 5 stability runs)
  matingRange: 6,
  wanderRadius: 14, // stay inside the local marsh patch
  popCap: 90, // the marsh food base (insects + cranberries) can't support more without mass starvation (Phase 5)
  foodSpecies: ['cranberry'], // marsh generalist fallback: browse the berry bushes when local insects run thin
  preySpecies: ['insect'], // primary diet — marsh insects
  bodySize: [0.1, 0.09, 0.14], // world-space meters at mid size trait → rendered 0.07–0.11 m high, ~0.1–0.18 m long (a real frog)
  validTarget: inMarshZone, // marsh/water-edge constraint (wander targets only — see module header)
};

registerSpecies(FROG);
