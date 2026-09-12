/**
 * zając — hare (PLAN roster, Phase 4 Part B). The small herbivore of open meadow/grassland: larger and
 * slower-breeding than the mouse but longer-lived; grazes grass + clover. Self-registers into the species
 * registry at load (plants pattern); behaviour comes from the shared framework in ./base.ts, parameterized
 * by this table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.8 – 1.3    (σ 0.10)  move-speed multiplier (m/tick = baseSpeed × speed)
 *   size        1.5 – 2.5    (σ 0.20)  body scale (rendering) + energy-capacity multiplier
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.4 – 1.0    (σ 0.12)  breeding-cooldown divisor (lower than the mouse's — slower breeder)
 *   lifespan    9000–18000   (σ 1000)  old-age death age in ticks (~5–10 min at 1×, longer-lived than a mouse)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';

export const ZAJAC: AnimalSpecies = {
  id: 'zajac',
  kind: 'animal',
  displayName: 'zając (hare)',
  traits: {
    speed: { min: 0.8, max: 1.3, sigma: 0.1 },
    size: { min: 1.5, max: 2.5, sigma: 0.2 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.4, max: 1.0, sigma: 0.12 },
    lifespan: { min: 9000, max: 18000, sigma: 1000 },
  },
  baseMetabolism: 0.06, // per tick at metabolism=1 — a bigger body than the mouse's
  moveCostPerMeter: 0.35,
  baseSpeed: 0.1, // m/tick at speed=1 (~3 m/s at 1×) — larger and slower-moving than the mouse (0.12)
  senseRadius: 14,
  eatRange: 1.2,
  eatAmount: 25,
  digestionEfficiency: 0.55,
  hungerThreshold: 0.85, // forage below 85% of capacity
  maturityAge: 900, // ~30 s juvenile phase at 1×
  breedEnergyFraction: 0.6,
  breedCooldownBase: 1800, // ÷ fertility → 1800–4500 ticks between litters (lower fertility than the mouse)
  matingRange: 3.5,
  wanderRadius: 25,
  popCap: 150,
  foodSpecies: ['grass', 'clover'],
  bodySize: [0.5, 0.35, 0.7], // medium brown hare ~0.7 m long at size=1 (rendering)
};

registerSpecies(ZAJAC);
