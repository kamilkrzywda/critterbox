/**
 * Headless deterministic check suite for the pure simulation (no browser, no three.js).
 *
 * Contract for later phases: each file in ./checks/*.mjs default-exports an object of
 * named section functions. A section receives a shared ctx and records results via
 * ctx.check(name, ok). The sim/ modules are compiled to CJS with the project's tsc
 * before sections run (see PLAN.md "Testing & verification"). No sections exist yet in
 * v0.1.0 — this runner establishes the gate pattern and reports an empty suite.
 *
 * Run with: node scripts/sim-check.mjs   (or npm run sim-check)
 */

import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checksDir = join(root, 'scripts', 'checks');

let sections = 0;
let passed = 0;
let failed = 0;

function makeCtx() {
  return {
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
    await fn(makeCtx());
  }
}

console.log(
  `sim-check: ${sections} sections, ${passed + failed} checks — ${failed === 0 ? 'OK' : `${failed} FAILED`}`,
);
process.exitCode = failed === 0 ? 0 : 1;
