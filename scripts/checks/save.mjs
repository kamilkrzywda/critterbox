/**
 * Phase 8 save checks: serialize → deserialize round-trip on a REAL sim state after N steps. The payload
 * carries {seed, size, step, agents[], corpses[]} (terrain + environment are re-derived from seed/step), so
 * the assertions are: header fields preserved verbatim, agent arrays deep-equal (positions/energy/traits/
 * sex/stage/data — plain objects round-trip through the JSON tail), and — the real acceptance — a second
 * Sim restored via loadState steps in lockstep with the original from the saved step onward. IndexedDB
 * itself is browser-only; e2e covers persistence (saveNow → reload → restore).
 */

export default {
  'save round-trip preserves state': async (ctx) => {
    const { worldgen, sim: simMod, save } = ctx;
    const SEED = 42;
    const SIZE = 100; // small world — fast seeding/stepping for a check

    const w = worldgen.generateWorld({ seed: SEED, size: SIZE });
    const s = new simMod.Sim(w);
    simMod.seedLife(s);
    const STEPS = 500;
    for (let i = 0; i < STEPS; i++) s.step();

    const snap = { seed: w.seed, size: w.size, step: s.stepCount, agents: s.agents.slice(), corpses: s.corpses.slice() };
    ctx.check('sim has live agents to save', snap.agents.length > 100);

    const buf = save.serializeWorld(snap);
    const back = save.deserializeWorld(buf);
    ctx.check('round-trip parses (non-null)', back !== null);
    if (!back) return;
    ctx.check('seed/size/step preserved', back.seed === SEED && back.size === SIZE && back.step === s.stepCount);
    // Deep-equal: both sides went through the same JSON path, so string equality == value equality for
    // these plain objects (positions/energy/traits/sex/stage/data/variant all covered).
    ctx.check('agents deep-equal after round-trip', JSON.stringify(back.agents) === JSON.stringify(snap.agents));
    ctx.check('corpses deep-equal after round-trip', JSON.stringify(back.corpses) === JSON.stringify(snap.corpses));

    // The real acceptance: a restored Sim continues the deterministic sequence identically.
    const s2 = new simMod.Sim(worldgen.generateWorld({ seed: SEED, size: SIZE }));
    s2.loadState(back.agents, back.corpses, back.step);
    ctx.check('restored sim has same agent count', s2.agents.length === s.agents.length);
    const CONTINUE = 300;
    for (let i = 0; i < CONTINUE; i++) { s.step(); s2.step(); }
    ctx.check('restored sim steps in lockstep with the original', JSON.stringify(s2.agents) === JSON.stringify(s.agents));
    ctx.check('restored step counter continues from the saved value', s2.stepCount === snap.step + CONTINUE);
  },

  'save rejects corrupt payloads': async (ctx) => {
    const { worldgen, sim: simMod, save } = ctx;
    const w = worldgen.generateWorld({ seed: 7, size: 100 });
    const s = new simMod.Sim(w);
    simMod.seedLife(s);
    for (let i = 0; i < 50; i++) s.step();

    const good = save.serializeWorld({ seed: w.seed, size: w.size, step: s.stepCount, agents: s.agents.slice(), corpses: [] });
    ctx.check('valid payload parses', save.deserializeWorld(good) !== null);

    // Bad magic → null.
    const badMagic = new Uint8Array(good);
    badMagic[0] ^= 0xff;
    ctx.check('bad magic rejected', save.deserializeWorld(badMagic.buffer) === null);

    // Version mismatch → null (future/other versions are ignored, not fatal).
    const badVersion = new Uint8Array(good);
    new DataView(badVersion.buffer).setUint32(4, 999, true);
    ctx.check('version mismatch rejected', save.deserializeWorld(badVersion.buffer) === null);

    // Truncated header → null.
    const truncated = good.slice(0, 10);
    ctx.check('truncated header rejected', save.deserializeWorld(truncated) === null);

    // Corrupt JSON tail → null (never throws).
    const badTail = new Uint8Array(good);
    for (let i = 20; i < badTail.length; i++) badTail[i] ^= 0xff;
    ctx.check('corrupt JSON tail rejected', save.deserializeWorld(badTail.buffer) === null);

    // Garbage buffer → null.
    ctx.check('garbage buffer rejected', save.deserializeWorld(new ArrayBuffer(64)) === null);
  },
};
