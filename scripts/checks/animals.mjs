/**
 * Animal framework checks (Phase 4): run the REAL sim headlessly on generated worlds. Covers grazing
 * depletion + regrowth through a live mouse, breeding gates & inheritance (offspring bounds, sex ratio,
 * multi-generation trait drift), starvation/old-age death via the death hooks, the population cap, and
 * determinism (same seed+size → identical animal state after N steps for ALL five species).
 * Part B adds: insect pollination boosting plant yield/growth vs an unvisited control, deer tree-browsing
 * with regrowth (trees not killed by normal browsing), mice eating insects (prey removed + energy gained),
 * and per-species determinism across mouse/hare/hamster/deer/insect.
 */

export default {
  /** A mouse forced to eat one plant repeatedly depletes it into regrowth; removed from the patch, it recovers. */
  grazing(ctx) {
    const Sim = ctx.sim.Sim;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50);

    const sim = new Sim(world);
    const plant = sim.addAgent('grass', 10, 10);
    plant.energy = 100; // full fruiting grass (addAgent starts at the seedling fraction)
    plant.state = 'fruiting';

    const mouse = sim.addAgent('mouse', 10.3, 10); // within eatRange of the plant
    mouse.sex = 'f';
    mouse.traits = midTraits(MOUSE);
    mouse.energy = 20; // hungry → forages from the first decision tick

    const initialPlantEnergy = plant.energy;
    let regrowthAt = -1;
    for (let i = 0; i < 100 && plant.state !== 'regrowth'; i++) {
      sim.step();
      if (plant.state === 'regrowth') { regrowthAt = i + 1; break; }
    }
    ctx.check(`animals: repeated grazing depletes the plant into regrowth (${regrowthAt} ticks)`, regrowthAt > 0 && plant.energy < initialPlantEnergy);
    ctx.check('animals: digestion gave the mouse energy (it gained from eating)', mouse.energy > 30);

    // Move the mouse out of sense range, then the plant must recover its yield.
    mouse.pos.x = -20;
    let recovered = false;
    for (let i = 0; i < 500; i++) {
      sim.step();
      if (plant.state === 'fruiting') { recovered = true; break; }
    }
    ctx.check('animals: the grazed plant regrows and recovers yield (back to fruiting)', recovered && plant.energy > initialPlantEnergy * 0.7);
  },

  /** Eligible opposite-sex pairs breed; offspring traits stay in bounds; sex ratio ≈ 50/50 over many trials;
   * a multi-generation run shows bounded trait drift with variance > 0. */
  breeding(ctx) {
    const Sim = ctx.sim.Sim;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50);

    // --- an eligible pair produces an offspring ---------------------------------------------
    const sim = new Sim(world);
    makePair(sim, 0, 0, MOUSE);
    let bornAt = -1;
    for (let i = 0; i < 30 && sim.agents.length < 3; i++) {
      sim.step();
      if (sim.agents.length === 3) { bornAt = i + 1; break; }
    }
    ctx.check(`animals: eligible opposite-sex pair breeds within a few decision cycles (${bornAt} ticks)`, bornAt > 0 && bornAt <= 10);

    const baby = sim.agents.find((a) => a.id === 3);
    ctx.check('animals: offspring is a mouse with a sex', baby?.species === 'mouse' && (baby.sex === 'm' || baby.sex === 'f'));
    let inBounds = true;
    for (const k of Object.keys(MOUSE.traits)) {
      const d = MOUSE.traits[k];
      if (!(baby.traits[k] >= d.min && baby.traits[k] <= d.max)) inBounds = false;
    }
    ctx.check('animals: offspring traits all within species bounds', inBounds);
    ctx.check('animals: offspring spawns between its parents', Math.abs(baby.pos.x - 0.5) < 0.5 && Math.abs(baby.pos.z) < 0.5);

    // --- sex ratio over many seeded trials (dummy plants vary the baby id → the rng draw) -----
    const TRIALS = 80;
    let females = 0, bornTrials = 0;
    for (let t = 0; t < TRIALS; t++) {
      const s2 = new Sim(world);
      for (let i = 0; i <= t; i++) s2.addAgent('grass', -24, -24 + i * 0.05); // id offset per trial
      makePair(s2, 0, 0, MOUSE);
      const targetCount = t + 1 + 2 + 1; // dummies + parents + baby
      for (let i = 0; i < 30 && s2.agents.length < targetCount; i++) s2.step();
      const b = s2.agents.find((a) => a.species === 'mouse' && a.age <= 10);
      if (!b) continue; // no offspring this trial — counted as a failure below
      bornTrials++;
      if (b.sex === 'f') females++;
    }
    ctx.check(`animals: every seeded trial produced an offspring (${bornTrials}/${TRIALS})`, bornTrials === TRIALS);
    const ratio = bornTrials > 0 ? females / bornTrials : 1;
    ctx.check(`animals: sex ratio over ${TRIALS} trials ≈ 50/50 (${(ratio * 100).toFixed(0)}% female)`, Math.abs(ratio - 0.5) <= 0.25);

    // --- multi-generation run on a real world: drift exists and stays bounded -----------------
    const { generateWorld } = ctx.worldgen;
    const seedLife = ctx.sim.seedLife;
    const sim3 = new Sim(generateWorld({ seed: 99, size: 200 }));
    seedLife(sim3);
    const initialMice = sim3.agents.filter((a) => a.species === 'mouse').length;
    ctx.check(`animals: world seeds mice (${initialMice})`, initialMice > 10);

    for (let i = 0; i < 4500; i++) sim3.step();
    const mice = sim3.agents.filter((a) => a.species === 'mouse');
    ctx.check(`animals: mice survive the multi-generation run (${mice.length} after 4500 ticks, started ${initialMice})`, mice.length >= Math.max(8, initialMice / 3));

    const juveniles = mice.filter((a) => a.age < MOUSE.maturityAge).length;
    ctx.check(`animals: reproduction occurred in the run (${juveniles} juveniles alive)`, juveniles > 0);

    for (const k of Object.keys(MOUSE.traits)) {
      const d = MOUSE.traits[k];
      let sum = 0;
      for (const m of mice) sum += m.traits[k];
      const mean = sum / mice.length;
      let varSum = 0;
      for (const m of mice) {
        const dv = m.traits[k] - mean;
        varSum += dv * dv;
      }
      ctx.check(`animals: trait ${k} mean ${mean.toFixed(3)} stays inside [${d.min}, ${d.max}]`, mean >= d.min && mean <= d.max);
      ctx.check(`animals: trait ${k} variance > 0 (mutation drift exists)`, varSum / mice.length > 1e-6);
    }
  },

  /** An isolated mouse starves; a well-fed mouse at its lifespan dies by old age. Both via the death hooks. */
  death(ctx) {
    const Sim = ctx.sim.Sim;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50); // no plants → nothing to eat

    // --- starvation ---------------------------------------------------------------------------
    const sim1 = new Sim(world);
    let deadAge = -1, deadEnergy = -1;
    const unsub1 = ctx.sim.animals.registerAnimalDeathHook((_sim, a) => { deadAge = a.age; deadEnergy = a.energy; }); // Phase 5: hook receives (sim, agent)
    const hungry = sim1.addAgent('mouse', 0, 0);
    hungry.sex = 'f';
    hungry.traits = midTraits(MOUSE);
    hungry.energy = 3; // low → starves long before maturity or old age

    let steps = 0;
    while (sim1.agents.includes(hungry) && steps < 500) { sim1.step(); steps++; }
    unsub1();
    ctx.check(`animals: isolated mouse dies by starvation (${steps} ticks, energy ${deadEnergy.toFixed(2)})`, !sim1.agents.includes(hungry) && deadAge >= 0 && deadAge < MOUSE.maturityAge);

    // --- old age ---------------------------------------------------------------------------------
    const sim2 = new Sim(world);
    const L = MOUSE.traits.lifespan.min;
    const aged = sim2.addAgent('mouse', 0, 0);
    aged.sex = 'm';
    aged.traits = { ...midTraits(MOUSE), lifespan: L }; // shortest possible lifespan
    aged.age = L - 1; // one tick short of old age
    aged.energy = 95; // well fed — must die of OLD AGE, not starvation

    let oldDead = null;
    const unsub2 = ctx.sim.animals.registerAnimalDeathHook((_sim, a) => { if (a.id === aged.id) oldDead = { age: a.age, energy: a.energy }; }); // Phase 5: hook receives (sim, agent)
    sim2.step(); // age → L: still alive at its lifespan tick
    ctx.check('animals: an animal at its lifespan tick is still alive', sim2.agents.includes(aged));
    sim2.step(); // age → L+1 > L: old-age death
    unsub2();
    ctx.check(`animals: a fed mouse dies by old age (age ${oldDead?.age} > lifespan ${L}, energy ${oldDead?.energy?.toFixed(1)})`, !sim2.agents.includes(aged) && oldDead !== null && oldDead.age > L && oldDead.energy > 0);
  },

  /** Breeding attempts at/above the population cap produce no offspring beyond it. */
  popCap(ctx) {
    const Sim = ctx.sim.Sim;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50);
    const origCap = MOUSE.popCap;
    const origCooldown = MOUSE.breedCooldownBase;
    MOUSE.popCap = 6; // one above the starting population → exactly one more can be born
    MOUSE.breedCooldownBase = 50; // short cooldown so attempts resume while AT the cap (gate under test)
    try {
      const sim = new Sim(world);
      const sexes = ['m', 'f', 'm', 'f', 'm'];
      for (let i = 0; i < 5; i++) {
        const a = sim.addAgent('mouse', i * 0.8, 0); // clustered → constant breeding pressure
        a.sex = sexes[i];
        a.traits = midTraits(MOUSE);
        a.age = 1000;
        a.energy = 95;
      }

      let maxSeen = 0, reachedCap = false;
      for (let i = 0; i < 300; i++) {
        sim.step();
        const c = sim.agents.length;
        if (c > maxSeen) maxSeen = c;
        if (c >= MOUSE.popCap) reachedCap = true;
      }
      ctx.check(`animals: population reaches the cap then never exceeds it (max seen ${maxSeen} of cap ${MOUSE.popCap})`, reachedCap && maxSeen <= MOUSE.popCap);

      // Whitebox: with two fed adults forced together, tryBreed refuses AT the cap and passes one above.
      const m1 = sim.agents.find((a) => a.sex === 'm');
      const f1 = sim.agents.find((a) => a.sex === 'f' && a.id !== m1.id);
      m1.pos.x = 0; m1.pos.z = 0;
      f1.pos.x = 0.5; f1.pos.z = 0;
      m1.energy = 95; f1.energy = 95;
      if (m1.data) delete m1.data.lastBreedStep; // clear cooldowns so ONLY the cap gate is in play
      if (f1.data) delete f1.data.lastBreedStep;
      ctx.check('animals: tryBreed refuses at the population cap', ctx.sim.animals.tryBreed(sim, m1, f1, MOUSE) === false);
      MOUSE.popCap = 7; // one above → the same pair now breeds (proves the cap was the blocking gate)
      const before = sim.agents.length;
      ctx.check('animals: raising the cap by one lets tryBreed through', ctx.sim.animals.tryBreed(sim, m1, f1, MOUSE) === true && sim.agents.length === before + 1);
    } finally {
      MOUSE.popCap = origCap;
      MOUSE.breedCooldownBase = origCooldown;
    }
  },

  /** An insect visiting a flowering plant boosts its yield/growth vs an unvisited control (deterministic). */
  pollination(ctx) {
    const Sim = ctx.sim.Sim;
    const pollinatePlant = ctx.sim.pollinatePlant;
    const world = flatMeadowWorld(50);

    // --- growing plants: a visited one outgrows an unvisited control ---------------------------
    const sim = new Sim(world);
    const ctrl = sim.addAgent('grass', 10, 10);
    ctrl.energy = 50; ctrl.state = 'growing';
    const test = sim.addAgent('grass', -10, 10); // far away — no animals here, so no cross-interaction
    test.energy = 50; test.state = 'growing';

    ctx.check('animals: pollinatePlant applies the boost to a growing plant', pollinatePlant(sim, test) === true);
    ctx.check('animals: an immediate second pollination is on cooldown', pollinatePlant(sim, test) === false);
    const s2 = new Sim(world);
    const seedling = s2.addAgent('grass', 0, 0); // addAgent starts at the seedling stage
    ctx.check('animals: pollinating a seedling is refused (not flowering yet)', pollinatePlant(s2, seedling) === false);

    for (let i = 0; i < 60; i++) sim.step();
    ctx.check(`animals: the visited growing plant outgrows the control after 60 ticks (${test.energy.toFixed(1)} vs ${ctrl.energy.toFixed(1)})`, test.energy > ctrl.energy);

    // --- fruiting plants: a pollinated one keeps setting fruit while an unvisited one holds -----
    const sim3 = new Sim(world);
    const fCtrl = sim3.addAgent('grass', 10, 10);
    fCtrl.energy = 90; fCtrl.state = 'fruiting';
    const fTest = sim3.addAgent('grass', -10, 10);
    fTest.energy = 90; fTest.state = 'fruiting';
    ctx.check('animals: pollinatePlant applies the boost to a fruiting plant', pollinatePlant(sim3, fTest) === true);

    for (let i = 0; i < 60; i++) sim3.step();
    ctx.check(`animals: the visited fruiting plant gains yield while the control holds (${fTest.energy.toFixed(1)} vs ${fCtrl.energy.toFixed(1)})`, fTest.energy > fCtrl.energy);
  },

  /** A deer browsing a tree depletes it into regrowth; left alone, the tree recovers — not killed. */
  deerBrowse(ctx) {
    const Sim = ctx.sim.Sim;
    const DEER = ctx.sim.deer;
    const world = flatForestWorld(50); // forest biome → fertility 1.0

    const sim = new Sim(world);
    const tree = sim.addAgent('tree', 10, 10);
    tree.energy = 400; // full canopy (addAgent starts at the seedling fraction)
    tree.state = 'fruiting';

    const deer = sim.addAgent('deer', 10.5, 10); // within eatRange (1.5) of the tree
    deer.sex = 'f';
    deer.traits = midTraits(DEER);
    deer.energy = 200; // hungry → forages from the first decision tick

    let regrowthAt = -1;
    for (let i = 0; i < 200 && tree.state !== 'regrowth'; i++) {
      sim.step();
      if (!sim.agents.includes(tree)) break; // browsing must not kill the tree in this session
      if (tree.state === 'regrowth') regrowthAt = i + 1;
    }
    ctx.check(`animals: deer browsing depletes the tree into regrowth (${regrowthAt} ticks, energy ${tree.energy.toFixed(0)}/400)`, regrowthAt > 0 && sim.agents.includes(tree) && tree.energy < 280);

    // The browser leaves (removed so it cannot re-browse during recovery); the tree must recover.
    sim.killAgent(deer);
    let recovered = false;
    for (let i = 0; i < 1500; i++) {
      sim.step();
      if (!sim.agents.includes(tree)) break;
      if (tree.state === 'fruiting') { recovered = true; break; }
    }
    ctx.check('animals: the browsed tree regrows and recovers yield (back to fruiting)', recovered && tree.energy >= 280);
    ctx.check('animals: normal browsing did not kill the tree', sim.agents.includes(tree));
  },

  /** A mouse feeding on an insect gains energy and the insect is removed (prey death hook fires). */
  miceEatInsects(ctx) {
    const Sim = ctx.sim.Sim;
    const MOUSE = ctx.sim.mouse;
    const INSECT = ctx.sim.insect;
    const world = flatMeadowWorld(50); // no plants → the insect is the only food

    const sim = new Sim(world);
    let preyDeathSeen = null;
    const unsub = ctx.sim.animals.registerAnimalDeathHook((_sim, a) => { if (a.species === 'insect') preyDeathSeen = a.id; }); // Phase 5: hook receives (sim, agent)

    const bug = sim.addAgent('insect', 10, 10);
    bug.sex = 'm';
    bug.traits = midTraits(INSECT);
    bug.energy = 25;

    const mouse = sim.addAgent('mouse', 10.3, 10); // within eatRange (1.0) of the insect
    mouse.sex = 'f';
    mouse.traits = midTraits(MOUSE);
    mouse.energy = 20; // hungry → forages from the first decision tick

    const energyBefore = mouse.energy;
    let eatenAt = -1;
    for (let i = 0; i < 60 && sim.agents.includes(bug); i++) {
      sim.step();
      if (!sim.agents.includes(bug)) { eatenAt = i + 1; break; }
    }
    unsub();
    ctx.check(`animals: a mouse feeding on an insect removes it (${eatenAt} ticks)`, eatenAt > 0);
    ctx.check('animals: the prey death hook fired for the eaten insect', preyDeathSeen === bug.id);
    ctx.check(`animals: the mouse gained energy from the insect (${energyBefore.toFixed(1)} → ${mouse.energy.toFixed(1)})`, mouse.energy > energyBefore + 5);
    ctx.check('animals: population counts reflect the predation (insect at 0)', (sim.popCounts.get('insect') ?? 0) === 0);
  },

  /** After N steps every moved animal's stored heading matches its actual last displacement direction —
   * the renderer turns instances by this value (render/animals.ts), so a stale or wrong heading reads as
   * animals facing sideways/backwards. Well-fed mice on an empty meadow wander only, changing direction
   * every decision tick, which exercises both "heading follows movement" and "kept while idle". */
  heading(ctx) {
    const Sim = ctx.sim.Sim;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50);

    const sim = new Sim(world);
    const animals = [];
    for (let i = 0; i < 6; i++) {
      const a = sim.addAgent('mouse', -10 + i * 4, 5);
      a.sex = i % 2 === 0 ? 'f' : 'm';
      a.traits = midTraits(MOUSE);
      a.energy = 95; // above the hunger gate → pure wander (age < maturityAge blocks breeding)
      animals.push(a);
    }

    const lastMove = new Map(); // id -> {dx, dz} of the most recent tick the animal actually moved
    let movingTicks = 0;
    for (let i = 0; i < 120; i++) {
      const before = new Map(animals.map((a) => [a.id, { x: a.pos.x, z: a.pos.z }]));
      sim.step();
      for (const a of animals) {
        if (!sim.agents.includes(a)) continue; // can't happen at this energy in 120 ticks — be safe anyway
        const b = before.get(a.id);
        const dx = a.pos.x - b.x;
        const dz = a.pos.z - b.z;
        if (dx * dx + dz * dz > 1e-6) {
          lastMove.set(a.id, { dx, dz });
          movingTicks++;
        }
      }
    }

    ctx.check(`heading: animals actually moved during the run (${movingTicks} moving ticks over ${animals.length} mice)`, movingTicks >= 50);

    let checked = 0;
    let maxErr = 0;
    for (const a of animals) {
      const mv = lastMove.get(a.id);
      if (!mv || a.data?.heading === undefined) continue; // never moved → nothing to verify
      const moveAng = Math.atan2(mv.dz, mv.dx);
      const err = Math.abs(normAngle(a.data.heading - moveAng));
      maxErr = Math.max(maxErr, err);
      if (err >= 0.2) {
        ctx.check(`heading: mouse ${a.id} heading ${a.data.heading.toFixed(3)} vs last movement direction ${moveAng.toFixed(3)} rad`, false);
        return; // report the first offender and stop
      }
      checked++;
    }
    ctx.check(`heading: every moved animal's heading matches its last displacement (n=${checked}, max err ${maxErr.toFixed(4)} rad < 0.2)`, checked >= 4 && maxErr < 0.2);
  },

  /** Same seed+size → identical initial animal state AND identical per-animal state after N steps,
   * for ALL five species (positions/energy/traits/sex). */
  determinism(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;
    const ANIMALS = ['mouse', 'hare', 'hamster', 'deer', 'insect'];

    function animalSig(sim) {
      return sim.agents
        .filter((a) => ANIMALS.includes(a.species))
        .map((a) => `${a.id}:${a.species}:${a.sex}:${a.pos.x.toFixed(4)},${a.pos.z.toFixed(4)}:${a.energy.toFixed(6)}:${a.state}:${JSON.stringify(a.traits)}`)
        .join('|');
    }

    const SEED = 7, SIZE = 300, STEPS = 300;
    const a = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    seedLife(a);
    const b = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    seedLife(b);

    ctx.check('animals: same seed+size → identical initial animal state (positions/energy/traits/sex)', animalSig(a) === animalSig(b));
    for (const sp of ANIMALS) {
      const n = a.agents.filter((x) => x.species === sp).length;
      ctx.check(`animals: default world seeds ${sp} (${n})`, n > 0);
    }

    for (let i = 0; i < STEPS; i++) { a.step(); b.step(); }
    ctx.check(`animals: identical per-animal state after ${STEPS} steps (all five species)`, animalSig(a) === animalSig(b));
    for (const sp of ANIMALS) {
      const ca = a.agents.filter((x) => x.species === sp).length;
      const cb = b.agents.filter((x) => x.species === sp).length;
      ctx.check(`animals: ${sp} count identical after ${STEPS} steps (${ca})`, ca === cb);
    }

    const c = new Sim(generateWorld({ seed: SEED + 1, size: SIZE }));
    seedLife(c);
    ctx.check('animals: different seed → different initial animal state', animalSig(a) !== animalSig(c));
  },
};

