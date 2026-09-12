/**
 * Terrain mesh checks (Phase 1 regression): every heightmap cell quad must be fully covered by exactly
 * two non-degenerate, consistently-wound triangles — no missing-corner holes in the land.
 * ctx.terrain is the tsc-compiled src/render/terrain.ts; ctx.worldgen generates real worlds.
 */

export default {
  /** Triangle count / index range / quad corners / degeneracy / winding / full per-cell coverage. */
  geometry(ctx) {
    const { buildTerrainGeometryData } = ctx.terrain;
    const { generateWorld } = ctx.worldgen;

    // generateWorld clamps size to [100, 800], so the "small" real world is the minimum size;
    // a synthetic 32×32 ramp adds steep controlled slopes for area/winding stress.
    const worlds = [
      { name: 'synthetic 32x32 ramp', world: makeRampWorld(32) },
      { name: 'generated seed 1 @ min size', world: generateWorld({ seed: 1, size: 100 }) },
    ];

    for (const { name, world } of worlds) {
      const w = world.width, d = world.depth;
      const { positions, colors, indices } = buildTerrainGeometryData(world);
      const label = `terrain(${name})`;

      ctx.check(
        `${label}: vertex/colour counts (${w}x${d})`,
        positions.length === w * d * 3 && colors.length === w * d * 3,
      );
      ctx.check(
        `${label}: triangle count === 2*(W-1)*(D-1) (${indices.length / 3} tris)`,
        indices.length === 6 * (w - 1) * (d - 1),
      );

      let inRange = true;
      let cornersOk = true;
      let sharedDiagonal = true;
      for (let z = 0; z < d - 1; z++) {
        for (let x = 0; x < w - 1; x++) {
          const off = (z * (w - 1) + x) * 6; // row-major cell order, 6 indices per quad
          const t1 = [indices[off], indices[off + 1], indices[off + 2]];
          const t2 = [indices[off + 3], indices[off + 4], indices[off + 5]];
          for (const i of [...t1, ...t2]) if (i < 0 || i >= w * d) inRange = false;

          // The quad's 4 corners must all be present and distinct across the two triangles.
          const expected = new Set([z * w + x, z * w + x + 1, (z + 1) * w + x, (z + 1) * w + x + 1]);
          const used = new Set([...t1, ...t2]);
          if (used.size !== 4 || ![...expected].every((i) => used.has(i))) cornersOk = false;

          // The two triangles must share exactly one edge and it must be a quad diagonal.
          const s1 = new Set(t1);
          const common = t2.filter((i) => s1.has(i));
          if (common.length !== 2 || !isDiagonalPair(world, z, x, common[0], common[1])) sharedDiagonal = false;
        }
      }
      ctx.check(`${label}: all indices in range`, inRange);
      ctx.check(`${label}: each quad's 4 corners present & distinct`, cornersOk);
      ctx.check(`${label}: triangles share a diagonal (full quad coverage)`, sharedDiagonal);

      // Per-triangle area from positions: no degenerate tris; consistent up-facing winding.
      let minArea = Infinity;
      let allUpFacing = true;
      for (let t = 0; t < indices.length / 3; t++) {
        const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
        const e1x = positions[i1] - positions[i0], e1y = positions[i1 + 1] - positions[i0 + 1], e1z = positions[i1 + 2] - positions[i0 + 2];
        const e2x = positions[i2] - positions[i0], e2y = positions[i2 + 1] - positions[i0 + 1], e2z = positions[i2 + 2] - positions[i0 + 2];
        const cx = e1y * e2z - e1z * e2y;
        const cy = e1z * e2x - e1x * e2z;
        const cz = e1x * e2y - e1y * e2x;
        minArea = Math.min(minArea, 0.5 * Math.hypot(cx, cy, cz));
        if (cy <= 0) allUpFacing = false;
      }
      ctx.check(`${label}: no degenerate triangles (min area ${minArea.toFixed(4)} m^2)`, minArea > 1e-6);
      ctx.check(`${label}: consistent winding (all normals up-facing)`, allUpFacing);

      // Direct hole check: sample points inside each quad must lie in one of its two triangles.
      let covered = true;
      for (let z = 0; z < d - 1 && covered; z++) {
        for (let x = 0; x < w - 1 && covered; x++) {
          const off = (z * (w - 1) + x) * 6;
          const tris = [
            [indices[off], indices[off + 1], indices[off + 2]],
            [indices[off + 3], indices[off + 4], indices[off + 5]],
          ];
          for (const su of [0.25, 0.5, 0.75]) {
            for (const sv of [0.25, 0.5, 0.75]) {
              const px = x + su - (w - 1) / 2; // same centered frame as positions[]
              const pz = z + sv - (d - 1) / 2;
              if (!tris.some(([i0, i1, i2]) => pointInTriXZ(px, pz, positions, i0 * 3, i1 * 3, i2 * 3))) covered = false;
            }
          }
        }
      }
      ctx.check(`${label}: every quad fully covered (no missing-corner holes)`, covered);
    }
  },
};

/** True if the two vertex indices are opposite corners of cell (x, z). */
function isDiagonalPair(world, z, x, p, q) {
  const tl = z * world.width + x;
  const tr = tl + 1;
  const bl = (z + 1) * world.width + x;
  const br = bl + 1;
  return (p === tl && q === br) || (p === br && q === tl) || (p === tr && q === bl) || (p === bl && q === tr);
}

/** Point-in-triangle in the x/z plane (heights irrelevant for coverage). */
function pointInTriXZ(px, pz, positions, i0, i1, i2) {
  const d1 = edgeSign(px, pz, positions[i0], positions[i0 + 2], positions[i1], positions[i1 + 2]);
  const d2 = edgeSign(px, pz, positions[i1], positions[i1 + 2], positions[i2], positions[i2 + 2]);
  const d3 = edgeSign(px, pz, positions[i2], positions[i2 + 2], positions[i0], positions[i0 + 2]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function edgeSign(px, pz, ax, az, bx, bz) {
  return (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
}

/** Small synthetic world: diagonal ramp + sine ripple — steep controlled slopes for area/winding stress. */
function makeRampWorld(size) {
  const n = size * size;
  const heights = new Float32Array(n);
  const biomes = new Uint8Array(n).fill(1); // meadow (BIOME_MARSH=0, MEADOW=1, GRASSLAND=2, FOREST=3)
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      heights[z * size + x] = 4 + x * 0.9 + z * 0.7 + Math.sin(x * 0.5) * Math.cos(z * 0.3) * 2;
    }
  }
  const cellAt = (v) => Math.min(size - 1, Math.max(0, Math.round(v + (size - 1) / 2)));
  return {
    seed: 0, size, width: size, depth: size, heights, biomes, waterLevel: -1, // all land
    heightAt(x, z) { return heights[cellAt(z) * size + cellAt(x)]; },
    biomeAt(x, z) { return biomes[cellAt(z) * size + cellAt(x)]; },
  };
}
