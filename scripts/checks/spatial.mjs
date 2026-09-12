/**
 * Spatial hash grid checks: verify query() returns exactly the agents within radius (no false negatives,
 * and candidates filter to the brute-force set), across edge cells and empty regions. ctx.sim.spatial is
 * the tsc-compiled src/sim/spatial.ts; ctx.noise provides a seeded PRNG for reproducible agent layouts.
 */

export default {
  /** N seeded agents in a bounded box; sample queries must match an O(n²) brute-force reference exactly. */
  exactMatchAgainstBruteForce(ctx) {
    const { SpatialGrid } = ctx.sim.spatial;
    const { mulberry32 } = ctx.noise;

    const N = 2000;
    const rng = mulberry32(1234);
    const ids = new Array(N), xs = new Float64Array(N), zs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      ids[i] = i;
      xs[i] = (rng() - 0.5) * 120; // agents spread over a 120×120 m box
      zs[i] = (rng() - 0.5) * 120;
    }

    const grid = new SpatialGrid(8, N);
    grid.rebuild(ids, xs, zs);

    // Brute-force reference: all agent ids within `radius` of (qx,qz).
    function brute(qx, qz, radius) {
      const r2 = radius * radius;
      const out = new Set();
      for (let i = 0; i < N; i++) {
        const dx = xs[i] - qx, dz = zs[i] - qz;
        if (dx * dx + dz * dz <= r2) out.add(i);
      }
      return out;
    }

    // Sample query points: seeded interior points + explicit edge cells + empty regions.
    const qrng = mulberry32(99);
    const queries = [];
    for (let i = 0; i < 40; i++) queries.push([(qrng() - 0.5) * 120, (qrng() - 0.5) * 120]);
    // Edge cells: near the box boundary where neighbours straddle cell edges.
    for (const [ex, ez] of [[-60, 0], [60, 0], [0, -60], [0, 60], [-58, 58], [57, -59]]) queries.push([ex, ez]);
    // Empty regions: far from every agent → both sides must be empty.
    for (const [ex, ez] of [[1000, 1000], [-1000, 500], [300, -300]]) queries.push([ex, ez]);

    let allExact = true;
    let noFalseNegatives = true;
    for (const radius of [3, 8, 15]) {
      for (const [qx, qz] of queries) {
        const expected = brute(qx, qz, radius);
        const candidates = grid.query(qx, qz, radius);
        // No false negatives: every true neighbour must be a candidate.
        for (const id of expected) if (!candidates.includes(id)) noFalseNegatives = false;
        // Exact match after the caller's distance filter (the documented contract).
        const filtered = new Set(candidates.filter((id) => {
          const dx = xs[id] - qx, dz = zs[id] - qz;
          return dx * dx + dz * dz <= radius * radius;
        }));
        if (filtered.size !== expected.size || ![...expected].every((id) => filtered.has(id))) allExact = false;
      }
    }

    ctx.check(`spatial: query matches brute force exactly across ${queries.length} points × 3 radii`, allExact);
    ctx.check('spatial: no false negatives (every true neighbour is a candidate)', noFalseNegatives);
  },

  /** Empty grid and single-agent edge cases behave sanely. */
  edgeAndEmpty(ctx) {
    const { SpatialGrid } = ctx.sim.spatial;

    const empty = new SpatialGrid(8, 16);
    empty.rebuild([], [], []);
    ctx.check('spatial: empty grid query returns no candidates', empty.query(0, 0, 50).length === 0);

    // One agent exactly on a cell boundary; queries from both sides must find it.
    const g = new SpatialGrid(8, 16);
    g.rebuild([7], [8.0], [8.0]); // sits at the corner of cells (1,1)/(2,2) etc.
    ctx.check('spatial: single agent found from an adjacent cell', g.query(4, 4, 5).includes(7));
    ctx.check('spatial: single agent NOT found far away', !g.query(100, 100, 5).includes(7));

    // hasAt reflects occupancy.
    ctx.check('spatial: hasAt true on occupied cell, false elsewhere', g.hasAt(8, 8) === true && g.hasAt(40, 40) === false);
  },
};
