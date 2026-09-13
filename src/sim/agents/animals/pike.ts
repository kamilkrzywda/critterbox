/**
 * Pike (PLAN roster, Phase 6). The river predator: lives only in the river volume (aquatic.ts) and hunts
 * CARP — its main diet — with hunger-gated pursuit + saturating intake (the fox pattern from base.ts),
 * plus the PLAN frog–pike interaction: it strikes FROGS at the water's edge. A pike never chases a frog
 * upland — the volume clamp would park it at the shore — so a frog is only targeted when its cell sits
 * within PIKE_FROG_STRIKE_SHALLOW above the water line (shallow water / shoreline); from there the strike
 * range (eatRange) covers the last meters out of the water. Behaviour comes from ./base.ts parameterized
 * by this table + per-agent traits; the two aquatic hooks (validTarget / settlePosition) keep it in the
 * water, and a clamped-against target is skipped for AQUATIC_BAD_TARGET_COOLDOWN ticks as a safety net.
 *
 * Traits (name / min / max / σ) — bounds clamp mutation; σ is the Gaussian sd applied at birth:
 *   speed       0.9 – 1.4    (σ 0.10)  move-speed multiplier — faster than EVERY carp (min pike 0.135 > max carp 0.104 m/tick)
 *   size        1.5 – 3.0    (σ 0.20)  body scale (rendering) + energy-capacity multiplier (~150–300 e store)
 *   metabolism  0.8 – 1.3    (σ 0.10)  drain-rate multiplier
 *   fertility   0.6 – 1.2    (σ 0.12)  breeding-cooldown divisor — must outpace the short lifespan min (9k < the 20k gate)
 *   lifespan    9000–20000   (σ 1200)  old-age death age in ticks (~5–11 min at 1×)
 */

import { registerSpecies } from '../../registry';
import type { AnimalSpecies } from './base';
import { FORAGE_SEARCH_MULT, animalEnergyMax, attemptMate, canAttemptBreed, pickWanderTarget } from './base';
import { aquaticSettle, aquaticSteerToward, aquaticValidTarget, isBadTarget, riverComponentAt } from './aquatic';
import type { Agent } from '../../types';
import { ANIMAL_STATE_MATE, ANIMAL_STATE_SEEK_FOOD, ANIMAL_STATE_WANDER } from '../../types';
import type { Sim } from '../../sim';

/** Meters above the water line a frog may sit and still be strikable (shallow water / shoreline). */
const PIKE_FROG_STRIKE_SHALLOW = 2; // the marsh band runs to +3 — pike strike the lower two-thirds of it

export const PIKE: AnimalSpecies = {
  id: 'pike',
  kind: 'animal',
  displayName: 'Pike',
  traits: {
    speed: { min: 0.9, max: 1.4, sigma: 0.1 },
    size: { min: 1.5, max: 3.0, sigma: 0.2 },
    metabolism: { min: 0.8, max: 1.3, sigma: 0.1 },
    fertility: { min: 0.6, max: 1.2, sigma: 0.12 },
    lifespan: { min: 9000, max: 20000, sigma: 1200 },
  },
  baseMetabolism: 0.06, // per tick at metabolism=1 — an efficient swimmer (Phase 6 stability tuning)
  moveCostPerMeter: 0.2,
  baseSpeed: 0.15, // m/tick at speed=1 (~4.5 m/s at 1×) — faster than every carp (max 0.104)
  senseRadius: 22, // wide forager — must find carp across the river on lean stretches (Phase 6 stability tuning)
  eatRange: 4, // strike range: the lunge that takes a carp in the water AND reaches a frog at the shoreline
  eatAmount: 30, // unused for prey — kills digest the victim's energy (kept for API symmetry with grazers)
  digestionEfficiency: 0.75,
  hungerThreshold: 0.5, // HUNTER GATE — lower than the fox's (0.8): carp breed ~3× slower than mice, so a pike must
  // coast long between meals or it strips local patches and starves when prey thins (Phase 6 stability tuning). The
  // long coast also lets satiation decay, so each meal pays more — the economy self-balances. At 0.6 the resulting
  // predator–prey cycle had an amplitude that drove the eastern carp to zero every ~15k ticks; at 0.5 the kill rate
  // drops ~20% and the equilibrium prey level (~12) sits safely above the crash point (Phase 6 stability forensics).
  maturityAge: 2400, // ~80 s juvenile phase at 1×
  breedEnergyFraction: 0.65,
  breedCooldownBase: 2400, // ÷ fertility → 2000–4000 ticks between spawns (must outpace the short lifespan min — Phase 6 stability tuning)
  matingRange: 8,
  wanderRadius: 14, // patrol the local river patch (validTarget keeps it in the volume)
  roostAnchored: true, // unanchored random-walk diffusion carried pike apart before they could breed (Phase 6 stability tuning — fox pattern)
  noRelocate: true, // TERRITORIAL LOCK — see the flag's doc in base.ts: with relocation on, the whole population converged on and stripped each surviving carp cluster in turn → extinction by t≈17k (Phase 6 stability forensics). Locked pike patrol their home cluster and only travel while hungry.
  popCap: 8, // hard ceiling on the population: every extra pike adds a full kill cycle (~1 per 1.5–2k ticks) to the
  // basin's predation pressure, and the eastern carp base only replaces ~N/4k ticks at N carp — above eight pikes the
  // predator–prey cycle's amplitude exceeds the prey buffer and the basin crashes (Phase 6 stability forensics:
  // 12-cap runs went extinct by t≈9k; eight + the 0.5 hunger gate keeps kills ≈ births with margin). Must stay
  // above the seeded population of six or no replacement breeding is ever allowed.
  foodSpecies: [], // carnivore — carp + waterline frogs only
  preySpecies: ['carp', 'frog'],
  bodySize: [0.22, 0.14, 0.9], // world-space meters at mid size trait → rendered ~0.68–1.13 m long (a real pike)
  validTarget: aquaticValidTarget, // river-volume constraint (wander targets only — see module header)
  settlePosition: aquaticSettle, // clamp back into the volume + seat at depth after every act
  decide: pikeDecide,
};

