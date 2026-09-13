# [Critterbox](https://kamilkrzywda.github.io/critterbox/)

Browser-based 3D animal-ecosystem simulation: a procedurally generated heightmap world with biomes where every plant and animal is an individual agent with stats (energy, age, sex, heritable traits), living out a full food chain. No cellular automata, no physics — pure continuous agent simulation on CPU. Theme: Polish fauna.

`PLAN.md` at the repo root is the single source of truth for design decisions and roadmap; `CHANGELOG.md` tracks released versions (Keep-a-Changelog format).

## Current state (v0.9.0)

All roadmap phases 0–8 are implemented:

- **Worldgen** — seeded fBm heightmap, biomes (meadow/forest/marsh/grassland), fixed water level carving rivers/lakes; size-at-gen dialog (100–800 m, default 300) with seed input and "New World" rebuild
- **Camera** — free-flight: WASD move, mouse-drag look (no pointer lock), arrow-key rotation, Shift ×4, wheel dolly; Space pause
- **Agent core + plants** — energy model, spatial hash grid, plant stage machine (seedling → growing → fruiting → regrowth → senescence), instanced rendering, population panel with live counts per species
- **Herbivores** — mouse, hare, hamster, deer + insect pollinators; grazing with plant regrowth, breeding gates, sexes, trait inheritance with mutation
- **Predators & scavengers** — fox, stork, owl, crow + frog; hunger-gated hunting with saturating intake; corpses decay and are scavenged (fox/crow)
- **Aquatic** — carp (river omnivore) + pike (river predator) in the river volume, incl. the frog–pike waterline interaction
- **Day/night + weather** — "settings animator" layer: light gates photosynthesis, temperature drives metabolism + a breeding cold-snap gate, rain boosts plant fertility; seeded Markov weather chain; scene lighting follows the clock
- **Polish** — sim-speed slider (0–8×, persisted to localStorage; 0 = pause, synced with Space + PAUSED overlay), IndexedDB autosave every 30 s (activity-gated, gzip in a dedicated worker, restore-on-load before first render, "New World" overwrites the save), entity inspector (click any plant/animal → side panel with all live parameters, ~10 Hz; highlight ring on the selected agent; Esc / empty-click deselects)

Not yet implemented (stretch): wolf (top predator), beaver (terrain modifier!), moose; evolution v2 — NEAT-style brains behind a pluggable "brain" interface.

## Tech stack

- Vite ^8 + TypeScript strict (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, ES2022)
- Three.js ^0.185 with version-matched @types/three; no framework, no asset pipeline — everything procedural
- `src/sim/` is pure TS (never imports three.js or touches the DOM) → headlessly testable: compiled to CJS via the project's tsc and run under Node
- Playwright e2e with a **global** @playwright/test install (sandbox convention; not in package.json), workers 1, retries 1

## File layout

```
src/
  main.ts            — boot, fixed-timestep loop (accumulator + max-steps clamp), window.__critterbox debug surface
  worldgen/          — noise.ts (seeded value-noise fBm), worldgen.ts (heightmap → biomes)
  sim/               — PURE TS: no three.js imports
    agents/          — index.ts barrel; plants/ (grass, clover, cranberry, reed, tree); animals/ (base + mouse, hare, hamster, deer, insect, frog, fox, stork, owl, crow, carp, pike)
    sim.ts           — Sim core: step loop, breeding, predation/grazing API, save/load state restore
    seedLife.ts      — deterministic per-biome world seeding
    spatial.ts       — uniform spatial hash grid (flat counting-sort)
    energy.ts        — shared energy model
    corpses.ts       — corpse layer: decay + scavenging
    environment.ts   — day/night + weather animator curves (pure in seed+step)
    registry.ts, rng.ts, types.ts
  render/            — Three.js: terrain.ts (heightmap mesh + water), camera.ts (free-flight), plants.ts / animals.ts (InstancedMesh per species)
  ui/                — panel.ts (world-gen dialog), population.ts (population panel), envPanel.ts (day/weather indicator), inspector.ts (entity inspector side panel)
  save/              — Phase 8: serialize.ts (pure binary payload), storage.ts (IndexedDB, single key), saveWorker.ts (fflate gzip level 6 in a module worker), save.ts (autosave orchestration), restore.ts (restore-on-load)
scripts/sim-check.mjs   — headless deterministic suite runner (tsc-CJS compile → Node)
scripts/checks/*.mjs    — check sections: worldgen, terrain, spatial, plants, animals, predators, aquatic, environment, sizes, stability (20k-step run), save (serialize round-trip)
e2e/                 — Playwright specs: smoke, worldgen, camera, plants, animals, environment, speed, inspector, save
playwright.config.ts     — webServer auto-runs build + preview on :4173
```

## Commands

Requires Node >= 20.19 or >= 22.12 (Vite 8).

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit && vite build` → `dist/` |
| `npm run preview` | Serve the built app on :4173 (strict port) |
| `npm run sim-check` | Headless deterministic suite; non-zero exit on any failure — first step of the per-feature gate |
| `npx playwright test` | e2e suite (@playwright/test is installed globally, not in package.json); webServer auto-starts build + preview on :4173 |

Per-feature gate (run locally before push): sim-check → tsc/build → playwright → deploy proof.

## Deploy

GitHub Pages at https://kamilkrzywda.github.io/critterbox/ — automatic on push to master via `.github/workflows/deploy.yml`: checkout → setup-node 24 → `npm ci` → `npm run build` → publish `dist/` with actions/deploy-pages. The same `dist/` works because `vite.config.ts` uses `base: './'` (relative asset paths).
