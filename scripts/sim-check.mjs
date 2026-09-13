/**
 * Headless deterministic check suite for the pure simulation (no browser; three.js loads fine under Node).
 *
 * The TS sources listed in SOURCES are compiled to CJS with the project's tsc into a temp dir
 * (Sandfall pattern) and handed to every section via ctx. Each file in ./checks/*.mjs default-exports
 * an object of named section functions; a section receives the shared ctx and records results via
 * ctx.check(name, ok). Non-zero exit on any failure — this is the per-feature gate's first step.
 *
 * Run with: node scripts/sim-check.mjs   (or npm run sim-check)
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checksDir = join(root, 'scripts', 'checks');

// Sources compiled for the headless sections (extend as the codebase grows). src/render/terrain.ts is
// included because its pure geometry builder must be tested; it imports three, which loads fine under Node.
const SOURCES = [
  'src/worldgen/noise.ts',
  'src/worldgen/worldgen.ts',
  'src/render/terrain.ts',
  'src/sim/rng.ts',
  'src/sim/types.ts',
  'src/sim/registry.ts',
  'src/sim/spatial.ts',
  'src/sim/energy.ts',
  // Phase 7: day/night + weather animator curves (pure functions of step counter + world seed)
  'src/sim/environment.ts',
  'src/sim/agents/plants/grass.ts',
  'src/sim/agents/plants/clover.ts',
  'src/sim/agents/plants/cranberry.ts',
  'src/sim/agents/plants/reed.ts',
  'src/sim/agents/plants/tree.ts',
  'src/sim/agents/animals/base.ts',
  'src/sim/corpses.ts',
  'src/sim/agents/animals/mouse.ts',
  'src/sim/agents/animals/hare.ts',
  'src/sim/agents/animals/hamster.ts',
  'src/sim/agents/animals/deer.ts',
  'src/sim/agents/animals/insect.ts',
  // Phase 5: frogs + the predator/scavenger layer
  'src/sim/agents/animals/frog.ts',
  'src/sim/agents/animals/fox.ts',
  'src/sim/agents/animals/stork.ts',
  'src/sim/agents/animals/owl.ts',
  'src/sim/agents/animals/crow.ts',
  // Phase 6: the aquatic layer — carp + pike in the river volume (shared helpers in aquatic.ts)
  'src/sim/agents/animals/aquatic.ts',
  'src/sim/agents/animals/carp.ts',
  'src/sim/agents/animals/pike.ts',
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

// --- compile the sources to CJS in a temp dir -------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'sim-check-'));
symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules')); // let compiled modules resolve deps (e.g. three) under Node
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
    const terrainMod = tmpRequire('./render/terrain.js');

    // Require the species barrel first so every plant self-registers before any sim use (CJS caches it).
    tmpRequire('./sim/agents/index.js');
    const rngMod = tmpRequire('./sim/rng.js');
    const typesMod = tmpRequire('./sim/types.js');
    const registryMod = tmpRequire('./sim/registry.js');
    const treeMod = tmpRequire('./sim/agents/plants/tree.js'); // world-space size constants (TREE_WORLD_HEIGHT etc.)
    const spatialMod = tmpRequire('./sim/spatial.js');
    const energyMod = tmpRequire('./sim/energy.js');
    // Phase 7: day/night + weather animator curves (clock/light/season/weather Markov/multipliers)
    const environmentMod = tmpRequire('./sim/environment.js');
    const simCoreMod = tmpRequire('./sim/sim.js');
    const seedLifeMod = tmpRequire('./sim/seedLife.js');
    const animalsBaseMod = tmpRequire('./sim/agents/animals/base.js');
    const mouseMod = tmpRequire('./sim/agents/animals/mouse.js');
    const hareMod = tmpRequire('./sim/agents/animals/hare.js');
    const hamsterMod = tmpRequire('./sim/agents/animals/hamster.js');
    const deerMod = tmpRequire('./sim/agents/animals/deer.js');
    const insectMod = tmpRequire('./sim/agents/animals/insect.js');
    // Phase 5: frogs + the predator/scavenger layer (corpses module carries the scavenging API)
    const frogMod = tmpRequire('./sim/agents/animals/frog.js');
    const foxMod = tmpRequire('./sim/agents/animals/fox.js');
    const storkMod = tmpRequire('./sim/agents/animals/stork.js');
    const owlMod = tmpRequire('./sim/agents/animals/owl.js');
    const crowMod = tmpRequire('./sim/agents/animals/crow.js');
    // Phase 6: the aquatic layer (shared helpers + carp/pike species tables)
    const aquaticMod = tmpRequire('./sim/agents/animals/aquatic.js');
    const carpMod = tmpRequire('./sim/agents/animals/carp.js');
    const pikeMod = tmpRequire('./sim/agents/animals/pike.js');
    const corpsesMod = tmpRequire('./sim/corpses.js');

    const ctxExtra = {
      worldgen: worldgenMod,
      noise: noiseMod,
      terrain: terrainMod, // pure geometry builder (buildTerrainGeometryData) + three.js mesh wrapper
      sim: {
        rng: rngMod,
        types: typesMod,
        registry: registryMod,
        spatial: spatialMod,
        energy: energyMod,
        environment: environmentMod, // Phase 7 day/night + weather: timeOfDay/dayPhase/lightAt/weatherAt/temperatureAt/multipliers
        Sim: simCoreMod.Sim,
        grazePlant: simCoreMod.grazePlant,
        pollinatePlant: simCoreMod.pollinatePlant,
        seedLife: seedLifeMod.seedLife,
        animals: animalsBaseMod, // shared animal framework (updateAnimal/tryBreed/hooks + visualScale size mapping)
        tree: treeMod, // tree species table + world-space size constants (size-mapping checks)
        mouse: mouseMod.MOUSE, // the mouse species table (trait bounds for assertions)
        hare: hareMod.HARE,
        hamster: hamsterMod.HAMSTER,
        deer: deerMod.DEER,
        insect: insectMod.INSECT,
        frog: frogMod.FROG, // Phase 5 species tables (trait bounds for assertions)
        fox: foxMod.FOX,
        stork: storkMod.STORK,
        owl: owlMod.OWL,
        crow: crowMod.CROW,
        aquatic: aquaticMod, // Phase 6 shared helpers: inRiverVolume/initAquaticAgent/aquaticSettle + depth constants
        carp: carpMod.CARP, // Phase 6 species tables (trait bounds for assertions)
        pike: pikeMod.PIKE,
        corpses: corpsesMod, // corpse layer: spawnCorpse/findNearestCorpse/scavengeCorpse + decay constant
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
