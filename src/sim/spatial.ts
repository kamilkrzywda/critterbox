/**
 * Uniform spatial hash grid over the XZ plane (PLAN "Spatial partitioning"). Flat typed arrays with a
 * per-tick counting sort — no per-cell object churn, headlessly testable. Agents live on the heightmap
 * surface so only horizontal (x,z) proximity matters for interaction queries; y is derived from terrain.
 *
 * Contract: `rebuild(ids, xs, zs)` repartitions the current agents once per tick; `query(x, z, radius)`
 * returns CANDIDATE agent ids — every agent whose cell intersects the query disc (a superset of the true
 * neighbours, never a false negative). The caller does the exact distance test. Cell size ≈ interaction
 * radius, so a small-radius query touches ~9 cells; larger radii span more automatically.
 */

// Collision-free packing of integer cell coords into one number for the expected coordinate range
// (worlds ≤ 800 m → |coord| ≤ 400 m; even cellSize=1 keeps |cell| ≤ 400, far inside ±KEY_OFFSET).
const KEY_OFFSET = 8192;
const KEY_STRIDE = 16384; // > 2*KEY_OFFSET ⇒ unique for cx,cz ∈ [-8192, 8191]

function packCell(cx: number, cz: number): number {
  return (cx + KEY_OFFSET) * KEY_STRIDE + (cz + KEY_OFFSET);
}

export class SpatialGrid {
  readonly cellSize: number;
  private capacity: number;
  /** Number of agents currently in the grid. */
  n = 0;
  /** Number of distinct occupied cells after the last rebuild. */
  numCells = 0;

  private denseOf: Map<number, number> = new Map(); // packed cell key → dense index
  private denseIdx!: Int32Array; // per agent slot → its dense cell index (len capacity)
  private counts!: Int32Array; // per dense cell (len capacity+1)
  private offsets!: Int32Array; // prefix sums, length numCells+1 valid (len capacity+1)
  private cursor!: Int32Array; // running write position during scatter (len capacity+1)
  private entries!: Int32Array; // agent ids sorted by cell (len capacity)

  constructor(cellSize: number, capacity = 4096) {
    this.cellSize = Math.max(0.5, cellSize);
    this.capacity = Math.max(16, capacity | 0);
    this.alloc(this.capacity);
  }

  private alloc(cap: number): void {
    this.denseIdx = new Int32Array(cap);
    this.counts = new Int32Array(cap + 1);
    this.offsets = new Int32Array(cap + 1);
    this.cursor = new Int32Array(cap + 1);
    this.entries = new Int32Array(cap);
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    this.capacity = cap;
    this.alloc(cap);
  }

  /** Repartition the grid from parallel arrays of agent ids and their x,z positions. Call once per tick. */
  rebuild(ids: ArrayLike<number>, xs: ArrayLike<number>, zs: ArrayLike<number>): void {
    const n = ids.length;
    this.ensureCapacity(n);
    this.denseOf.clear();

    // Pass 1: map each agent to a dense cell index, counting distinct cells.
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(xs[i] / this.cellSize);
      const cz = Math.floor(zs[i] / this.cellSize);
      let d = this.denseOf.get(packCell(cx, cz));
      if (d === undefined) {
        d = this.denseOf.size;
        this.denseOf.set(packCell(cx, cz), d);
      }
      this.denseIdx[i] = d;
    }
    const numCells = this.denseOf.size;

    // Counting sort: counts → offsets (prefix sum) → scatter ids into entries by cell.
    for (let c = 0; c < numCells; c++) this.counts[c] = 0;
    for (let i = 0; i < n; i++) this.counts[this.denseIdx[i]]++;
    let acc = 0;
    for (let c = 0; c < numCells; c++) {
      this.offsets[c] = acc;
      acc += this.counts[c];
      this.cursor[c] = this.offsets[c];
    }
    this.offsets[numCells] = acc;
    for (let i = 0; i < n; i++) {
      const d = this.denseIdx[i];
      this.entries[this.cursor[d]++] = ids[i];
    }

    this.n = n;
    this.numCells = numCells;
  }

  /**
   * Candidate agent ids whose cell intersects the disc of `radius` around (x,z). Superset of the true
   * neighbours (exact distance test is the caller's job); never a false negative. Reuses `out` when given.
   */
  query(x: number, z: number, radius: number, out?: number[]): number[] {
    const result = out ?? [];
    result.length = 0;
    if (this.n === 0) return result;

    const inv = 1 / this.cellSize;
    const cx0 = Math.floor((x - radius) * inv);
    const cx1 = Math.floor((x + radius) * inv);
    const cz0 = Math.floor((z - radius) * inv);
    const cz1 = Math.floor((z + radius) * inv);

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const d = this.denseOf.get(packCell(cx, cz));
        if (d === undefined) continue;
        const start = this.offsets[d];
        const end = this.offsets[d + 1];
        for (let k = start; k < end; k++) result.push(this.entries[k]);
      }
    }
    return result;
  }

  /** True when the cell containing (x,z) holds at least one agent. */
  hasAt(x: number, z: number): boolean {
    const d = this.denseOf.get(packCell(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize)));
    return d !== undefined;
  }
}
