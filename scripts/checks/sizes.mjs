/**
 * World-space size-mapping checks (Bug-2 regression guard): the per-species visual mapping is
 * bodySize (meters at the mid size trait) × visualScale(size trait), where visualScale maps each species'
 * full trait range onto a fixed ±25% band. These assertions keep the scene reading correctly: no animal
 * renders at raw-trait scale (a deer was 6–10 m tall before the fix), and trees stay the dominant vertical
 * feature of forest biomes (8–15 m total, canopy radius 3–6 m).
 */

export default {
  /** Deer max body height < tree min total height; per-species rendered dimensions within sanity targets. */
  sizeMapping(ctx) {
    const animals = ctx.sim.animals; // base.ts: visualScale + VISUAL_SCALE_MIN/MAX
    const tree = ctx.sim.tree; // tree.ts: TREE_WORLD_HEIGHT / TREE_CANOPY_RADIUS / TREE_MIN_TOTAL_HEIGHT

    // --- the core guard (Bug 2): a max-size deer must be shorter than the shortest full-growth tree -----
    const sarna = ctx.sim.sarna;
    const deerMaxH = sarna.bodySize[1] * animals.VISUAL_SCALE_MAX;
    ctx.check(
      `sizes: deer max body height (${deerMaxH.toFixed(2)} m) < tree min total height (${tree.TREE_MIN_TOTAL_HEIGHT} m)`,
      deerMaxH < tree.TREE_MIN_TOTAL_HEIGHT,
    );

    // --- tree geometry within the sanity band -----------------------------------------------------------
    ctx.check(`sizes: full-growth tree total height ${tree.TREE_WORLD_HEIGHT} m in 8–15 m band`, tree.TREE_WORLD_HEIGHT >= 8 && tree.TREE_WORLD_HEIGHT <= 15);
    ctx.check(`sizes: canopy radius ${tree.TREE_CANOPY_RADIUS} m in 3–6 m band`, tree.TREE_CANOPY_RADIUS >= 3 && tree.TREE_CANOPY_RADIUS <= 6);

    // --- visualScale maps each species' full trait range onto exactly [0.75, 1.25] ------------------------
    const tables = {
      mysz: ctx.sim.mysz, zajac: ctx.sim.zajac, chomik: ctx.sim.chomik, sarna: ctx.sim.sarna,
      owady: ctx.sim.owady, zaba: ctx.sim.zaba, lis: ctx.sim.lis, bocian: ctx.sim.bocian,
      sowa: ctx.sim.sowa, wrona: ctx.sim.wrona,
    };
    for (const [id, sp] of Object.entries(tables)) {
      const lo = animals.visualScale(sp, sp.traits.size.min);
      const hi = animals.visualScale(sp, sp.traits.size.max);
      ctx.check(`sizes: ${id} visualScale spans exactly [${animals.VISUAL_SCALE_MIN}, ${animals.VISUAL_SCALE_MAX}] (got [${lo.toFixed(2)}, ${hi.toFixed(2)}])`, Math.abs(lo - animals.VISUAL_SCALE_MIN) < 1e-9 && Math.abs(hi - animals.VISUAL_SCALE_MAX) < 1e-9);
    }

    // --- per-species rendered body dimensions (min–max across the trait range) within sanity targets ------
    // h = body height band; maxDim = largest dimension (height or length) band — meters.
    const TARGETS = {
      mysz:   { h: [0.05, 0.2], maxDim: [0.1, 0.3] },    // mouse ~0.1–0.2
      chomik: { h: [0.1, 0.3], maxDim: [0.15, 0.4] },    // hamster ~0.2
      zajac:  { h: [0.3, 0.7], maxDim: [0.4, 1.0] },     // hare ~0.4–0.6
      sarna:  { h: [1.2, 2.3], maxDim: [1.3, 2.6] },     // deer ~1.5–2 tall / ~2 long
      owady:  { h: [0.01, 0.08], maxDim: [0.02, 0.1] },  // insect — a tiny speck
      zaba:   { h: [0.05, 0.15], maxDim: [0.06, 0.2] },  // frog ~0.1
      lis:    { h: [0.3, 0.8], maxDim: [0.5, 1.2] },     // fox ~0.8–1
      bocian: { h: [0.6, 1.4], maxDim: [0.6, 1.4] },     // stork ~1 (tall)
      sowa:   { h: [0.25, 0.6], maxDim: [0.25, 0.6] },   // owl ~0.4
      wrona:  { h: [0.15, 0.4], maxDim: [0.2, 0.5] },    // crow ~0.3
    };
    for (const [id, sp] of Object.entries(tables)) {
      const t = TARGETS[id];
      const [w, h, d] = sp.bodySize;
      const hMin = h * animals.VISUAL_SCALE_MIN, hMax = h * animals.VISUAL_SCALE_MAX;
      const maxDimMin = Math.max(w, h, d) * animals.VISUAL_SCALE_MIN;
      const maxDimMax = Math.max(w, h, d) * animals.VISUAL_SCALE_MAX;
      ctx.check(
        `sizes: ${id} body height ${hMin.toFixed(3)}–${hMax.toFixed(3)} m within [${t.h[0]}, ${t.h[1]}]`,
        hMin >= t.h[0] && hMax <= t.h[1],
      );
      ctx.check(
        `sizes: ${id} max dimension ${maxDimMin.toFixed(3)}–${maxDimMax.toFixed(3)} m within [${t.maxDim[0]}, ${t.maxDim[1]}]`,
        maxDimMin >= t.maxDim[0] && maxDimMax <= t.maxDim[1],
      );
    }

    // --- no animal's max dimension may exceed the tree sanity floor (the scene must read correctly) --------
    for (const [id, sp] of Object.entries(tables)) {
      const maxDim = Math.max(...sp.bodySize) * animals.VISUAL_SCALE_MAX;
      ctx.check(`sizes: ${id} max dimension (${maxDim.toFixed(2)} m) < tree min total height (${tree.TREE_MIN_TOTAL_HEIGHT} m)`, maxDim < tree.TREE_MIN_TOTAL_HEIGHT);
    }
  },
};
