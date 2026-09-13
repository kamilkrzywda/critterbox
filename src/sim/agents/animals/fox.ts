/**
 * Fox (PLAN roster, Phase 5). The main predator AND scavenger: hunts hare/mouse/frog and feeds on
 * corpses. HUNTER-GATED per the Sandfall snake lesson: it only enters hunt state below hungerThreshold
 * (60% of capacity) — full foxes wander/breed like herbivores, which prevents the classic predator-prey
 * overshoot/oscillation. SATURATING INTAKE (base.ts): each kill raises satiation, so quick successive
 * kills pay sharply diminishing returns and one fox can't wipe a local prey patch in minutes. When
 * hungry it checks corpses first via scavengerDecide (corpses.ts) — scavenging is cheaper than hunting
 * (no pursuit), closing the nutrient loop with crows. Self-registers into the species registry at load;
 * behaviour comes from ./base.ts parameterized by this table + per-agent traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.9 – 1.4    (σ 0.10)  move-speed multiplier — faster than every prey species' average, but the fastest mice/hares can still escape a slow fox
 *   size        1.8 – 2.6    (σ 0.20)  body scale (rendering) + energy-capacity multiplier (~180–260 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.5 – 1.0    (σ 0.12)  breeding-cooldown divisor — a slow breeder (few foxes stay few)
 *   lifespan    14400–28800  (σ 1500)  old-age death age in ticks (~8–16 min at 1×)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { scavengerDecide } from '../../corpses';

export const FOX: AnimalSpecies = {
  id: 'fox',
  kind: 'animal',
  displayName: 'fox',
  traits: {
    speed: { min: 0.9, max: 1.4, sigma: 0.1 },
    size: { min: 1.8, max: 2.6, sigma: 0.2 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.5, max: 1.0, sigma: 0.12 },
    lifespan: { min: 14400, max: 28800, sigma: 1500 },
  },
  baseMetabolism: 0.03, // per tick at metabolism=1 — Phase 7: was 0.07; diurnal foraging (activity 0.3+0.7×light) compresses the hunting window to ~55% of ticks on average, so resting burn drops to keep the energy budget balanced (20k-step stability tuning)
  moveCostPerMeter: 0.3,
  baseSpeed: 0.16, // m/tick at speed=1 (~4.8 m/s at 1×) — faster than mouse (0.12)/hare (0.1)/frog (0.1)
  senseRadius: 18,
  eatRange: 0.8, // contact kill range (the Phase 4 stale-point mechanic adds ~prey-speed×5 of effective reach)
  eatAmount: 30, // scavenging bite size from corpses (unused for prey — kills digest the victim's energy)
  digestionEfficiency: 0.7,
  hungerThreshold: 0.8, // HUNTER GATE: hunts below 80% of capacity — one mouse kill ≈ the coast-to-gate burn (near break-even); 0.85 hunted too hard and stripped prey patches (Phase 5)
  maturityAge: 1800, // ~1 min juvenile phase at 1×
  breedEnergyFraction: 0.65,
  breedCooldownBase: 2400, // ÷ fertility → 2400–4800 ticks between litters (Phase 5 stability tuning)
  matingRange: 8,
  wanderRadius: 16, // home-range patrol around the roost (see roostAnchored) — Phase 5
  roostAnchored: true, // unanchored random-walk diffusion carried foxes into "prey deserts" between mouse clusters
  popCap: 24,
  foodSpecies: [], // carnivore — prey + corpses only
  preySpecies: ['mouse', 'hare', 'frog'],
  bodySize: [0.4, 0.5, 0.85], // world-space meters at mid size trait → rendered 0.38–0.63 m high, 0.64–1.06 m long incl. tail (a real fox)
  decide: scavengerDecide, // corpse first when hungry, then prey — see corpses.ts
  activityLevel: (sim) => 0.3 + 0.7 * sim.environment.light, // Phase 7: DIURNAL — full foraging by day, reduced at night
  // (floor 0.3 keeps a trickle of nocturnal scavenging; the probability gate in scavengerDecide turns the
  // multiplier into a hunting RATE, not an on/off switch)
};

registerSpecies(FOX);