/** A flat, fully-meadow synthetic world (height above water everywhere) for controlled lifecycle tests. */
function flatMeadowWorld(size) {
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

/** A flat, fully-forest synthetic world for tree-browsing tests (fertility 1.0). */
function flatForestWorld(size) {
  const n = size * size;
  const heights = new Float32Array(n).fill(10); // well above the fixed water level (8 m)
  const biomes = new Uint8Array(n).fill(3); // BIOME_FOREST
  return {
    seed: 7,
    size,
    width: size,
    depth: size,
    heights,
    biomes,
    waterLevel: 8,
    heightAt() { return 10; },
    biomeAt() { return 3; }, // forest → fertility 1.0
  };
}

/** All traits at their midpoint — deterministic parents for inheritance math. */
function midTraits(sp) {
  const t = {};
  for (const k of Object.keys(sp.traits)) {
    const d = sp.traits[k];
    t[k] = (d.min + d.max) / 2;
  }
  return t;
}

/** Wrap an angle difference into [−π, π]. */
function normAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** A mature, well-fed opposite-sex pair at (x,z)/(x+1,z). */
function makePair(sim, x, z, MOUSE) {
  const m = sim.addAgent('mouse', x, z);
  m.sex = 'm';
  m.traits = midTraits(MOUSE);
  m.age = 1000; // > maturityAge (600)
  m.energy = 95; // ≥ breedEnergyFraction × capacity

  const f = sim.addAgent('mouse', x + 1, z);
  f.sex = 'f';
  f.traits = midTraits(MOUSE);
  f.age = 1000;
  f.energy = 95;
}
