/**
 * Flight checks (v0.13): birds fly in BURSTS — up to MAX_FLIGHT_BURST consecutive airborne ticks per takeoff,
 * then REST_TICKS forced on the ground even while still seeking/wandering; ducks mostly swim with occasional
 * short flights to far food; and flying costs more energy per meter than walking. Covers (a) the stork/crow/owl
 * invariants over N ticks on the REAL default world — airborne a healthy fraction (>40%) of their seek/wander
 * ticks, they actually rest (grounded while seeking), and never airborne during eat/mate/idle; (b) the duck
 * pattern — it flies only while seeking a FAR target, that happens (>0) but stays a minority of its far-foraging
 * ticks, and it never flies while eating; (c) a controlled synthetic-world scenario proving a flying bird's
 * per-meter energy cost is ~FLIGHT_COST_MULT× its walking cost, with the burst/rest cycle visible in the same
 * run. The invariant + duck checks run on the real generated default world (seed 1337); the cost check runs on
 * a flat synthetic world so movement is unobstructed and the metabolism term can be subtracted analytically.
 */

export default {
  /** Over N ticks on the real default world, stork/crow/owl are airborne a healthy fraction (>40%) of their
   *  seek/wander ticks (burst flight: ~90 fly / ~61 ground per cycle), they do actually rest while seeking, and
   *  never fly during eat/mate/idle — the render reads data.flying to lift + flap the body. */
  birdsFlyWhileForaging(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    const sim = new Sim(generateWorld({ seed: 1337, size: 300 }));
    seedLife(sim);

    const FLYERS = ['stork', 'crow', 'owl']; // default gate: wants to fly while seeking food or wandering
    const STEPS = 600;

    let seekWanderTicks = 0, airborneTicks = 0, groundedSeekTicks = 0, flyWhileGroundedState = 0;
    for (let i = 1; i <= STEPS; i++) {
      sim.step();
      for (const a of sim.agents) {
        if (!FLYERS.includes(a.species)) continue;
        const flying = !!a.data?.flying;
        const seeking = a.state === 'seekFood' || a.state === 'wander';
        if (flying && !seeking) flyWhileGroundedState++; // must stay 0 — never airborne in eat/mate/idle
        if (!seeking) continue;
        seekWanderTicks++;
        if (flying) airborneTicks++; else groundedSeekTicks++;
      }
    }
    const frac = seekWanderTicks > 0 ? airborneTicks / seekWanderTicks : 0;
    ctx.check(`birdsFlyWhileForaging: stork/crow/owl airborne a healthy fraction of seek/wander ticks (${(100 * frac).toFixed(1)}% over ${STEPS} ticks)`, frac > 0.4);
    ctx.check(`birdsFlyWhileForaging: birds actually rest — grounded while seeking/wandering (${groundedSeekTicks} ticks)`, groundedSeekTicks > 0);
    ctx.check('birdsFlyWhileForaging: never airborne during eat/mate/idle', flyWhileGroundedState === 0);
  },

  /** Over the same real-world run, a duck flies only while seeking a FAR target (>~6 m): it happens at least
   *  once, stays under half of its far-foraging ticks (mostly swims/walks), and never occurs while eating. */
  ducksFlyToFarFood(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;

    const sim = new Sim(generateWorld({ seed: 1337, size: 300 }));
    seedLife(sim);

    const FAR = 6; // must match DUCK_FLIGHT_MIN_DIST in duck.ts (the "far food" threshold)
    const STEPS = 900;

    let farSeekTicks = 0; // duck in seekFood with its target > FAR m away
    let flyingFarTicks = 0; // of those, ticks where the duck was actually airborne
    let flyWhileEat = 0; // must stay 0 — ducks never fly while eating
    for (let i = 1; i <= STEPS; i++) {
      sim.step();
      for (const a of sim.agents) {
        if (a.species !== 'duck') continue;
        const flying = !!a.data?.flying;
        if (a.state === 'eat' && flying) flyWhileEat++;
        if (a.state === 'seekFood' && a.data && a.data.tx !== undefined && a.data.tz !== undefined) {
          const d = Math.hypot(a.data.tx - a.pos.x, a.data.tz - a.pos.z);
          if (d > FAR) {
            farSeekTicks++;
            if (flying) flyingFarTicks++;
          }
        }
      }
    }

    ctx.check(`ducksFlyToFarFood: ducks flew to far food at least once (${flyingFarTicks}/${farSeekTicks} far-seek ticks over ${STEPS})`,
      farSeekTicks > 0 && flyingFarTicks > 0);
    ctx.check(`ducksFlyToFarFood: duck flight is a minority of far-foraging (<50%): ${flyingFarTicks}/${farSeekTicks}`,
      farSeekTicks === 0 || flyingFarTicks / farSeekTicks < 0.5);
    ctx.check('ducksFlyToFarFood: ducks never fly while eating', flyWhileEat === 0);
  },

  /** Controlled scenario on a flat synthetic world: a hungry, foodless crow wanders (→ flies in bursts) for N
   *  ticks spanning several full burst+rest cycles. Metabolism over the exact run is subtracted analytically and
   *  grounded meters are charged at walking cost — the residual per-meter cost of the AIRBORNE meters equals
   *  moveCostPerMeter × FLIGHT_COST_MULT, i.e. ~1.6× the walking cost of the same species. */
  flyingCostsMorePerMeter(ctx) {
    const Sim = ctx.sim.Sim;
    const CROW = ctx.sim.crow;
    const envMod = ctx.sim.environment;
    const world = flatWorld(80);

    const sim = new Sim(world);
    const bird = sim.addAgent('crow', 0, 0);
    bird.sex = 'm';
    bird.traits = midTraits(CROW); // every trait at its midpoint → deterministic speed/metabolism/size
    bird.age = 100; // immature (< maturityAge 1200) → never breeds → stays foraging/wandering the whole run
    bird.energy = 95; // below the hunger gate (0.8 × ~125 capacity) → forages from the first tick

    const N = 400; // spans several full cycles (~90 airborne + ~61 grounded ticks each)
    let flyDist = 0, walkDist = 0;
    let px = bird.pos.x, pz = bird.pos.z;
    const e0 = bird.energy;
    for (let i = 0; i < N; i++) {
      sim.step();
      const stepDist = Math.hypot(bird.pos.x - px, bird.pos.z - pz);
      if (stepDist > 1e-9) {
        // data.flying is the end-of-tick value — on this foodless flat world it equals the mode the tick's move used.
        if (bird.data?.flying) flyDist += stepDist; else walkDist += stepDist;
      }
      px = bird.pos.x; pz = bird.pos.z;
    }
    const dE = e0 - bird.energy;

    // Metabolism over the exact N ticks (env sampled at stepCount 0..N-1, see Sim.step) — subtract it so only
    // movement cost remains. Same species/traits/env as the flying bird → identical per-tick drain.
    let metab = 0;
    for (let s = 0; s < N; s++) {
      metab += CROW.baseMetabolism * bird.traits.metabolism * envMod.sampleEnvironment(world.seed, s).metabolismMult;
    }

    // Grounded meters pay exactly moveCostPerMeter (moveToward); whatever is left after metabolism + walking cost
    // was spent on the airborne meters → their per-meter premium.
    const perMeterFlying = (dE - metab - CROW.moveCostPerMeter * walkDist) / flyDist;
    const walkPerMeter = CROW.moveCostPerMeter; // ground cost — what moveToward charges when not flying

    ctx.check(`flyingCostsMorePerMeter: the crow flew a real distance AND rested (${flyDist.toFixed(1)} m airborne, ${walkDist.toFixed(1)} m grounded in ${N} ticks)`,
      flyDist > 5 && walkDist > 0);
    ctx.check(
      `flyingCostsMorePerMeter: flying costs more per meter than walking (fly ${perMeterFlying.toFixed(3)} vs walk ${walkPerMeter.toFixed(3)})`,
      perMeterFlying > walkPerMeter * 1.3,
    );
    ctx.check(
      `flyingCostsMorePerMeter: the flight premium is ~${ctx.sim.animals.FLIGHT_COST_MULT}× (measured ${(perMeterFlying / walkPerMeter).toFixed(2)}×)`,
      perMeterFlying > walkPerMeter * 1.3 && perMeterFlying < walkPerMeter * 2.0,
    );
  },
};

/** A flat synthetic world: constant height, no water — unobstructed movement so the cost check is clean. */
function flatWorld(size = 80) {
  const n = size * size;
  const heights = new Float32Array(n);
  const biomes = new Uint8Array(n);
  for (let i = 0; i < n; i++) { heights[i] = 10; biomes[i] = 1; } // flat meadow at h=10, well above the water level
  return {
    seed: 7,
    size,
    width: size,
    depth: size,
    heights,
    biomes,
    waterLevel: -5, // far below the terrain → nothing is underwater
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
