/**
 * Trout (v0.12). The mid-size river predator: hunts ROACH (its main diet) and opportunistic waterline
 * insects — the dedicated small-fish predator of the river. The food chain runs two parallel pairs, pike→carp
 * and trout→roach: when the pike shared this niche it stripped both fish populations faster than they could
 * breed back (20k-step forensics), so each pair is self-sustaining on its own. Lives only in the river volume
 * via the shared aquatic hooks; behaviour comes from ./base.ts parameterized by this table + per-agent traits,
 * with a pike-pattern decide (territorial lock: hunt when hungry, breed only at home) — see troutDecide.
 * Self-registers into the species registry at load.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.9 – 1.4    (σ 0.10)  move-speed multiplier — faster than most roach; the fastest little fish can still escape a slow trout, and a fast one outruns even a slow pike
 *   size        1.2 – 2.2    (σ 0.20)  body scale (rendering) + energy-capacity multiplier (~120–220 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.6 – 1.2    (σ 0.12)  breeding-cooldown divisor
 *   lifespan    9000–17000   (σ 1000)  old-age death age in ticks (~5–9 min at 1×). Long on purpose (v0.12 stability
 *                                       tuning, same fix as roach): every seeded animal is a newborn, so the founding cohort
 *                                       dies of old age in one synchronized wave — at 5000–12000 that wave hit t≈10.5k with
 *                                       the population still small (~12) and outpaced replacement → extinction (20k-step
 *                                       forensics: most late trout died of old age with FULL energy stores, not starvation).
 *                                       9000–17000 spreads the wave over t≈9k–17k at plateau size; no trout can die young.
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { FORAGE_SEARCH_MULT, animalEnergyMax, attemptMate, canAttemptBreed, pickWanderTarget } from './base';
import { aquaticSettle, aquaticSteerToward, aquaticValidTarget, isBadTarget, riverComponentAt } from './aquatic';
import type { Agent } from '../../types';
import type { Sim } from '../../sim';
import { ANIMAL_STATE_MATE, ANIMAL_STATE_SEEK_FOOD, ANIMAL_STATE_WANDER } from '../../types';

/** Meters above the water line an insect may sit and still be strikable (waterline insects only). */
const TROUT_INSECT_REACH = 2;

