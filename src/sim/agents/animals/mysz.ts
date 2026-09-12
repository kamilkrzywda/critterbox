/**
 * mysz — mouse (PLAN roster, Phase 4). The tiny fast breeder: grazes grass + clover and eats INSECTS as
 * prey (Phase 4 Part B — an insect's energy is digested on the spot via Sim.killAgent), matures quickly,
 * breeds often and dies young — the base of the food chain that fox/owl/stork/crow will eat in Phase 5.
 * Self-registers into the species registry at load (plants pattern); behaviour comes from the shared
 * framework in ./base.ts, parameterized by this table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.8 – 1.4   (σ 0.12)  move-speed multiplier (m/tick = baseSpeed × speed)
 *   size        0.7 – 1.3   (σ 0.15)  body scale (rendering) + energy-capacity multiplier
 *   metabolism  0.8 – 1.3   (σ 0.10)  drain-rate multiplier
 *   fertility   0.6 – 1.4   (σ 0.15)  breeding-cooldown divisor (higher → breeds more often)
 *   lifespan    3600–7200   (σ 400)   old-age death age in ticks (~2–4 min at 1×)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';

export const MYSZ: AnimalSpecies = {
  id: 'mysz',
  kind: 'animal',
  displayName: 'mysz (mouse)',
  traits: {
    speed: { min: 0.8, max: 1.4, sigma: 0.12 },
    size: { min: 0.7, max: 1.3, sigma: 0.15 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.6, max: 1.4, sigma: 0.15 },
    lifespan: { min: 3600, max: 7200, sigma: 400 },
  },
  baseMetabolism: 0.04, // per tick at metabolism=1 → ~40 s from full without food or movement
  moveCostPerMeter: 0.3,
  baseSpeed: 0.12, // m/tick at speed=1 (~3.6 m/s at 1×)
  senseRadius: 12,
  eatRange: 1.0,
  eatAmount: 18,
  digestionEfficiency: 0.6,
  hungerThreshold: 0.85, // forage below 85% of capacity
  maturityAge: 600, // ~20 s juvenile phase at 1×
  breedEnergyFraction: 0.6,
  breedCooldownBase: 450, // ÷ fertility → 321–750 ticks between litters (tiny fast breeder — Phase 5 stability tuning)
  matingRange: 8,
  wanderRadius: 18,
  popCap: 400,
  foodSpecies: ['grass', 'clover'],
  preySpecies: ['owady'], // insects — extra digestion energy; the prey is killed when fed upon
  bodySize: [0.22, 0.14, 0.3], // small grey-brown box ~0.3 m long at size=1 (rendering)
};

registerSpecies(MYSZ);
