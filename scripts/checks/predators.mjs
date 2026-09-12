/**
 * Predator & scavenger checks (Phase 5): run the REAL sim headlessly on a flat synthetic world. Covers
 * predation (hungry fox kills an in-range mouse, gains energy, corpse spawned at the death location),
 * hunger gating (a full fox never enters hunt state with prey nearby), corpse decay + crow scavenging,
 * and saturating intake (a fox killing mice in quick succession gets diminishing yield per kill).
 */

export default {
  /** A hungry fox + a mouse in range → the mouse dies, the fox's energy rises, and a corpse is spawned at the death. */
  predation(ctx) {
    const Sim = ctx.sim.Sim;
    const FOX = ctx.sim.fox;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50);

    const sim = new Sim(world);
    const fox = sim.addAgent('fox', 0, 0);
    fox.sex = 'f';
    fox.traits = midTraits(FOX);
    fox.energy = 20; // far below the hunger gate (0.6 × ~220 capacity) → hunts from the first decision tick

    const mouse = sim.addAgent('mouse', 0.5, 0); // within eatRange of the fox
    mouse.sex = 'm';
    mouse.traits = midTraits(MOUSE);
    mouse.energy = 40;

    let deathPos = null;
    const unsub = ctx.sim.animals.registerAnimalDeathHook((_s, a) => { if (a.species === 'mouse') deathPos = { x: a.pos.x, z: a.pos.z }; });

    let eatenAt = -1;
    for (let i = 0; i < 200 && sim.agents.includes(mouse); i++) {
      sim.step();
      if (!sim.agents.includes(mouse)) { eatenAt = i + 1; break; }
    }
    unsub();

    ctx.check(`predation: a hungry fox kills an in-range mouse (${eatenAt} ticks)`, eatenAt > 0);
    ctx.check(`predation: the fox gained energy from the kill (now ${fox.energy.toFixed(1)})`, fox.energy > 35);
    const corpse = sim.corpses.find((c) => c.originSpecies === 'mouse');
    ctx.check('predation: a corpse was spawned for the killed mouse', !!corpse && corpse.mass > 0);
    if (deathPos && corpse) {
      const dx = corpse.pos.x - deathPos.x, dz = corpse.pos.z - deathPos.z;
      ctx.check(`predation: the corpse sits at the death location (${Math.hypot(dx, dz).toFixed(2)} m off)`, Math.hypot(dx, dz) < 0.5);
    }
  },

  /** A full (high-energy) fox does NOT enter hunt state when prey is nearby — over N ticks. */
  hungerGating(ctx) {
    const Sim = ctx.sim.Sim;
    const FOX = ctx.sim.fox;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50);

    const sim = new Sim(world);
    const fox = sim.addAgent('fox', 0, 0);
    fox.sex = 'f';
    fox.traits = midTraits(FOX);
    fox.energy = ctx.sim.animals.animalEnergyMax(fox) * 0.95; // full — above the hunger gate

    const mouse = sim.addAgent('mouse', 1, 0); // prey right next door
    mouse.sex = 'm';
    mouse.traits = midTraits(MOUSE);
    mouse.energy = 40;

    let sawHunt = false;
    for (let i = 0; i < 60; i++) {
      sim.step();
      if (!sim.agents.includes(fox)) break; // a full fox can't starve in 60 ticks — dying here is a failure signal
      if (fox.state === 'seekFood') sawHunt = true;
    }
    ctx.check('hungerGating: a full fox never enters hunt state with prey nearby (60 ticks)', !sawHunt);
    ctx.check(`hungerGating: the mouse is untouched while the fox is full (${sim.agents.includes(mouse) ? 'alive' : 'DEAD'})`, sim.agents.includes(mouse));
  },

  /** A corpse's mass decays to zero and it is removed; a hungry crow feeding on one gains energy. */
  corpseDecayScavenging(ctx) {
    const Sim = ctx.sim.Sim;
    const CROW = ctx.sim.crow;
    const world = flatMeadowWorld(50);

    // --- pure decay: mass drops per tick and the corpse is removed at ≤ 0 -----------------------------
    const sim1 = new Sim(world);
    const c = ctx.sim.corpses.spawnCorpse(sim1, 'mouse', 5, 5, 25); // 25 / 0.1 decay ≈ 250 ticks to vanish
    let removedAt = -1;
    for (let i = 0; i < 400 && sim1.corpses.includes(c); i++) {
      sim1.step();
      if (!sim1.corpses.includes(c)) { removedAt = i + 1; break; }
    }
    ctx.check(`corpseDecay: a corpse's mass decays to zero and it is removed (${removedAt} ticks)`, removedAt > 0 && removedAt <= 320);

    // --- scavenging: a hungry crow feeding on a carcass gains energy, the mass drops -------------------
    const sim2 = new Sim(world);
    ctx.sim.corpses.spawnCorpse(sim2, 'hare', 5, 5, 60); // a big hare carcass
    const crow = sim2.addAgent('crow', 5.3, 5); // within eatRange of the corpse
    crow.sex = 'f';
    crow.traits = midTraits(CROW);
    crow.energy = 10; // hungry → scavenges from the first decision tick

    const energyBefore = crow.energy;
    let fedAt = -1;
    for (let i = 0; i < 200; i++) {
      sim2.step();
      if (!sim2.agents.includes(crow)) break; // a hungry crow can't starve this fast — dying is a failure signal
      if (crow.energy > energyBefore + 5) { fedAt = i + 1; break; } // first bite lands on its decision tick (~t≈5)
    }
    ctx.check(`corpseDecay: a hungry crow feeds on the carcass (${fedAt} ticks)`, fedAt > 0);
    ctx.check(`corpseDecay: the crow gained energy from scavenging (${energyBefore.toFixed(1)} → ${crow.energy.toFixed(1)})`, crow.energy > energyBefore + 5);
    // The carcass must have lost MORE mass than decay alone (0.1/tick) accounts for over the ticks run —
    // plain decay would leave ~60 − 0.1·t, so a scavenged bite shows up as extra loss beyond that baseline.
    const massLeft = sim2.corpses.reduce((s, cc) => s + cc.mass, 0);
    ctx.check(`corpseDecay: the carcass lost mass to scavenging (${massLeft.toFixed(1)} of 60 left)`, fedAt > 0 && massLeft < 60 - 0.1 * fedAt - 5);
  },

  /** A fox killing mice in quick succession gets diminishing yield per kill (3rd < 1st). */
  saturatingIntake(ctx) {
    const Sim = ctx.sim.Sim;
    const FOX = ctx.sim.fox;
    const MOUSE = ctx.sim.mouse;
    const world = flatMeadowWorld(50);

    const sim = new Sim(world);
    const fox = sim.addAgent('fox', 0, 0);
    fox.sex = 'f';
    fox.traits = midTraits(FOX);
    fox.energy = 10; // starving → keeps hunting through all three kills (well below the gate)

    // Three mice in a tight cluster so each successive chase is short (kills land seconds apart).
    const spots = [[0.5, 0], [1.0, 0.3], [1.5, 0.6]];
    const sexes = ['f', 'm', 'f']; // energy gate (≥60) blocks breeding — no offspring muddying the count
    const mice = spots.map(([x, z], i) => {
      const m = sim.addAgent('mouse', x, z);
      m.sex = sexes[i];
      m.traits = midTraits(MOUSE);
      m.energy = 40;
      return m;
    });

    // The death hook fires BEFORE the kill's energy is applied to the fox — so (fox.energy at end of that
    // tick) − (hook value) is exactly this kill's gain.
    const gains = [];
    let pendingBefore = null;
    const unsub = ctx.sim.animals.registerAnimalDeathHook((_s, a) => { if (a.species === 'mouse') pendingBefore = fox.energy; });

    for (let i = 0; i < 400 && mice.some((m) => sim.agents.includes(m)); i++) {
      sim.step();
      if (pendingBefore !== null) {
        gains.push(fox.energy - pendingBefore); // end-of-tick energy includes the just-applied gain
        pendingBefore = null;
      }
    }
    unsub();

    ctx.check(`saturatingIntake: the fox killed all three mice in quick succession (${gains.length} kills)`, gains.length === 3);
    if (gains.length === 3) {
      ctx.check(`saturatingIntake: yields diminish per kill (${gains.map((g) => g.toFixed(1)).join(', ')})`, gains[1] < gains[0] && gains[2] < gains[1]);
      ctx.check('saturatingIntake: the 3rd kill pays less than the 1st', gains[2] < gains[0]);
    }
  },
};

/** A flat, fully-meadow synthetic world (height above water everywhere) for controlled predation tests. */
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
