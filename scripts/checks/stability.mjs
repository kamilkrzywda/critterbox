/**
 * Long-run population-stability harness (Phase 5 ACCEPTANCE GATE, PLAN "Testing & verification"): a
 * headless run of the FULL sim on the default world (seed 1337, 300×300) for ≥20,000 unpaused real
 * step() calls. Asserts that every core species — all plants AND all animals incl. the Phase 5 frogs and
 * predators — has population > 0 at the end and never hits 0 after a warm-up window (first 500 steps),
 * with per-species min ≥ 1, animal max ≤ popCap, and plant growth bounded (seed dispersal is capped by
 * the herbivore base). Prints a per-species min/max/avg + final-count stability report.
 */

export default {
  longRun(ctx) {
    const { generateWorld } = ctx.worldgen;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;
    const registry = ctx.sim.registry.speciesRegistry;

    const SEED = 1337, SIZE = 300, STEPS = 20000, WARMUP = 500;

    const sim = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    const seeded = seedLife(sim);
    const speciesIds = [...registry.keys()]; // all plants + animals, in registration order
    const caps = {};
    for (const id of speciesIds) {
      const sp = registry.get(id);
      if (sp.kind === 'animal') caps[id] = sp.popCap;
    }

    const stats = new Map(speciesIds.map((s) => [s, { min: Infinity, max: 0, sum: 0, n: 0 }]));
    const t0 = Date.now();
    for (let i = 1; i <= STEPS; i++) {
      sim.step();
      if (i >= WARMUP) {
        for (const sp of speciesIds) {
          const c = sim.popCounts.get(sp) ?? 0;
          const st = stats.get(sp);
          if (c < st.min) st.min = c;
          if (c > st.max) st.max = c;
          st.sum += c;
          st.n++;
        }
      }
    }
    const msPerTick = (Date.now() - t0) / STEPS;

    // --- stability report (part of the Phase 5 deliverable) ------------------------------------------
    console.log(`\n=== stability report: seed ${SEED}, ${SIZE}×${SIZE}, ${STEPS} steps, warm-up ${WARMUP} — ${msPerTick.toFixed(2)} ms/tick ===`);
    for (const sp of speciesIds) {
      const st = stats.get(sp);
      const finalC = sim.popCounts.get(sp) ?? 0;
      const cap = caps[sp] !== undefined ? ` cap=${caps[sp]}` : '';
      console.log(`${sp.padEnd(10)} min=${String(st.min).padStart(6)} max=${String(st.max).padStart(7)} avg=${(st.sum / st.n).toFixed(1).padStart(8)} final=${finalC}${cap}`);
    }

    // --- assertions ------------------------------------------------------------------------------------
    for (const sp of speciesIds) {
      const st = stats.get(sp);
      const finalC = sim.popCounts.get(sp) ?? 0;
      ctx.check(`stability: ${sp} never extinct after warm-up (min ${st.min})`, st.min >= 1);
      ctx.check(`stability: ${sp} alive at the end (${finalC})`, finalC > 0);
      if (caps[sp] !== undefined) {
        ctx.check(`stability: ${sp} max population ${st.max} ≤ popCap ${caps[sp]}`, st.max <= caps[sp]);
      } else {
        // Plants have no cap — but seed dispersal is bounded by the capped herbivore base + the same-species
        // exclusion radius (carrying capacity), so growth must stay sane. Trees legitimately spread via deer
        // browsing, so the bound is generous (8×) with a small floor for rare species.
        const initial = seeded.perSpecies[sp] ?? 0;
        ctx.check(`stability: ${sp} (plant) max ${st.max} stays within 8× its seeded count (${initial})`, st.max <= Math.max(200, initial * 8));
      }
    }
  },
};
