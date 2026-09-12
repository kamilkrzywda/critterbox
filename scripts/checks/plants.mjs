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

  /**
   * Plant immutability (Bug-1 regression guard): after N sim steps on a generated world, EVERY plant that
   * was alive at t=0 must sit at its EXACT seeded position — byte-identical floats. Plants are strictly
   * static: their position is set once at seeding and no step pass may ever write it (movement/wander/
   * foraging logic applies to animals only). Fails if any plant's x/y/z drifts by even one ulp.
   */
  immutability(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    const SEED = 1337, SIZE = 200, STEPS = 4000;
    const sim = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    seedLife(sim);

    // Record every seeded plant's position (plants carry no sex/traits — animals do).
    const seeded = new Map();
    for (const a of sim.agents) {
      if (!a.sex && !a.traits) seeded.set(a.id, [a.pos.x, a.pos.y, a.pos.z]);
    }
    ctx.check(`plants: immutability — recorded ${seeded.size} seeded plants`, seeded.size > 1000);

    for (let i = 0; i < STEPS; i++) sim.step();

    let checked = 0, moved = 0;
    let firstMoved = null;
    for (const a of sim.agents) {
      const p0 = seeded.get(a.id);
      if (!p0) continue; // born after t=0 — a birth, not a move
      checked++;
      if (a.pos.x !== p0[0] || a.pos.y !== p0[1] || a.pos.z !== p0[2]) {
        moved++;
        if (!firstMoved) firstMoved = { id: a.id, species: a.species, from: p0, to: [a.pos.x, a.pos.y, a.pos.z] };
      }
    }
    ctx.check(`plants: immutability — all ${checked} surviving plants byte-identical after ${STEPS} steps (moved=${moved})`, moved === 0);
    if (firstMoved) console.error('  first moved plant:', JSON.stringify(firstMoved));

    // The run must have actually churned the population (deaths + seedling births), so a static result is
    // meaningful and not an artifact of a sim that never stepped.
    const nowPlants = new Set(sim.agents.filter((a) => !a.sex && !a.traits).map((a) => a.id));
    let deaths = 0, births = 0;
    for (const id of seeded.keys()) if (!nowPlants.has(id)) deaths++;
    for (const id of nowPlants) if (!seeded.has(id)) births++;
    ctx.check(`plants: immutability — run exercised the lifecycle (${deaths} deaths, ${births} births in ${STEPS} steps)`, deaths > 0 && births > 0);
  },

  /** On a default world, every seeded biome contributes plants and all five species are present. */
  populationSanity(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    const sim = new Sim(generateWorld({ seed: 1337, size: 300 }));
    const stats = seedLife(sim);
    const pops = sim.populations();

    const PLANTS = ['grass', 'clover', 'cranberry', 'reed', 'tree'];
    for (const sp of PLANTS) {
      ctx.check(`plants: default world seeds ${sp} (${pops[sp]?.count ?? 0})`, (pops[sp]?.count ?? 0) > 0);
    }
    ctx.check('plants: total population is in the few-thousand–20k target band', stats.total >= 1000 && stats.total <= 25000);

    // Phase 5: grazers disperse seeds (every consumer is a disperser — Sandfall dung-seed pattern), so plant
    // populations can now grow modestly; over a short run the total stays in a tight band of the seeded value.
    const initialPlantTotal = PLANTS.reduce((s, sp) => s + (stats.perSpecies[sp] ?? 0), 0);
    for (let i = 0; i < 60; i++) sim.step();
    const after = sim.populations();
    const plantTotal = PLANTS.reduce((s, sp) => s + (after[sp]?.count ?? 0), 0);
    ctx.check(`plants: seed dispersal keeps the total in a tight band (${plantTotal} vs seeded ${initialPlantTotal})`, plantTotal > initialPlantTotal * 0.9 && plantTotal <= initialPlantTotal * 1.25);
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
