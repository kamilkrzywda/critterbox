/**
 * Aquatic checks (Phase 6): carp + pike live in the river volume. Covers (a) fish stay underwater over N
 * ticks on the REAL default world — every position over an underwater cell with y strictly between terrain
 * and water level; (b) a carp feeds on shore reed via grazePlant and the plant regrows afterwards; (c) a
 * controlled pike→carp kill (energy gain + corpse at the death); (d) a controlled pike strike on a frog at
 * the water's edge (the PLAN frog–pike interaction); (e) determinism — same seed+size → identical fish
 * populations and positions. Controlled scenarios run on a synthetic straight-river world so the geometry
 * is fully known; the underwater-invariant check runs on the real generated default world.
 */

export default {
  /** Over N ticks on the real default world, every fish sits over an underwater cell with y strictly
   *  between terrain and water level (and seeding placed them in deep cells); ducks stay in their zone. */
  fishStayUnderwater(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    const sim = new Sim(generateWorld({ seed: 1337, size: 300 }));
    seedLife(sim);

    const FISH = ['carp', 'pike', 'roach', 'trout']; // v0.12: the widened river food chain
    const fishAt = (t) => {
      const out = [];
      for (const a of sim.agents) if (FISH.includes(a.species)) out.push(a);
      return out;
    };

    // Seeding invariant: every seeded fish is over a DEEP cell (height < waterLevel − 1).
    const seeded = fishAt(0);
    ctx.check(`fishStayUnderwater: all river fish were seeded (${seeded.length} fish)`, seeded.length >= 80);
    let deepOk = true;
    for (const a of seeded) {
      if (sim.world.heightAt(a.pos.x, a.pos.z) >= sim.world.waterLevel - 1) deepOk = false;
    }
    ctx.check('fishStayUnderwater: every seeded fish is over a deep river cell', deepOk);

    // Over N ticks: after each step, every fish (incl. any born mid-run) is underwater at depth.
    const STEPS = 600;
    let violations = 0;
    for (let i = 1; i <= STEPS; i++) {
      sim.step();
      for (const a of fishAt(i)) {
        const h = sim.world.heightAt(a.pos.x, a.pos.z);
        if (!(h < sim.world.waterLevel && h < a.pos.y && a.pos.y < sim.world.waterLevel)) violations++;
      }
    }
    ctx.check(`fishStayUnderwater: all fish over underwater cells with terrain < y < waterLevel for ${STEPS} ticks`, violations === 0);

    // Ducks (v0.12) are semi-aquatic — they may be on land, but only inside their zone (river volume + shore band).
    let duckViolations = 0;
    for (const a of sim.agents) {
      if (a.species !== 'duck') continue;
      if (!ctx.sim.duckZone(sim, a.pos.x, a.pos.z)) duckViolations++;
    }
    ctx.check(`fishStayUnderwater: every duck stays in its zone after ${STEPS} ticks`, duckViolations === 0);
  },

  /** A hungry carp feeds on shore reed (grazing works) and the plant regrows afterwards. */
  carpFeedOnShoreReed(ctx) {
    const Sim = ctx.sim.Sim;
    const CARP = ctx.sim.carp;
    const world = riverWorld(60);

    const sim = new Sim(world);
    const reed = sim.addAgent('reed', 6, 0); // bank cell: h = 9.2 — within the carp's shore reach (water+3)
    reed.energy = 110; // full
    reed.state = 'fruiting';

    const carp = sim.addAgent('carp', 1, 0); // in the deep channel, ~5 m from the reed — within eatRange
    carp.sex = 'm';
    carp.traits = midTraits(CARP);
    carp.energy = 100; // hungry (capacity ~300) → forages from the first decision tick

    const energyBefore = carp.energy;
    let grazedAt = -1;
    for (let i = 0; i < 200 && reed.energy >= 110; i++) {
      sim.step();
      if (reed.energy < 110) { grazedAt = i + 1; break; }
    }
    ctx.check(`carpFeedOnShoreReed: the carp grazed the shore reed (${grazedAt} ticks)`, grazedAt > 0);
    ctx.check(
      `carpFeedOnShoreReed: the carp gained energy from grazing (${energyBefore.toFixed(1)} → ${carp.energy.toFixed(1)})`,
      carp.energy > energyBefore + 5,
    );

    // Keep biting until the reed drops below its regrowth floor (0.35 × 110 = 38.5) → REGROWTH state.
    let regrowAt = -1;
    for (let i = 0; i < 400 && reed.state !== 'regrowth'; i++) {
      sim.step();
      if (!sim.agents.includes(reed)) break; // the reed must not die of overgrazing in this scenario
      if (reed.state === 'regrowth') regrowAt = i + 1;
    }
    ctx.check(`carpFeedOnShoreReed: repeated grazing mows the reed back to regrowth (${regrowAt} ticks)`, regrowAt > 0);

    // The regrowing plant climbs back toward fruiting (growth = baseRate × fertility × light). Phase 7:
    // growth is light-gated and the check started at dawn (light ≈ 0), so jump the clock to near-noon
    // WITHOUT stepping any agent — positions/energy untouched, only the environment sample changes.
    while (ctx.sim.environment.lightAt(sim.stepCount) < 0.95) sim.stepCount++;

    const eAfterMow = reed.energy;
    for (let i = 0; i < 250; i++) sim.step();
    ctx.check(
      `carpFeedOnShoreReed: the mowed reed regrows (${eAfterMow.toFixed(1)} → ${reed.energy.toFixed(1)})`,
      reed.energy > eAfterMow + 20,
    );
  },

  /** Controlled scenario: a hungry pike kills an in-range carp (energy gain + corpse at the death). */
  pikeKillsCarp(ctx) {
    const Sim = ctx.sim.Sim;
    const PIKE = ctx.sim.pike;
    const CARP = ctx.sim.carp;
    const world = riverWorld(60);

    const sim = new Sim(world);
    const pike = sim.addAgent('pike', 0, 0); // deep channel
    pike.sex = 'f';
    pike.traits = midTraits(PIKE);
    pike.energy = 50; // far below the hunger gate (0.8 × ~225 capacity) → hunts from the first decision tick

    const carp = sim.addAgent('carp', 1, 0); // 1 m away — inside the strike range (4 m)
    carp.sex = 'm';
    carp.traits = midTraits(CARP);
    carp.energy = 100;

    let deathPos = null;
    const unsub = ctx.sim.animals.registerAnimalDeathHook((_s, a) => { if (a.species === 'carp') deathPos = { x: a.pos.x, z: a.pos.z }; });

    let killedAt = -1;
    for (let i = 0; i < 200 && sim.agents.includes(carp); i++) {
      sim.step();
      if (!sim.agents.includes(carp)) { killedAt = i + 1; break; }
    }
    unsub();

    ctx.check(`pikeKillsCarp: a hungry pike kills an in-range carp (${killedAt} ticks)`, killedAt > 0);
    ctx.check(`pikeKillsCarp: the pike gained energy from the kill (now ${pike.energy.toFixed(1)})`, pike.energy > 50 + 40);
    const corpse = sim.corpses.find((c) => c.originSpecies === 'carp');
    ctx.check('pikeKillsCarp: a corpse was spawned for the killed carp', !!corpse && corpse.mass > 0);
    if (deathPos && corpse) {
      const dx = corpse.pos.x - deathPos.x, dz = corpse.pos.z - deathPos.z;
      ctx.check(`pikeKillsCarp: the corpse sits at the death location (${Math.hypot(dx, dz).toFixed(2)} m off)`, Math.hypot(dx, dz) < 0.5);
    }
  },

  /** Controlled scenario: a pike strikes a frog standing at the water's edge (the PLAN frog–pike interaction). */
  pikeStrikesEdgeFrog(ctx) {
    const Sim = ctx.sim.Sim;
    const PIKE = ctx.sim.pike;
    const FROG = ctx.sim.frog;
    const world = riverWorld(60);

    const sim = new Sim(world);
    const pike = sim.addAgent('pike', 2.5, 0); // deep channel, ~3 m from the frog — inside strike range (4 m)
    pike.sex = 'f';
    pike.traits = midTraits(PIKE);
    pike.energy = 50; // hungry → hunts from the first decision tick

    const frog = sim.addAgent('frog', 5.5, 0); // bank cell: h = 8.9 — at the waterline (within +2 m of it)
    frog.sex = 'm';
    frog.traits = midTraits(FROG);
    frog.energy = 60;

    let killedAt = -1;
    for (let i = 0; i < 300 && sim.agents.includes(frog); i++) {
      sim.step();
      if (!sim.agents.includes(frog)) { killedAt = i + 1; break; }
    }

    ctx.check(`pikeStrikesEdgeFrog: the pike strikes a waterline frog (${killedAt} ticks)`, killedAt > 0);
    ctx.check(`pikeStrikesEdgeFrog: the pike gained energy from the strike (now ${pike.energy.toFixed(1)})`, pike.energy > 50 + 20);
    const corpse = sim.corpses.find((c) => c.originSpecies === 'frog');
    ctx.check('pikeStrikesEdgeFrog: a corpse was spawned for the struck frog', !!corpse && corpse.mass > 0);
  },

  /** Determinism: two sims from the same seed+size produce identical fish populations and positions. */
  aquaticDeterminism(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    const FISH = ['carp', 'pike', 'roach', 'trout']; // v0.12: the full river food chain
    const run = () => {
      const sim = new Sim(generateWorld({ seed: 2026, size: 300 }));
      seedLife(sim);
      for (let i = 0; i < 300; i++) sim.step();
      const out = {};
      for (const sp of FISH) {
        const list = [];
        for (const a of sim.agents) {
          if (a.species === sp) list.push([a.id, a.pos.x, a.pos.y, a.pos.z, a.energy]);
        }
        list.sort((u, v) => u[0] - v[0]);
        out[sp] = list;
      }
      return out;
    };

    const A = run();
    const B = run();
    ctx.check(`aquaticDeterminism: same seed → identical fish counts (carp ${A.carp.length}, pike ${A.pike.length}, roach ${A.roach.length}, trout ${A.trout.length})`,
      FISH.every((sp) => A[sp].length === B[sp].length && A[sp].length > 0));
    const same = (X, Y) => X.length === Y.length && X.every((row, i) => row.every((v, j) => v === Y[i][j]));
    for (const sp of FISH) {
      ctx.check(`aquaticDeterminism: identical ${sp} positions/energy across runs`, same(A[sp], B[sp]));
    }
  },

  /** Algae spread across open water over time ("flowing on water and just spreading around") — new patches
   *  appear, all stay in the water, and every patch sits at the surface. */
  algaeSpreadsInWater(ctx) {
    const Sim = ctx.sim.Sim;
    const ALGAE = ctx.sim.registry.speciesRegistry.get('algae');
    const world = riverWorld(60);

    const sim = new Sim(world);
    // Four mature patches spread across the deep channel (z=5 strip, well inside |x|<4).
    for (let i = 0; i < 4; i++) {
      const a = sim.addAgent('algae', -3 + i * 2, 5);
      a.energy = ALGAE.maxEnergy; // mature → fruiting-eligible from the first tick
      a.state = 'fruiting';
    }
    const countAt = () => sim.agents.filter((a) => a.species === 'algae').length;
    const before = countAt();

    const STEPS = 900; // ~30 s at 1× — enough for several self-seed draws per patch
    let violations = 0;
    for (let i = 1; i <= STEPS; i++) {
      sim.step();
      if (i % 50 === 0) {
        for (const a of sim.agents) {
          if (a.species !== 'algae') continue;
          const h = world.heightAt(a.pos.x, a.pos.z);
          // In water AND seated at the surface — the two invariants of an algae patch.
          if (!(h < world.waterLevel && Math.abs(a.pos.y - world.waterLevel) < 1e-6)) violations++;
        }
      }
    }

    ctx.check(`algaeSpreadsInWater: the mat spread (${before} → ${countAt()} patches in ${STEPS} ticks)`, countAt() > before);
    ctx.check('algaeSpreadsInWater: every patch stays in water at the surface', violations === 0);
  },

  /** Aquatic plants seat where their species dictates: algae/water lily float at the surface, pondweed on the floor. */
  aquaticPlantSeating(ctx) {
    const Sim = ctx.sim.Sim;
    const world = riverWorld(60); // deep channel floor h=4 for |x|<4, water level 8

    const sim = new Sim(world);
    const algae = sim.addAgent('algae', 1, 0);
    const pondweed = sim.addAgent('pondweed', 2, 0);
    const lily = sim.addAgent('waterlily', -1, 0);
    sim.step(); // one tick → updatePlant seats them per PlantSpecies.aquatic

    ctx.check(`aquaticPlantSeating: algae floats at the surface (y=${algae.pos.y})`, Math.abs(algae.pos.y - world.waterLevel) < 1e-6);
    ctx.check(`aquaticPlantSeating: water lily floats at the surface (y=${lily.pos.y})`, Math.abs(lily.pos.y - world.waterLevel) < 1e-6);
    ctx.check(`aquaticPlantSeating: pondweed anchors on the floor (y=${pondweed.pos.y}, floor h=4)`, Math.abs(pondweed.pos.y - 4) < 1e-6);
  },

  /** Two-tier diet: with in-water algae visible, a carp ignores the CLOSER shore reed — fallback food is only
   *  eaten when nothing primary is seen (the v0.12 fix for carp parking at the bank). */
  carpPrefersInWaterFood(ctx) {
    const Sim = ctx.sim.Sim;
    const CARP = ctx.sim.carp;
    const ALGAE = ctx.sim.registry.speciesRegistry.get('algae');
    const world = riverWorld(60);

    const sim = new Sim(world);
    // Reed on the bank (x=4.5 → h=8.3, within shore reach) at 3.5 m; algae in the channel (x=-3) at 4 m —
    // the reed is CLOSER, so only the tier rule can explain why the carp takes the algae instead.
    const reed = sim.addAgent('reed', 4.5, 0);
    reed.energy = 110;
    reed.state = 'fruiting';
    const algae = sim.addAgent('algae', -3, 0);
    algae.energy = ALGAE.maxEnergy;
    algae.state = 'fruiting';

    const carp = sim.addAgent('carp', 1, 0); // deep channel between the two foods
    carp.sex = 'm';
    carp.traits = midTraits(CARP);
    carp.energy = 100; // hungry (capacity ~300) → forages from the first decision tick

    const algaeBefore = algae.energy;
    let grazedAlgaeAt = -1;
    for (let i = 0; i < 250; i++) { // fixed horizon — nothing but the carp can touch this algae
      sim.step();
      if (algae.energy < algaeBefore) { grazedAlgaeAt = i + 1; break; }
    }
    ctx.check(`carpPrefersInWaterFood: the carp grazed the in-water algae (${grazedAlgaeAt} ticks)`, grazedAlgaeAt > 0);
    ctx.check(
      `carpPrefersInWaterFood: the closer shore reed was left untouched (energy ${reed.energy.toFixed(1)} of 110)`,
      reed.energy >= 110 - 1e-6,
    );
  },
};