export const TROUT: AnimalSpecies = {
  id: 'trout',
  kind: 'animal',
  displayName: 'trout',
  traits: {
    speed: { min: 0.9, max: 1.4, sigma: 0.1 },
    size: { min: 1.2, max: 2.2, sigma: 0.2 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.6, max: 1.2, sigma: 0.12 },
    lifespan: { min: 9000, max: 17000, sigma: 1000 }, // see header — the founding cohort's old-age wave must not outpace replacement
  },
  baseMetabolism: 0.05, // per tick at metabolism trait = 1 — an active predator between roach and pike
  moveCostPerMeter: 0.22,
  baseSpeed: 0.13, // m/tick at speed=1 (~3.9 m/s at 1×) — faster than every roach (max 0.143 vs min trout 0.117… the fastest roaches can still escape a slow trout)
  senseRadius: 14,
  eatRange: 3, // strike range on a darting little fish
  eatAmount: 0, // unused — carnivore (prey energy is digested via Sim.killAgent)
  digestionEfficiency: 0.75,
  hungerThreshold: 0.5, // HUNTER GATE — pike parity (0.5): coasts ~60% longer between meals than the old 0.7 gate. Required with the
  // widened lifespan (v0.12 stability forensics): a founding cohort that lives to 9k+ keeps hunting through the whole run, so its
  // per-trout kill rate must drop or it strips both basins' roach bases to zero before breeding can replace them — at gate 0.7 the
  // longer-lived trout drove roach extinct by t≈8.5k and then starved themselves (20k-step forensics).
  maturityAge: 2400, // ~80 s juvenile phase at 1× — pike parity (v0.12 stability tuning): a long juvenile phase keeps the
  // founding pair from compounding its offspring into a local over-predation spiral while the basin's roach base is still
  // recovering from the initial seeding pulse (20k-step forensics: at maturity 1200 + cooldown 1800 one basin grew to
  // seven trout against ~26 roach and stripped it to zero by t≈7k)
  breedEnergyFraction: 0.65,
  breedCooldownBase: 2400, // ÷ fertility → 2000–4000 ticks between spawns — pike parity (v0.12 stability tuning): slow enough
  // that a basin's trout population tracks its roach carrying capacity instead of overshooting it (see maturityAge)
  matingRange: 8, // wide on purpose (v0.12 stability tuning, same fix as roach): at the low densities a small predator
  // population runs at (~4–5 per basin), a 6 m range leaves survivors too sparse to find mates through the founding
  // cohort's old-age trough and breeding collapses into an extinction vortex; 8 m keeps pairs forming (pike parity)
  wanderRadius: 10,
  roostAnchored: true, // predator home-range pattern (fox/pike) — unanchored diffusion strands predators in prey deserts
  noRelocate: true, // TERRITORIAL LOCK (pike pattern): the roost is fixed for life. With relocation on, family clusters fragment
  // across the basin over ~10k ticks and low-density survivors end up too far apart to find mates → endgame extinction
  // (v0.12 stability forensics: a basin's last trout died alone at t≈16k with its roach base at full cap). Locked trout patrol
  // their home patch, travel only while hungry, and breed only at home (see troutDecide) — one stable family per basin.
  popCap: 10, // hard ceiling (pike pattern): the seeded population is up to six (three pairs, one per eligible swim-volume basin),
  // so the cap allows a handful of replacement individuals over a run. Every extra trout adds a full kill cycle to its basin's
  // predation pressure, and a basin's roach base only replaces ~N/4k ticks at N roach — above ~6–7 per basin the predator–prey
  // cycle's amplitude exceeds the prey buffer and the basin crashes (v0.12 stability forensics: seven trout in one basin drove
  // its roach to zero). Ten keeps each of the two basins at ~4–5 on average — enough that a same-sex remainder after an old-age
  // death cluster can't strand a basin's last trout mateless (v0.12 forensics: at cap 8 one basin's cluster collapsed to a lone
  // survivor and went extinct at t≈19k while its roach base sat at full health). Must stay above the seeded population or no
  // replacement breeding is ever allowed.
  foodSpecies: [], // carnivore — fish + waterline insects only
  preySpecies: ['roach', 'insect'],
  bodySize: [0.18, 0.12, 0.5], // world-space meters at mid size trait → rendered ~0.37–0.6 m long (a real trout)
  validTarget: aquaticValidTarget, // river-volume constraint (wander targets only — see aquatic.ts)
  settlePosition: aquaticSettle, // clamp back into the volume + seat at depth after every act
  decide: troutDecide,
};

registerSpecies(TROUT);

/**
 * Trout decision tick (pike pattern): hunt roach/waterline insects when hungry; otherwise breed — but only AT HOME
 * (within 3×wanderRadius of the roost) — or wander. The at-home breeding gate seals the territorial lock: a pair that
 * bred on a foraging trip would settle its offspring in the foreign patch and leak the lock across generations, until
 * low-density survivors are too far apart to find mates (v0.12 stability forensics). Prey pursuit is exempt from the
 * volume constraint — the settle hook clamps any move that dries out, so a trout can never end up on land.
 */
