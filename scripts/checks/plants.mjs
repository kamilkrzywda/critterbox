/**
 * Plant lifecycle checks: run the REAL sim headlessly on generated worlds. Covers determinism (same seed+size
 * → identical initial population and identical state after N steps), the growth→fruiting→graze→regrowth
 * cycle, senescence + overgrazing death, and per-species population sanity on a default world.
 */

export default {
  /** Same seed+size → byte-identical initial population AND identical per-agent state after N steps. */
  determinism(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    function signature(sim) {
      return sim.agents.map((a) => `${a.species}:${a.energy.toFixed(6)}:${a.state}`).join('|');
    }

    const SEED = 42, SIZE = 300, STEPS = 150;
    const a = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    seedLife(a);
    const b = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    seedLife(b);

    ctx.check('plants: same seed+size → identical initial population', signature(a) === signature(b));
    ctx.check(`plants: seeded a non-trivial population (${a.agents.length} agents)`, a.agents.length > 1000);

    for (let i = 0; i < STEPS; i++) { a.step(); b.step(); }
    ctx.check(`plants: identical per-agent energy+state after ${STEPS} steps`, signature(a) === signature(b));

    // A different seed must yield a different population.
    const c = new Sim(generateWorld({ seed: SEED + 1, size: SIZE }));
    seedLife(c);
    ctx.check('plants: different seed → different initial population', signature(a) !== signature(c));
  },

  /** A fruiting species reaches `fruiting`, a graze drops it to `regrowth`, and it recovers yield. */
  growthCycle(ctx) {
    const Sim = ctx.sim.Sim;
    const grazePlant = ctx.sim.grazePlant;
    const world = makeFlatMeadowWorld(50);

    const sim = new Sim(world);
    const plant = sim.addAgent('clover', 10, 10); // clover: maxEnergy 90, fruits at f≥0.8 (energy≥72)

    let stepsToFruit = -1;
    for (let i = 0; i < 2000 && plant.state !== 'fruiting'; i++) {
      sim.step();
      if (plant.state === 'fruiting') { stepsToFruit = i + 1; break; }
    }
    ctx.check(`plants: clover reaches fruiting within expected time (${stepsToFruit} ticks)`, stepsToFruit > 0 && stepsToFruit < 500);

    // Graze hard (below the regrowth floor but not to zero) → must enter regrowth.
    const before = plant.energy;
    grazePlant(plant, 60);
    ctx.check('plants: grazing below the floor triggers regrowth', plant.state === 'regrowth' && plant.energy < before);

    // It recovers yield by returning to fruiting.
    let recovered = false;
    for (let i = 0; i < 2000; i++) {
      sim.step();
      if (plant.state === 'fruiting') { recovered = true; break; }
    }
    ctx.check('plants: regrowing plant recovers yield (returns to fruiting)', recovered);
  },

  /** Old plants die by lifespan; a plant overgrazed to zero energy dies by starvation. */
  senescenceAndOvergraze(ctx) {
    const Sim = ctx.sim.Sim;
    const grazePlant = ctx.sim.grazePlant;
    const world = makeFlatMeadowWorld(50);

    // Old age: a grass one tick short of its lifespan dies within two steps.
    const sim1 = new Sim(world);
    const oldGrass = sim1.addAgent('grass', 5, 5, { age: 5400 - 1 }); // grass.lifespan = 5400
    sim1.step();
    ctx.check('plants: a senescent plant is still alive at its lifespan tick', sim1.agents.includes(oldGrass));
    sim1.step();
    ctx.check('plants: an old plant dies by lifespan (age > lifespan)', !sim1.agents.includes(oldGrass));

    // Starvation: drive a fresh plant to zero energy, then it dies on the next tick.
    const sim2 = new Sim(world);
    const fresh = sim2.addAgent('grass', 5, 5);
    grazePlant(fresh, 1000); // overgraze → energy 0
    ctx.check('plants: overgrazing drives a plant to zero energy', fresh.energy <= 0);
    sim2.step();
    ctx.check('plants: an overgrazed (zero-energy) plant dies by starvation', !sim2.agents.includes(fresh));
  },

  /** On a default world, every seeded biome contributes plants and all five species are present. */
  populationSanity(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    const sim = new Sim(generateWorld({ seed: 1337, size: 300 }));
    const stats = seedLife(sim);
    const pops = sim.populations();

    for (const sp of ['grass', 'clover', 'cranberry', 'reed', 'tree']) {
      ctx.check(`plants: default world seeds ${sp} (${pops[sp]?.count ?? 0})`, (pops[sp]?.count ?? 0) > 0);
    }
    ctx.check('plants: total population is in the few-thousand–20k target band', stats.total >= 1000 && stats.total <= 25000);

    // After a short run, populations only shrink (no reproduction yet) and stay sane.
    for (let i = 0; i < 60; i++) sim.step();
    const after = sim.populations();
    ctx.check('plants: population does not grow without reproduction', sim.agents.length <= stats.total);
    ctx.check('plants: grass still present after a short run', (after.grass?.count ?? 0) > 0);
  },
};

/** A flat, fully-meadow synthetic world (height above water everywhere) for controlled lifecycle tests. */
function makeFlatMeadowWorld(size) {
  const n = size * size;
  const heights = new Float32Array(n).fill(10); // well above the fixed water level (8 m)
  const biomes = new Uint8Array(n).fill(1); // BIOME_MEADOW
  return {
    seed: 7,
    size,
    width: size,
    depth: size,
    heights,
    biomes,
    waterLevel: 8,
    heightAt() { return 10; },
    biomeAt() { return 1; }, // meadow → fertility 1.2 (the richest biome)
  };
}
