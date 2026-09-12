/**
 * wrona — crow (PLAN roster, Phase 5). The scavenger/generalist: eats CORPSES + insects + cranberry
 * berries. Fast and opportunistic with a decent breeding rate; like the fox it uses scavengerDecide so a
 * corpse in range beats live prey when hungry (scavenging is cheaper than hunting — no pursuit), closing
 * the nutrient loop on the other side of the food chain. Self-registers into the species registry at load;
 * behaviour comes from ./base.ts parameterized by this table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       1.0 – 1.6    (σ 0.12)  move-speed multiplier — a fast generalist, keeps up with mice
 *   size        1.0 – 1.5    (σ 0.12)  body scale (rendering) + energy-capacity multiplier (~100–150 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.7 – 1.4    (σ 0.15)  breeding-cooldown divisor — a decent breeder per the roster
 *   lifespan    9000–36000   (σ 2000)  old-age death age in ticks (~5–20 min at 1×, long-lived scavenger)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { scavengerDecide } from '../../corpses';

export const WRONA: AnimalSpecies = {
  id: 'wrona',
  kind: 'animal',
  displayName: 'wrona (crow)',
  traits: {
    speed: { min: 1.0, max: 1.6, sigma: 0.12 },
    size: { min: 1.0, max: 1.5, sigma: 0.12 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.7, max: 1.4, sigma: 0.15 },
    lifespan: { min: 9000, max: 36000, sigma: 2000 }, // long-lived scavenger — headroom past the 20k stability gate (Phase 5)
  },
  baseMetabolism: 0.05, // per tick at metabolism=1
  moveCostPerMeter: 0.25,
  baseSpeed: 0.13, // m/tick at speed=1 (~3.9 m/s at 1×) — fast for its size
  senseRadius: 16,
  eatRange: 0.8,
  eatAmount: 25, // scavenging bite from corpses AND the berry-graze amount (shared graze path)
  digestionEfficiency: 0.6,
  hungerThreshold: 0.8, // opportunistic — eats often, below 80% of capacity (Phase 5 stability tuning)
  maturityAge: 1200, // ~40 s juvenile phase at 1×
  breedEnergyFraction: 0.6,
  breedCooldownBase: 2400, // ÷ fertility → ~1700–3400 ticks between clutches (decent breeder)
  matingRange: 12,
  wanderRadius: 16, // forage the local area — food is widespread but stay put (Phase 5)
  popCap: 40,
  foodSpecies: ['cranberry'], // berries — the cheap generalist bonus on top of corpses + insects
  preySpecies: ['owady'],
  bodySize: [0.2, 0.26, 0.38], // world-space meters at mid size trait → rendered 0.2–0.33 m high, 0.29–0.48 m long (a real crow)
  decide: scavengerDecide, // corpse first when hungry, then insects/berries — see corpses.ts
};

registerSpecies(WRONA);
