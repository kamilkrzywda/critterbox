/**
 * Day/night + weather checks (Phase 7, PLAN "Testing & verification"): run the pure environment module and
 * the REAL sim headlessly. Covers (1) DETERMINISM — the Phase 7 acceptance gate: same seed → identical
 * sampled sequences of light/temperature/weather over N ticks (pure functions AND through a live Sim),
 * different seeds → different weather sequences; (2) cycle correctness — light period matches the
 * configured day+night length, ~0 at midnight / ~1 at noon, phase labels, bounded mild metabolism
 * multiplier and rain fertility boost; (3) weather Markov validity — states only from the set, durations
 * within the configured per-state ranges, all three states occur with real transitions over a long sample;
 * (4) sim effects — plant growth is light-gated (day vs night), owl activity high at night / low by day
 * while the fox is the reverse, and breeding is suppressed below the temperature threshold in a controlled
 * scenario.
 */

export default {
  /** ACCEPTANCE GATE: same seed → identical sampled sequences of light/temperature/weather; different seeds
   *  → different weather sequences. Checked at the pure-function level AND through two live Sims stepped in
   *  lockstep (environment wiring + agent-state determinism under the new curves). */
  determinism(ctx) {
    const env = ctx.sim.environment;
    const Sim = ctx.sim.Sim;
    const seedLife = ctx.sim.seedLife;
    const { generateWorld } = ctx.worldgen;

    // --- pure-function level: two independent sampling passes over N ticks must agree exactly ----------
    const SEED_A = 1337, SEED_B = 999, N = 6000;
    function sampleSeq(seed, n) {
      let out = '';
      for (let s = 0; s < n; s++) {
        out += env.lightAt(s).toFixed(9) + ',' + env.temperatureAt(seed, s).toFixed(9) + ',' + env.weatherAt(seed, s);
      }
      return out;
    }
    ctx.check(`environment: same seed → identical light/temperature/weather sequence (${N} ticks)`, sampleSeq(SEED_A, N) === sampleSeq(SEED_A, N));

    // Different seeds must produce different weather sequences (the Markov chain is seeded by the world).
    let diffCount = 0;
    for (let s = 0; s < N; s++) {
      if (env.weatherAt(SEED_A, s) !== env.weatherAt(SEED_B, s)) diffCount++;
    }
    ctx.check(`environment: different seeds → different weather sequences (${diffCount} differing ticks of ${N})`, diffCount > 0);

    // --- live-sim level: two Sims from the same seed stepped in lockstep see identical environments ------
    const SEED = 42, SIZE = 100, STEPS = 800;
    function signature(sim) {
      return sim.agents.map((a) => `${a.species}:${a.energy.toFixed(6)}:${a.state}`).join('|');
    }
    const a = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    seedLife(a);
    const b = new Sim(generateWorld({ seed: SEED, size: SIZE }));
    seedLife(b);

    let envMatch = true;
    for (let i = 0; i < STEPS; i++) {
      a.step();
      b.step();
      const ea = a.environment, eb = b.environment;
      if (ea.light !== eb.light || ea.temperature !== eb.temperature || ea.weather !== eb.weather) envMatch = false;
    }
    ctx.check(`environment: two same-seed Sims see identical light/temperature/weather over ${STEPS} lockstep ticks`, envMatch);
    ctx.check('environment: agent state identical after the lockstep run (wiring keeps the sim deterministic)', signature(a) === signature(b));
  },

  /** Light period matches the configured day+night length; ~0 at midnight, ~1 at noon; phase labels land in
   *  their windows; the temperature-derived multipliers are bounded and mild. */
  cycleCorrectness(ctx) {
    const env = ctx.sim.environment;
    const { DAY_TICKS, NIGHT_TICKS, CYCLE_TICKS } = env;

    // Period: lightAt repeats exactly every CYCLE_TICKS steps (day + night length).
    let periodic = true;
    for (const s of [0, 123, 777, 1800, 3599, 4999]) {
      if (env.lightAt(s) !== env.lightAt(s + CYCLE_TICKS)) periodic = false;
    }
    ctx.check(`environment: light period matches day+night length (${CYCLE_TICKS} ticks)`, periodic);

    // ~0 at midnight, ~1 at noon.
    const midnight = env.lightAt(DAY_TICKS + Math.floor(NIGHT_TICKS / 2));
    const noon = env.lightAt(Math.floor(DAY_TICKS / 2));
    ctx.check(`environment: light is ~0 at midnight (${midnight})`, midnight < 0.01);
    ctx.check(`environment: light is ~1 at noon (${noon.toFixed(6)})`, noon > 0.999 && noon <= 1);

    // Phase labels land in their windows (dawn/day/dusk/night).
    ctx.check('environment: phase label dawn early in the cycle', env.dayPhase(100) === 'dawn');
    ctx.check('environment: phase label day around noon', env.dayPhase(Math.floor(DAY_TICKS / 2)) === 'day');
    ctx.check('environment: phase label dusk at the end of daylight', env.dayPhase(DAY_TICKS - 100) === 'dusk');
    ctx.check('environment: phase label night mid-night', env.dayPhase(DAY_TICKS + Math.floor(NIGHT_TICKS / 2)) === 'night');

    // timeOfDay is a [0,1) fraction of the same period.
    let todOk = true;
    for (const s of [0, 1, 5099, 5100, 12345]) {
      const t = env.timeOfDay(s);
      if (!(t >= 0 && t < 1) || Math.abs(t - env.timeOfDay(s + CYCLE_TICKS)) > 1e-12) todOk = false;
    }
    ctx.check('environment: timeOfDay is a [0,1) fraction with the cycle period', todOk);

    // Temperature model: metabolism multiplier is 1 above comfort (8 °C), rises mildly in the cold, hard-capped.
    const mCold = env.metabolismMult(2); // coldest possible point (seasonal min + rain)
    ctx.check('environment: metabolism multiplier is 1 at warm temperatures', env.metabolismMult(25) === 1 && env.metabolismMult(8) === 1);
    ctx.check(`environment: cold raises the metabolism multiplier mildly (T=2 → ${mCold.toFixed(3)} ≤ cap ${env.METAB_MULT_MAX})`, mCold > 1 && mCold <= env.METAB_MULT_MAX);
    ctx.check('environment: the multiplier is monotone non-increasing in temperature', env.metabolismMult(3) >= env.metabolismMult(7) - 1e-12);

    // Fertility: rain boosts plant growth, clear is the baseline.
    ctx.check(`environment: rain boosts fertility (${env.fertilityMult('rain')} > ${env.fertilityMult('clear')})`, env.fertilityMult('rain') > env.fertilityMult('clear'));
    ctx.check('environment: cloudy fertility ≥ clear baseline', env.fertilityMult('cloudy') >= env.fertilityMult('clear'));
  },

  /** Weather Markov validity over a long sample: states only from the set, every observed duration within
   *  its state's configured range, all three states occur and transitions actually happen. */
  weatherMarkov(ctx) {
    const env = ctx.sim.environment;
    const SEED = 1337, N = 60000;

    // Walk the chain tick-by-tick (pure replay — same values a live Sim would see) and collect maximal runs.
    const counts = { clear: 0, cloudy: 0, rain: 0 };
    let transitions = 0;
    let runState = env.weatherAt(SEED, 0);
    let runLen = 1;
    let durationsOk = true;
    let statesValid = true;
    const countRun = (state, len) => {
      if (!env.WEATHER_STATES.includes(state)) statesValid = false;
      counts[state] = (counts[state] ?? 0) + len;
    };
    // A run that ENDS inside the sample is exactly one sampled duration → validate its range. The final run
    // may be truncated by the end of the sample, so it only gets counted.
    const checkRun = (state, len) => {
      countRun(state, len);
      const [lo, hi] = env.DURATION_RANGE[state];
      if (len < lo || len > hi) durationsOk = false;
    };
    for (let s = 1; s < N; s++) {
      const w = env.weatherAt(SEED, s);
      if (w === runState) {
        runLen++;
      } else {
        checkRun(runState, runLen); // completed run — full duration observed
        transitions++;
        runState = w;
        runLen = 1;
      }
    }
    countRun(runState, runLen); // final (possibly truncated) run

    ctx.check('environment: weather states only from {clear, cloudy, rain}', statesValid);
    ctx.check(`environment: every observed duration is within its state's configured range (${transitions + 1} runs over ${N} ticks)`, durationsOk);
    ctx.check(`environment: all three states occur (clear ${counts.clear}, cloudy ${counts.cloudy}, rain ${counts.rain})`, counts.clear > 0 && counts.cloudy > 0 && counts.rain > 0);
    ctx.check(`environment: transitions actually occur over the sample (${transitions} in ${N} ticks)`, transitions >= 15);
  },

  /** Sim effects of the environment: plant growth is light-gated (day vs night), owl activity is nocturnal
   *  while the fox is diurnal, and breeding is suppressed below the temperature threshold. */
  simEffects(ctx) {
    const env = ctx.sim.environment;
    const Sim = ctx.sim.Sim;

    // --- plant growth: light gating (day vs night on an otherwise identical world) ----------------------
    const simDay = new Sim(flatMeadowWorld(50));
    const pDay = simDay.addAgent('grass', 10, 10);
    while (env.lightAt(simDay.stepCount) < 0.95) simDay.step(); // advance to near-noon
    pDay.energy = 50;
    pDay.state = 'growing';
    const eDay0 = pDay.energy;
    for (let i = 0; i < 30; i++) simDay.step();
    const dayDelta = pDay.energy - eDay0;

    const simNight = new Sim(flatMeadowWorld(50));
    const pNight = simNight.addAgent('grass', 10, 10);
    while (env.dayPhase(simNight.stepCount) !== 'night') simNight.step(); // advance to the first night tick —
    // lightAt(0) is exactly 0 too (dawn start), so testing for zero light would stop immediately at t=0;
    // the phase label is unambiguous.
    pNight.energy = 50;
    pNight.state = 'growing';
    const eNight0 = pNight.energy;
    for (let i = 0; i < 30; i++) simNight.step();
    const nightDelta = pNight.energy - eNight0;

    ctx.check(`environment: plant growth is light-gated — day ${dayDelta.toFixed(1)}e vs night ${nightDelta.toFixed(4)}e over 30 ticks`, dayDelta > 5 && nightDelta < 1e-9 && dayDelta > nightDelta);

    // --- activity: owl nocturnal (high at night / low by day), fox the reverse ---------------------------
    const OWL = ctx.sim.owl;
    const FOX = ctx.sim.fox;
    const simAct = new Sim(flatMeadowWorld(50)); // tiny world — only the clock matters here
    while (env.lightAt(simAct.stepCount + 1) > env.lightAt(simAct.stepCount)) simAct.step(); // walk to the light peak (noon)
    const owlDay = OWL.activityLevel(simAct);
    const foxDay = FOX.activityLevel(simAct);
    while (env.lightAt(simAct.stepCount) !== 0) simAct.step(); // on to night
    const owlNight = OWL.activityLevel(simAct);
    const foxNight = FOX.activityLevel(simAct);

    ctx.check(`environment: owl activity high at night (${owlNight.toFixed(2)}) / low by day (${owlDay.toFixed(2)})`, owlNight > 0.95 && owlDay <= 0.25);
    ctx.check(`environment: fox activity the reverse — diurnal (day ${foxDay.toFixed(2)} / night ${foxNight.toFixed(2)})`, foxDay > 0.95 && foxNight < 0.35);

    // --- breeding suppression below the temperature threshold (controlled scenario) ----------------------
    const MOUSE = ctx.sim.mouse;
    let coldStep = -1, warmStep = -1, seed = 0;
    for (const s of [1337, 42, 7, 999]) { // deterministic scan — first seed with a sub-threshold moment wins
      for (let t = 0; t < env.YEAR_TICKS && coldStep === -1; t++) {
        const T = env.temperatureAt(s, t);
        if (T < env.BREED_TEMP_MIN) coldStep = t;
        if (warmStep === -1 && T > 20) warmStep = t; // well above the threshold (midsummer)
      }
      if (coldStep !== -1) { seed = s; break; }
    }
    ctx.check(`environment: found a sub-threshold temperature step for the breeding test (seed ${seed}, tick ${coldStep})`, coldStep >= 0 && warmStep >= 0);

    if (coldStep >= 0) {
      // The controlled world must carry the SAME seed the scan used — temperature depends on the weather
      // chain, which is seeded by the world. A mismatched seed would sample a different temperature at the
      // "cold" step and defeat the controlled scenario.
      const sim = new Sim({ ...flatMeadowWorld(50), seed });
      const m = sim.addAgent('mouse', 0, 0);
      m.sex = 'm';
      m.age = 1000; // > maturityAge (600)
      m.energy = 95; // ≥ breedEnergyFraction × capacity
      m.traits = midTraits(MOUSE);
      const f = sim.addAgent('mouse', 1, 0); // within matingRange (8 m)
      f.sex = 'f';
      f.age = 1000;
      f.energy = 95;
      f.traits = midTraits(MOUSE);

      sim.stepCount = coldStep; // the environment getter recomputes for the new step — no stepping needed
      ctx.check(`environment: temperature at the cold step is below BREED_TEMP_MIN (${sim.environment.temperature.toFixed(1)} < ${env.BREED_TEMP_MIN})`, sim.environment.temperature < env.BREED_TEMP_MIN);
      ctx.check('environment: breeding suppressed below the temperature threshold', ctx.sim.animals.tryBreed(sim, m, f, MOUSE) === false);

      sim.stepCount = warmStep; // same pair, warm step → only the temperature gate changed
      const bred = ctx.sim.animals.tryBreed(sim, m, f, MOUSE);
      ctx.check('environment: the same pair breeds above the threshold (the gate is temperature)', bred === true && sim.agents.length === 3);
    }
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

/** All traits at their midpoint — deterministic individuals for controlled tests. */
function midTraits(sp) {
  const t = {};
  for (const k of Object.keys(sp.traits)) {
    const d = sp.traits[k];
    t[k] = (d.min + d.max) / 2;
  }
  return t;
}