registerSpecies(PIKE);

/** Pike decision tick: carp (pursued in the water) or a strikable waterline frog when hungry, else breed/wander. */
function pikeDecide(sim: Sim, a: Agent, sp: AnimalSpecies): void {
  if (!a.data) a.data = {};
  const d = a.data;

  // 1) Hungry → pursue the nearest strikable prey within sense radius (a carp in the water, or a frog at the
  //    waterline already close enough to strike). Prey pursuit stays exempt from the volume constraint — but
  //    the settle hook clamps any move that dries out, so a pike can never end up on land.
  if (a.energy / animalEnergyMax(a) < sp.hungerThreshold) {
    const best = seekReachablePrey(sim, a, sp, sp.senseRadius);
    if (best) {
      d.tx = best.pos.x;
      d.tz = best.pos.z;
      d.targetId = best.id;
      delete d.corpseTarget;
      a.state = ANIMAL_STATE_SEEK_FOOD;
      return;
    }
    // Nothing strikable in kill range — steer toward the nearest reachable prey BEYOND sense radius instead
    // of wandering blindly (the generic decide's directional-foraging pattern) so a pike that drifts
    // down-channel finds its way back. The same reachability filter applies: an unreachable frog on a bank is
    // skipped, not chased — the nearest CARP beyond it is what gets steered toward (Phase 6 stability
    // forensics: a single nearest-prey search kept returning waterline frogs that the volume clamp made
    // uncatchable, and pikes starved beside them while carp swam 60 m away).
    const far = seekReachablePrey(sim, a, sp, sp.senseRadius * FORAGE_SEARCH_MULT);
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
    // No in-volume steer point (the channel doesn't open toward the food): fall through to a validated
    // wander — it keeps moving along the channel, and the next decision retries from there.
  }

  // 2) Not hungry → try to breed with an opposite-sex partner in range (shared logic) — but only AT HOME.
  // noRelocate locks the wander roost, not breeding: a pair that bred on a foraging trip would settle its
  // offspring in the foreign cluster and leak the territorial lock across generations (Phase 6 stability
  // forensics: death sites scattered across the basin = generational migration → convergence resumed).
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
 * Nearest REACHABLE prey within `radius`, via the spatial grid: a carp anywhere (it is always inside the
 * river volume, so reachable along the channel), or a frog only when strikable — at the waterline (within
 * PIKE_FROG_STRIKE_SHALLOW above it) AND already within eatRange+1 of the pike. The ambush rule: a pike never
 * chases a frog upland; chasing one parks it against the volume clamp and burns energy until starvation, so
 * such frogs are skipped entirely — the search continues to the next candidate instead (a carp 60 m away is
 * still found even when an uncatchable frog sits 8 m off). Bad-target cooldowns apply.
 */
function seekReachablePrey(sim: Sim, a: Agent, sp: AnimalSpecies, radius: number): Agent | null {
  const myComp = riverComponentAt(sim, a.pos.x, a.pos.z); // the pike is always in the volume → ≥ 0
  let best: Agent | null = null;
  let bestD2 = Infinity;
  for (const id of sim.grid.query(a.pos.x, a.pos.z, radius)) {
    const p = sim.agentById(id);
    if (!p || p.id === a.id || p.energy <= 0) continue; // self is never food
    if (p.species !== 'carp' && p.species !== 'frog') continue;
    if (isBadTarget(a, sim, p.id)) continue; // recently clamped against — skip for the cooldown window
    const dx = p.pos.x - a.pos.x;
    const dz = p.pos.z - a.pos.z;
    const dist2 = dx * dx + dz * dz;
    if (dist2 > radius * radius) continue; // grid query is a cell superset — exact disc test
    if (p.species === 'carp') {
      // A carp in another connected swim-volume component sits behind a land barrier — unreachable no matter
      // how close it looks. Steering at it loops against the volume clamp until starvation while reachable
      // carp swim on this side of the barrier (Phase 6 stability forensics, seed 1337).
      if (riverComponentAt(sim, p.pos.x, p.pos.z) !== myComp) continue;
    } else {
      const h = sim.world.heightAt(p.pos.x, p.pos.z);
      if (h >= sim.world.waterLevel + PIKE_FROG_STRIKE_SHALLOW) continue;
      const reach2 = (sp.eatRange + 1) * (sp.eatRange + 1); // +1 m margin for the frog moving before the strike lands
      if (dist2 > reach2) continue;
    }
    if (dist2 < bestD2) {
      bestD2 = dist2;
      best = p;
    }
  }
  return best;
}
