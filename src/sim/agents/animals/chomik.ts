/**
 * chomik — hamster (PLAN roster, Phase 4 Part B). The stocky seed-eater of grassland and forest edge:
 * eats grass + clover + cranberry berries; slower than the mouse but a decent breeder. Self-registers into
 * the species registry at load (plants pattern); behaviour comes from the shared framework in ./base.ts,
 * parameterized by this table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.7 – 1.2    (σ 0.10)  move-speed multiplier (m/tick = baseSpeed × speed)
 *   size        1.0 – 1.6    (σ 0.15)  body scale (rendering) + energy-capacity multiplier
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.6 – 1.3    (σ 0.12)  breeding-cooldown divisor (decent breeder, close to the mouse's range)
 *   lifespan    5400–10800   (σ 700)   old-age death age in ticks (~3–6 min at 1×)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';

export const CHOMIK: AnimalSpecies = {
  id: 'chomik',
  kind: 'animal',
  displayName: 'chomik (hamster)',
  traits: {
    speed: { min: 0.7, max: 1.2, sigma: 0.1 },
    size: { min: 1.0, max: 1.6, sigma: 0.15 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.6, max: 1.3, sigma: 0.12 },
    lifespan: { min: 5400, max: 10800, sigma: 700 },
  },
  baseMetabolism: 0.05, // per tick at metabolism=1
  moveCostPerMeter: 0.35,
  baseSpeed: 0.09, // m/tick at speed=1 (~2.7 m/s at 1×) — stocky and slow-ish (mouse is 0.12)
  senseRadius: 12,
  eatRange: 1.0,
  eatAmount: 20,
  digestionEfficiency: 0.6,
  hungerThreshold: 0.85, // forage below 85% of capacity
  maturityAge: 700, // ~23 s juvenile phase at 1×
  breedEnergyFraction: 0.6,
  breedCooldownBase: 800, // ÷ fertility → ~615–1333 ticks between litters (Phase 5 stability tuning)
  matingRange: 10,
  wanderRadius: 20,
  popCap: 200,
  foodSpecies: ['grass', 'clover', 'cranberry'], // seed eater — berries included
  bodySize: [0.4, 0.3, 0.5], // tan stocky box ~0.5 m long at size=1 (rendering)
};

registerSpecies(CHOMIK);
