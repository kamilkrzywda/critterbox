/**
 * Insect (PLAN roster, Phase 4 Part B). The pollinators and prey of the ecosystem: short-lived,
 * fast, low-energy, high-fertility. Behaviour deviates from the generic grazer via the base.ts hooks:
 *   - `decide`: when hungry, seek the nearest FLOWERING/FRUITING plant (the only nectar sources) instead of
 *     any edible plant; breeding/wander reuse the shared attemptMate/pickWanderTarget helpers.
 *   - `feedOnTarget`: a visit takes NECTAR_BIOMASS × digestionEfficiency of energy AND calls pollinatePlant —
 *     boosting that plant's growth/yield for POLLINATE_BOOST_TICKS ticks (per-plant cooldown in sim.ts).
 * Mice eat insects as prey (mouse.preySpecies) — the base of the Phase 5 predator chain. Self-registers into
 * the species registry at load; everything else comes from ./base.ts parameterized by this table + traits.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       1.0 – 2.0    (σ 0.15)  move-speed multiplier (m/tick = baseSpeed × speed) — the fastest movers
 *   size        0.2 – 0.4    (σ 0.06)  body scale (rendering) + energy-capacity multiplier (tiny store, ~20–40 e)
 *   metabolism  0.8 – 1.4    (σ 0.10)  drain-rate multiplier
 *   fertility   1.0 – 2.0    (σ 0.20)  breeding-cooldown divisor — the highest of all species
 *   lifespan    900–2700     (σ 300)   old-age death age in ticks (~30 s–90 s at 1×, short-lived)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { animalEnergyMax, attemptMate, canAttemptBreed, pickWanderTarget } from './base';
import { getSpecies } from '../../registry';
import { STAGE_FRUITING, STAGE_GROWING, ANIMAL_STATE_MATE, ANIMAL_STATE_SEEK_FOOD } from '../../types';
import type { Agent } from '../../types';
import type { Sim } from '../../sim';
import { pollinatePlant } from '../../sim';

/** Biomass-equivalent of one nectar visit (× digestionEfficiency → energy gained). */
const NECTAR_BIOMASS = 12;

export const INSECT: AnimalSpecies = {
  id: 'insect',
  kind: 'animal',
  displayName: 'Insect',
  traits: {
    speed: { min: 1.0, max: 2.0, sigma: 0.15 },
    size: { min: 0.2, max: 0.4, sigma: 0.06 },
    metabolism: { min: 0.8, max: 1.4, sigma: 0.1 },
    fertility: { min: 1.0, max: 2.0, sigma: 0.2 },
    lifespan: { min: 900, max: 2700, sigma: 300 },
  },
  baseMetabolism: 0.05, // per tick at metabolism=1 — a small body that burns fast relative to its store
  moveCostPerMeter: 0.15,
  baseSpeed: 0.2, // m/tick at speed=1 (~6 m/s at 1×) — the fastest movers in Phase 4
  senseRadius: 10,
  eatRange: 0.8,
  eatAmount: 0, // unused — insects feed via feedOnTarget (nectar), not grazePlant
  digestionEfficiency: 0.6,
  hungerThreshold: 0.7, // forage below 70% of capacity
  maturityAge: 120, // ~4 s juvenile phase at 1× — short-lived species mature fast
  breedEnergyFraction: 0.5,
  breedCooldownBase: 360, // ÷ fertility → 180–360 ticks between broods (high fertility)
  matingRange: 4,
  wanderRadius: 12,
  popCap: 600,
  foodSpecies: [], // no grazing — nectar only, via feedOnTarget
  bodySize: [0.04, 0.03, 0.06], // world-space meters at mid size trait → rendered ≤ ~7 cm long (a real insect — a tiny dark speck)
  decide: insectDecide,
  feedOnTarget: feedOnNectar,
};

registerSpecies(INSECT);

/** Insect decision tick: nectar when hungry (flowering/fruiting plants only), otherwise breed or wander. */
function insectDecide(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (!a.data) a.data = {};
  const d = a.data;

  // 1) Hungry → seek the nearest flowering/fruiting plant within sense radius (the only nectar sources).
  if (a.energy / animalEnergyMax(a) < sp.hungerThreshold) {
    let best: Agent | null = null;
    let bestD2 = Infinity;
    for (const id of sim.grid.query(a.pos.x, a.pos.z, sp.senseRadius)) {
      const p = sim.agentById(id);
      if (!p || p.energy <= 0) continue;
      const ps = getSpecies(p.species);
      if (!ps || ps.kind !== 'plant') continue;
      if (p.state !== STAGE_GROWING && p.state !== STAGE_FRUITING) continue; // only flowering/fruiting plants offer nectar
      const dx = p.pos.x - a.pos.x;
      const dz = p.pos.z - a.pos.z;
      const dist2 = dx * dx + dz * dz;
      if (dist2 < bestD2) {
        bestD2 = dist2;
        best = p;
      }
    }
    if (best) {
      d.tx = best.pos.x;
      d.tz = best.pos.z;
      d.targetId = best.id;
      a.state = ANIMAL_STATE_SEEK_FOOD;
      return;
    }
  }

  // 2) Not hungry → try to breed with an opposite-sex partner in range (shared logic).
  if (canAttemptBreed(sim, a, sp) && attemptMate(sim, a, sp)) {
    a.state = ANIMAL_STATE_MATE;
    return;
  }

  // 3) Otherwise wander to a fresh random point.
  pickWanderTarget(sim, a, sp);
}

/** Nectar visit: feed on the flower and pollinate it (the boost applies when the plant's cooldown has elapsed). */
function feedOnNectar(sim: Sim, _a: Agent, sp: AnimalSpecies, target: Agent): number {
  if (target.state !== STAGE_GROWING && target.state !== STAGE_FRUITING) return 0; // grazed away since the decision
  pollinatePlant(sim, target);
  return NECTAR_BIOMASS * sp.digestionEfficiency;
}