/** A flat synthetic world with a straight river channel along x=0 (centered meters): deep floor h=4 for
 *  |x|<4, gentle banks rising from the water line (h=8 at x=±4) to meadow h=12 beyond x=±9. Water level 8. */
function riverWorld(size = 60) {
  const n = size * size;
  const heights = new Float32Array(n);
  const biomes = new Uint8Array(n);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const wx = x - size / 2 + 0.5; // cell centre in centered meters
      const ax = Math.abs(wx);
      let h, biome;
      if (ax < 4) { h = 4; biome = 0; } // deep channel floor — well below the water level
      else if (ax < 9) { h = 8 + (ax - 4) * 0.6; biome = 0; } // bank: rises from the water line to h=11 (marsh band)
      else { h = 12; biome = 1; } // meadow
      const i = z * size + x;
      heights[i] = h;
      biomes[i] = biome;
    }
  }
  return {
    seed: 7,
    size,
    width: size,
    depth: size,
    heights,
    biomes,
    waterLevel: 8,
    heightAt(x, z) {
      const i = Math.min(size - 1, Math.max(0, Math.floor(x + size / 2)));
      const j = Math.min(size - 1, Math.max(0, Math.floor(z + size / 2)));
      return heights[j * size + i];
    },
    biomeAt(x, z) {
      const i = Math.min(size - 1, Math.max(0, Math.floor(x + size / 2)));
      const j = Math.min(size - 1, Math.max(0, Math.floor(z + size / 2)));
      return biomes[j * size + i];
    },
  };
}

/** All traits at their midpoint — deterministic individuals for controlled tests. */
function midTraits(sp) {
  const t = {};
  for (const k of Object.keys(sp.traits)) {
    const d = sp.traits[k];
    t[k] = (d.min + d.max) / 2;
  }
  return t;
}
