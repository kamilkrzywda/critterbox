/**
 * Deer — roe deer (PLAN roster, Phase 4 Part B). The large browser of forest and meadow edge: eats reed +
 * cranberry + TREE browse. Grazing a tree reduces its health/yield but the tree regrows (browsing only kills
 * a tree if it is driven to zero energy — see grazePlant); deer forage gently in practice because they stop
 * once back above their hunger threshold, so one bite every few minutes per tree. Slowest mover, longest
 * lifespan, lowest fertility of the herbivores (long cooldown, single offspring like all species).
 * Self-registers into the species registry at load; behaviour comes from ./base.ts parameterized by this
 * table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.7 – 1.2    (σ 0.10)  move-speed multiplier (m/tick = baseSpeed × speed)
 *   size        3.5 – 5.5    (σ 0.40)  body scale (rendering) + energy-capacity multiplier
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.3 – 0.8    (σ 0.10)  breeding-cooldown divisor — the lowest of all species
 *   lifespan    18000–36000  (σ 2000)  old-age death age in ticks (~10–20 min at 1×, longest-lived animal)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';

export const DEER: AnimalSpecies = {
  id: 'deer',
  kind: 'animal',
  displayName: 'deer',
  traits: {
    speed: { min: 0.7, max: 1.2, sigma: 0.1 },
    size: { min: 3.5, max: 5.5, sigma: 0.4 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.3, max: 0.8, sigma: 0.1 },
    lifespan: { min: 18000, max: 36000, sigma: 2000 },
  },
  baseMetabolism: 0.09, // per tick at metabolism=1 — the biggest body in Phase 4
  moveCostPerMeter: 0.5,
  baseSpeed: 0.07, // m/tick at speed=1 (~2.1 m/s at 1×) — the slowest mover of all species
  senseRadius: 16,
  eatRange: 1.5,
  eatAmount: 25, // a browse bite; trees (maxEnergy 400, regrowth floor 0.4) survive normal browsing
  digestionEfficiency: 0.45,
  hungerThreshold: 0.75, // large browser — forages less often, so each tree gets only ~1 bite per session
  maturityAge: 1500, // ~50 s juvenile phase at 1×
  breedEnergyFraction: 0.65,
  breedCooldownBase: 3600, // ÷ fertility → 4500–12000 ticks between fawns (lowest fertility; one offspring per event)
  matingRange: 8,
  wanderRadius: 30,
  popCap: 60,
  foodSpecies: ['reed', 'cranberry', 'tree'], // browser — trees included (browse, not kill)
  bodySize: [0.8, 1.75, 2.0], // world-space meters at mid size trait → rendered 1.3–2.2 m high, 1.5–2.5 m long (a real roe deer — was 6–10 m tall before the visual-scale fix)
};

registerSpecies(DEER);