function troutDecide(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (!a.data) a.data = {};
  const d = a.data;

  // 1) Hungry → pursue the nearest reachable prey within sense radius (seekTroutPrey applies the reachability rules +
  //    bad-target cooldowns).
  if (a.energy / animalEnergyMax(a) < sp.hungerThreshold) {
    const best = seekTroutPrey(sim, a, sp, sp.senseRadius);
    if (best) {
      d.tx = best.pos.x;
      d.tz = best.pos.z;
      d.targetId = best.id;
      delete d.corpseTarget;
      a.state = ANIMAL_STATE_SEEK_FOOD;
      return;
    }
    // Nothing in kill range — steer toward the nearest reachable prey BEYOND sense radius instead of wandering blindly,
    // so a trout that drifts out of its prey patch finds its way back. Volume-validated steering (aquaticSteerToward)
    // follows the channel around meanders instead of clamping against them; one step partway toward the food per decision.
    const far = seekTroutPrey(sim, a, sp, sp.senseRadius * FORAGE_SEARCH_MULT);
    if (far) {
      const pt = aquaticSteerToward(sim, a, sp, far.pos.x, far.pos.z);
      if (pt) {
        d.tx = pt.x;
        d.tz = pt.z;
        delete d.targetId;
        delete d.corpseTarget;
        a.state = ANIMAL_STATE_WANDER;
        return;
      }
    }
  }

  // 2) Not hungry → try to breed with an opposite-sex partner in range (shared logic) — but only AT HOME. noRelocate
  // locks the wander roost, not breeding: a pair that bred on a foraging trip would settle its offspring in the foreign
  // patch and leak the territorial lock across generations (pike pattern).
  const dxh = d.roostX === undefined ? 0 : a.pos.x - d.roostX;
  const dzh = d.roostZ === undefined ? 0 : a.pos.z - d.roostZ;
  if (dxh * dxh + dzh * dzh <= 9 * sp.wanderRadius * sp.wanderRadius && canAttemptBreed(sim, a, sp) && attemptMate(sim, a, sp)) {
    a.state = ANIMAL_STATE_MATE;
    return;
  }

  // 3) Otherwise wander to a fresh random point (validTarget keeps it in the river volume).
  pickWanderTarget(sim, a, sp);
}

/**
 * Nearest REACHABLE prey within `radius` for a trout: roach anywhere in the SAME connected swim-volume component —
 * a fish behind a land barrier is unreachable no matter how close the straight line looks (steering at it loops against
 * the volume clamp until starvation while reachable roach swim on this side of the bank) — and insects only at the
 * waterline (within TROUT_INSECT_REACH above it): a trout never chases one upland, so such insects are skipped entirely.
 * Bad-target cooldowns apply: a target the trout recently clamped against is skipped for the window instead of re-chased.
 */
function seekTroutPrey(sim: Sim, a: Agent, sp: AnimalSpecies, radius: number): Agent | null {
  const myComp = riverComponentAt(sim, a.pos.x, a.pos.z); // the trout is always in the volume → ≥ 0
  let best: Agent | null = null;
  let bestD2 = Infinity;
  for (const id of sim.grid.query(a.pos.x, a.pos.z, radius)) {
    const p = sim.agentById(id);
    if (!p || p.id === a.id || p.energy <= 0) continue; // self is never food
    if (!sp.preySpecies?.includes(p.species)) continue;
    if (isBadTarget(a, sim, p.id)) continue; // recently clamped against — skip for the cooldown window
    const dx = p.pos.x - a.pos.x;
    const dz = p.pos.z - a.pos.z;
    const dist2 = dx * dx + dz * dz;
    if (dist2 > radius * radius) continue; // grid query is a cell superset — exact disc test
    if (p.species === 'insect') {
      // Waterline insects only: an insect sitting higher than the reach above the water line is skipped, not chased.
      if (sim.world.heightAt(p.pos.x, p.pos.z) >= sim.world.waterLevel + TROUT_INSECT_REACH) continue;
    } else {
      // A roach in another connected swim-volume component sits behind a land barrier — unreachable no matter how close
      // it looks. Steering at it loops against the volume clamp until starvation (v0.12 stability forensics).
      const pc = riverComponentAt(sim, p.pos.x, p.pos.z);
      if (pc !== -1 && pc !== myComp) continue;
    }
    if (dist2 < bestD2) {
      bestD2 = dist2;
      best = p;
    }
  }
  return best;
}
