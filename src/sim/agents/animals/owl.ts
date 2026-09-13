/**
 * Owl (PLAN roster, Phase 5). The nocturnal hunter of mouse/hare. Phase 7 wires light → activity:
 * `activityLevel` returns ~1 at night and ~0 at noon (a small day floor keeps a trickle of crepuscular
 * foraging — see the hook below), so owls hunt almost exclusively in the dark while foxes and storks rest.
 * Phase 7 stability tuning: compressing all hunting into the night window (~30% of the cycle) breaks the
 * pre-Phase-7 energy balance (one mouse kill ≈ coast-to-gate burn, spread over a full day), so resting
 * metabolism drops 0.06 → 0.015 — an owl that can only feed at night burns less while roosting. Self-registers
 * into the species registry at load; behaviour comes from ./base.ts parameterized by this table + traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.8 – 1.3    (σ 0.10)  move-speed multiplier — silent flight, comparable to the fox's
 *   size        1.5 – 2.2    (σ 0.15)  body scale (rendering) + energy-capacity multiplier (~150–220 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.4 – 0.9    (σ 0.10)  breeding-cooldown divisor — a slow breeder like the stork
 *   lifespan    14400–28800  (σ 1500)  old-age death age in ticks (~8–16 min at 1×)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';

export const OWL: AnimalSpecies = {
  id: 'owl',
  kind: 'animal',
  displayName: 'Owl',
  traits: {
    speed: { min: 0.8, max: 1.3, sigma: 0.1 },
    size: { min: 1.5, max: 2.2, sigma: 0.15 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.4, max: 0.9, sigma: 0.1 },
    lifespan: { min: 14400, max: 28800, sigma: 1500 },
  },
  baseMetabolism: 0.015, // per tick at metabolism=1 — Phase 7: was 0.06; night-compressed hunting needs a low roost burn (see module header)
  moveCostPerMeter: 0.3,
  baseSpeed: 0.15, // m/tick at speed=1 (~4.5 m/s at 1×) — comparable to the fox (0.16)
  senseRadius: 30, // nocturnal aerial hunter — scans a wide disc from the roost
  eatRange: 0.8,
  eatAmount: 0, // unused — owls feed on prey only
  digestionEfficiency: 0.75,
  hungerThreshold: 0.8, // hunts below 80% of capacity — one mouse kill ≈ the coast-to-gate burn (near break-even) (Phase 5)
  maturityAge: 2400, // ~80 s juvenile phase at 1×
  breedEnergyFraction: 0.65,
  breedCooldownBase: 3600, // ÷ fertility → 4000–9000 ticks between owlets (slow breeder — Phase 5 stability tuning)
  matingRange: 8,
  wanderRadius: 12, // home-range patrol around the roost (see roostAnchored) — Phase 5
  roostAnchored: true, // unanchored random-walk diffusion carried owls into "prey deserts" between mouse clusters
  popCap: 16,
  foodSpecies: [], // carnivore — prey only
  preySpecies: ['mouse', 'hare'],
  bodySize: [0.32, 0.4, 0.4], // world-space meters at mid size trait → rendered 0.3–0.5 m high (a real owl)
  activityLevel: (sim) => 0.2 + 0.8 * (1 - sim.environment.light), // Phase 7: NOCTURNAL — full activity at night (light=0),
  // a small day floor (0.2) keeps crepuscular foraging so the night-compressed hunting window still balances
  // the energy budget (see module header); dawn/dusk fall in between via the light curve
};

registerSpecies(OWL);
