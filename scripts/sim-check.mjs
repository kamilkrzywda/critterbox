/**
 * Headless deterministic check suite for the pure simulation (no browser, no three.js).
 *
 * The pure TS sources listed in SOURCES are compiled to CJS with the project's tsc into a temp dir
 * (Sandfall pattern) and handed to every section via ctx. Each file in ./checks/*.mjs default-exports
 * an object of named section functions; a section receives the shared ctx and records results via
 * ctx.check(name, ok). Non-zero exit on any failure — this is the per-feature gate's first step.
 *
 * Run with: node scripts/sim-check.mjs   (or npm run sim-check)
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checksDir = join(root, 'scripts', 'checks');

// Pure-TS sources compiled for the headless sections (extend as sim/ grows — keep three.js/DOM out).
const SOURCES = [
  'src/worldgen/noise.ts',
  'src/worldgen/worldgen.ts',
  'src/sim/rng.ts',
  'src/sim/types.ts',
  'src/sim/registry.ts',
  'src/sim/spatial.ts',
  'src/sim/energy.ts',
  'src/sim/agents/plants/grass.ts',
  'src/sim/agents/plants/clover.ts',
  'src/sim/agents/plants/cranberry.ts',
  'src/sim/agents/plants/reed.ts',
  'src/sim/agents/plants/tree.ts',
  'src/sim/agents/index.ts',
  'src/sim/sim.ts',
  'src/sim/seedLife.ts',
];

let sections = 0;
let passed = 0;
let failed = 0;

function makeCtx(extra) {
  return {
    ...extra,
    check(name, ok) {
      if (ok) {
        passed += 1;
      } else {
        failed += 1;
        console.error(`FAIL: ${name}`);
      }
    },
  };
}

// --- compile the pure sources to CJS in a temp dir ---------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'sim-check-'));
let compiled = false;
try {
  try {
    execFileSync(
      join(root, 'node_modules', '.bin', 'tsc'),
      [
        ...SOURCES.map((rel) => join(root, rel)),
      '--outDir', tmp,
      '--rootDir', join(root, 'src'), // stable output layout (worldgen/*.js) as more pure modules land
      '--module', 'commonjs',
      '--target', 'es2022',
      '--ignoreConfig',
      ],
      { stdio: 'pipe' },
    );
    compiled = true;
  } catch (err) {
    console.error(`tsc compile failed:\n${err.stderr?.toString() ?? err.message}`);
    process.exitCode = 1;
  }

  if (compiled) {
    const tmpRequire = createRequire(join(tmp, 'noop.cjs'));
    const worldgenMod = tmpRequire('./worldgen/worldgen.js');
    const noiseMod = tmpRequire('./worldgen/noise.js');

    // Require the species barrel first so every plant self-registers before any sim use (CJS caches it).
    tmpRequire('./sim/agents/index.js');
    const rngMod = tmpRequire('./sim/rng.js');
    const typesMod = tmpRequire('./sim/types.js');
    const registryMod = tmpRequire('./sim/registry.js');
    const spatialMod = tmpRequire('./sim/spatial.js');
    const energyMod = tmpRequire('./sim/energy.js');
    const simCoreMod = tmpRequire('./sim/sim.js');
    const seedLifeMod = tmpRequire('./sim/seedLife.js');

    const ctxExtra = {
      worldgen: worldgenMod,
      noise: noiseMod,
      sim: {
        rng: rngMod,
        types: typesMod,
        registry: registryMod,
        spatial: spatialMod,
        energy: energyMod,
        Sim: simCoreMod.Sim,
        grazePlant: simCoreMod.grazePlant,
        seedLife: seedLifeMod.seedLife,
      },
    };

    let files = [];
    try {
      files = readdirSync(checksDir).filter((f) => f.endsWith('.mjs')).sort();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    for (const file of files) {
      const mod = await import(pathToFileURL(join(checksDir, file)).href);
      const sectionMap = mod.default ?? mod;
      for (const [name, fn] of Object.entries(sectionMap)) {
        if (typeof fn !== 'function') continue;
        sections += 1;
        console.log(`section: ${file} :: ${name}`);
        await fn(makeCtx(ctxExtra));
      }
    }

    console.log(
      `sim-check: ${sections} sections, ${passed + failed} checks — ${failed === 0 ? 'OK' : `${failed} FAILED`}`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
