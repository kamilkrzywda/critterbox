/**
 * Worldgen checks (Phase 1): seeded fBm heightmap determinism + biome/water coverage.
 * ctx.worldgen / ctx.noise are the tsc-compiled pure modules from src/worldgen/.
 */

export default {
  /** Same seed+size → byte-identical heights AND biomes; different seed → different heights. */
  determinism(ctx) {
    const { generateWorld } = ctx.worldgen;

    const a1 = generateWorld({ seed: 42, size: 300 });
    const a2 = generateWorld({ seed: 42, size: 300 });
    ctx.check(
      'worldgen: same seed+size → byte-identical heights',
      arraysEqual(a1.heights.buffer, a2.heights.buffer),
    );
    ctx.check(
      'worldgen: same seed+size → byte-identical biomes',
      arraysEqual(a1.biomes.buffer, a2.biomes.buffer),
    );

    const b1 = generateWorld({ seed: 7, size: 500 });
    const b2 = generateWorld({ seed: 7, size: 500 });
    ctx.check(
      'worldgen: same seed+size (seed 7, 500 m) → byte-identical heights',
      arraysEqual(b1.heights.buffer, b2.heights.buffer),
    );

    const s1 = generateWorld({ seed: 1, size: 300 });
    const s2 = generateWorld({ seed: 2, size: 300 });
    let diff = 0;
    for (let i = 0; i < s1.heights.length; i++) if (s1.heights[i] !== s2.heights[i]) diff++;
    ctx.check(
      `worldgen: different seed → different heights (${diff}/${s1.heights.length} cells differ)`,
      diff > s1.heights.length * 0.5,
    );
  },

  /** Typical worlds contain all four biomes and some (but not most) water cells. */
  biomeCoverage(ctx) {
    const { generateWorld } = ctx.worldgen;
    for (const seed of [1, 7]) {
      const w = generateWorld({ seed, size: 300 });
      const counts = new Array(4).fill(0);
      let water = 0;
      for (let i = 0; i < w.biomes.length; i++) {
        counts[w.biomes[i]]++;
        if (w.heights[i] < w.waterLevel) water++;
      }
      const n = w.biomes.length;
      ctx.check(`worldgen: seed ${seed} has marsh cells (${counts[0]} / ${n})`, counts[0] > 0);
      ctx.check(`worldgen: seed ${seed} has meadow cells (${counts[1]} / ${n})`, counts[1] > 0);
      ctx.check(`worldgen: seed ${seed} has grassland cells (${counts[2]} / ${n})`, counts[2] > 0);
      ctx.check(`worldgen: seed ${seed} has forest cells (${counts[3]} / ${n})`, counts[3] > 0);
      const frac = water / n;
      ctx.check(
        `worldgen: seed ${seed} has visible water channels AND dry land (water ${(frac * 100).toFixed(1)}%)`,
        frac > 0.02 && frac < 0.6,
      );
    }
  },

  /** heightAt/biomeAt accessors agree with the raw arrays (incl. edge clamping); water derivation is consistent. */
  accessors(ctx) {
    const { generateWorld } = ctx.worldgen;
    const w = generateWorld({ seed: 1, size: 300 });

    let okH = true, okB = true, okW = true;
    for (let z = 0; z < w.depth; z += 7) {
      for (let x = 0; x < w.width; x += 11) {
        const wx = x - w.width / 2 + 0.5; // cell centre in centered meters
        const wz = z - w.depth / 2 + 0.5;
        if (w.heightAt(wx, wz) !== w.heights[z * w.width + x]) okH = false;
        if (w.biomeAt(wx, wz) !== w.biomes[z * w.width + x]) okB = false;
      }
    }
    ctx.check('worldgen: heightAt matches heights[] at sampled cell centres', okH);
    ctx.check('worldgen: biomeAt matches biomes[] at sampled cell centres', okB);

    // Edge clamping: far outside the world → corner cells, no crash.
    const tl = w.heightAt(-1e6, -1e6), br = w.heightAt(1e6, 1e6);
    ctx.check('worldgen: accessors clamp at bounds (corners finite)', Number.isFinite(tl) && Number.isFinite(br));

    // Marsh band consistency: marsh iff |height − waterLevel| ≤ MARSH_BAND.
    let okMarsh = true;
    for (let i = 0; i < w.heights.length; i += 97) {
      const inBand = Math.abs(w.heights[i] - w.waterLevel) <= ctx.worldgen.MARSH_BAND;
      if ((w.biomes[i] === ctx.worldgen.BIOME_MARSH) !== inBand) okMarsh = false;
    }
    ctx.check('worldgen: marsh band consistent with |height − waterLevel| ≤ MARSH_BAND', okMarsh);
  },
};

function arraysEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a), vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}
