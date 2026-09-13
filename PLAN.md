# Critterbox — Plan

Single source of truth for all work on this project.

## Overview

Critterbox is a browser-based 3D animal-ecosystem simulation: a procedurally generated heightmap world with Minecraft-style biomes where every plant and animal is an individual agent with stats (energy, age, sex, heritable traits), living out a full food chain under day/night cycles and weather that affect the sim. No cellular automata, no falling physics — pure continuous agent simulation on CPU.

Technically similar to Sandfall (`../3d`, docs in `../.docs/sandfall/`): same house stack (Vite + strict TS + Three.js), determinism patterns, headless test gate, deploy conventions — but without the CA grid; the world is a static heightmap and all dynamics live on agents.

Theme: Polish fauna (mouse, hare, hamster, deer, frog, stork, owl, fox, crow, carp, pike…).

## Locked decisions

| Area | Decision |
|---|---|
| World | Heightmap terrain mesh; size customizable at world-gen time (slider 100–800 m, default 300×300) |
| Biomes | meadow, forest, marsh, grassland + river/water (fixed water level carves channels/lakes) |
| Life | Full food chain; every plant and animal an individual agent with stats |
| Model | Continuous agent-based (no CA); realistic food-chain dynamics |
| Evolution | Simplified: per-species numeric traits, mutation on birth, sexes exist, offspring inherit from parents |
| Day/night + weather | Affect the sim (light → photosynthesis; temp → metabolism/breeding; rain → plant growth) |
| Camera | Free-flight: WASD move, mouse-drag look, arrows as mouse replacement, Shift fast, wheel dolly |
| Pause | Space + speed slider at 0× |
| Inspector | Click any entity (plant/animal) → panel with all its live parameters; selected entity highlighted |
| Saves | In-browser autosave (IndexedDB) + "New World" button to regenerate |
| Perf | No hard limits for now; sim speed slider (0–8×) always available |
| Location/deploy | `~/projects/sandbox/critterbox` → GitHub Pages at https://kamilkrzywda.github.io/critterbox/, auto-deployed on push to master via `.github/workflows/deploy.yml` |
| VCS | git, branch master, remote origin = github.com:kamilkrzywda/critterbox; nice commit packages per feature/phase; version in package.json (0.x.y); CHANGELOG.md history file; push after every verified milestone |

## Tech stack & conventions

- Vite ^8 + TypeScript strict (mirror `../3d` tsconfig flags: strict, noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch, ES2022)
- Three.js with version-matched @types/three; no framework; no asset pipeline — everything procedural
- `sim/` is pure TS: never imports three.js or touches the DOM → headlessly testable (tsc-compiles to CJS, runs under Node)
- Playwright global install per sandbox convention (not in package.json); workers 1, retries 1; webServer = `npm run build && vite preview --port 4173 --strictPort`
- Deploy: GitHub Pages via `.github/workflows/deploy.yml` on push to master (npm ci → build → actions/deploy-pages); served at https://kamilkrzywda.github.io/critterbox/
- Deterministic RNG everywhere: stateless per-agent hash randomness (Sandfall's cellRand pattern → agentRand(id, stepSeed))

## File layout

```
src/
  main.ts            — boot, fixed-timestep loop (accumulator + max-steps clamp), window.__critterbox debug surface
  worldgen/          — seeded value-noise fBm heightmap → terrain mesh; biome field; size param at gen time
  sim/               — PURE TS: agents, energy model, behavior tables, spatial hash grid, rng.ts
    agents/          — base agent schema + species modules self-registering behaviors (plants/, animals/)
  render/            — Three.js: terrain mesh, InstancedMesh per species, incremental updates
  ui/                — HUD overlays: world-gen dialog (panel.ts), per-species population panel (population.ts)
  save/              — fflate gzip in module worker → IndexedDB
scripts/sim-check.mjs + scripts/checks/*.mjs   — headless deterministic suite
e2e/                 — Playwright specs (global install)
```

## Worldgen

- Seeded value-noise fBm (4 octaves, hand-rolled like Sandfall's worldgen.ts) → heightmap
- Size: user-chosen at generation time (slider 100–800 m, default 300×300); same seed+size → identical world (checked by sim-check)
- Biomes from elevation × moisture field: meadow (fertile, flowering), grassland (open dry grass), forest (trees + understory), marsh (low wet land near water), river/water (heightmap below fixed water level → channels/lakes)
- Water at fixed level; fish live in the volume between terrain and surface

## Life simulation

### Agent model
- Every plant and animal is an individual agent: { id, species, sex?, pos (float3), energy, age, traits{}, state }
- One energy budget per agent (Bibites' master constraint): metabolism drain (+temp modifier), movement cost, digestion gains, breeding spends a fraction → offspring inherit the rest
- Death: starvation (energy ≤ 0), old age (age > lifespan trait)

### Traits & inheritance (simplified evolution)
- Each species defines 3–5 numeric traits with bounds + mutation σ (e.g., speed, size, metabolism, fertility, lifespan; coloration hue for visual variety)
- Sexes exist: male/female at birth (50/50); breeding requires opposite-sex pair in range, both mature + above energy threshold, cooldown after
- Offspring traits = average of parents' traits + Gaussian mutation, clamped to species bounds → populations drift over generations; no brain evolution — hand-written behaviors parameterized by traits

### Breeding gates & stability
- Energy-threshold breeding, maturity age, per-species cooldown, hard population cap per species
- Predation hunger-gated + saturating intake (Holling-type) — prevents runaway predation / oscillation collapse

### Plants as agents (RimWorld model)
- Stage machine: seedling → growing → fruiting (repeatable harvest) → regrowth → senescence/death
- Growth rate = base × biome fertility × light(day/night) × weather(rain boost); grazing reduces health/yield, regrows over time
- Insects pollinate flowering plants → yield boost

### Corpses & scavenging
- Death leaves a corpse entity that decays over time; fox/crow scavenge → closes the nutrient loop (Bibites' scavenger→carnivore pathway)

### Spatial partitioning
- Uniform spatial hash grid, cell ≈ interaction radius; O(n·k) neighbor queries; rebuilt per tick

## Species roster (Polish fauna)

Plants: grass, clover, cranberry bush, reed, trees (birch/oak/pine — habitat + browse/nest sites), algae, pondweed, waterlily (aquatic)

| Animal | Role | Eats | Eaten by | Phase |
|---|---|---|---|---|
| mouse | tiny fast breeder | seeds, grass | fox, owl, stork, crow | 4 |
| hare | small herbivore | grass, clover | fox, owl | 4 |
| hamster | seed eater | seeds, grass | fox, owl | 4 |
| deer (roe) | large browser | shrubs, trees, reeds | — (wolf = stretch) | 4 |
| insect | pollinator + prey | nectar/leaves | frog, stork, mouse | 4 |
| frog | marsh insectivore | insects | stork, pike, crow | 5 |
| fox | main predator + scavenger | hare, mouse, frog, eggs, corpses | — | 5 |
| stork | marsh hunter | frogs, mice | — | 5 |
| owl | nocturnal hunter | mouse, hare | — | 5 |
| crow | scavenger/generalist | corpses, seeds, eggs | — | 5 |
| carp | river omnivore | in-water plants (primary), shore plants + insects (fallback) | pike | 6 |
| pike | river predator | carp, edge-frogs (roach/trout dropped v0.12 — two parallel pairs: pike→carp, trout→roach) | — | 6 |
| roach | small fast in-water grazer | algae, pondweed | trout | 6 |
| trout | mid river predator | roach, waterline insects | — | 6 |
| duck | semi-aquatic grazer (shallow water + marsh band) | grass, clover, algae | — (predator-free) | 6 |

Stretch: wolf (top predator), beaver (terrain modifier!), moose. Evolution v2: NEAT-style brains behind a pluggable "brain" interface.

## Day/night & weather ("settings animator" pattern)

- All time-varying sim parameters sampled per tick from curves: light(t), temperature(season + weather), fertility multiplier — Bibites' "Settings Animators": named base values animated by stackable curves
- Day/night cycle (e.g., 10 min day / 4 min night at 1×): photosynthesis only in daylight; owl active at night; fox/stork diurnal
- Weather: seeded Markov chain of states clear/cloudy/rain with durations; rain → plant growth boost (+water), cold snaps → metabolism up + breeding suppressed below temp threshold

## Camera & controls

Free-flight: WASD move relative to view, mouse-drag look (no pointer lock — touchpad-friendly), arrows rotate as mouse replacement, Shift fast, wheel dolly. Space = pause. Click entity = inspect.

## UI / HUD

- Population panel per species (live counts + avg energy)
- Sim speed slider 0×(pause)–8×; fixed-timestep accumulator with max-steps clamp (Sandfall pattern)
- World-gen dialog: size slider (100–800 m, default 300), seed input, "New World" button
- Entity inspector: click any plant/animal → side panel with all live params (species, sex, age, energy, traits, state, position); selected entity highlighted

## Save / load

- Autosave to IndexedDB (fflate gzip in module worker) like Sandfall; restore on load before first render; "New World" regenerates + overwrites save

## Testing & verification

- Deterministic headless suite: scripts/sim-check.mjs → sections in scripts/checks/*.mjs; pure sim/ compiled to CJS via project tsc, run under Node
- Check sections: worldgen determinism; plant growth/regrowth cycle; grazing depletes + regrows; predator–prey stability over N steps (oscillates, no extinction); corpse decay + scavenging; breeding gates & inheritance drift; energy conservation sanity (no free energy except sunlight→plants)
- Long-run harness: 20k+ step run asserting all core species survive with population bounds; prints min/max/avg per species stability report
- Playwright e2e (global install): page loads, world generates deterministically from seed, camera responds to keys, speed slider changes sim rate, inspector opens on click — via window.__critterbox debug surface
- Per-feature gate: sim-check → tsc --noEmit → build → playwright → commit + push → deploy proof (`curl -sI https://kamilkrzywda.github.io/critterbox/` → 200; Pages may lag ~1 min after push)

## Roadmap

| Phase | Deliverable | Acceptance |
|---|---|---|
| 0 — Scaffold (v0.1.0) | Tooling, minimal Three.js scene, e2e smoke, deploy skeleton, PLAN.md | build+e2e green, deployed |
| 1 — Worldgen + terrain (v0.2.0) | Heightmap fBm, biomes, water level, size-at-gen dialog | deterministic check green; renders |
| 2 — Camera (v0.3.0) | Free-flight WASD/mouse/arrows/Shift/wheel; pause | e2e: keys move camera |
| 3 — Agent core + plants (v0.4.0) | Energy model, spatial hash, plant stage machine, instanced rendering, population panel | plant lifecycle check green |
| 4 — Herbivores (v0.5.0) | Mouse/hare/hamster/roe deer + insects; grazing, breeding/death, inheritance+sexes live | grazing/regrowth checks green |
| 5 — Predators & scavengers (v0.6.0) | Fox/stork/owl/crow; hunger-gated hunting; corpses | long-run stability green (no extinction) |
| 6 — Aquatic (v0.7.0) | Carp/pike in river volume; frog–pike interaction | aquatic checks green |
| 7 — Day/night + weather (v0.8.0) | Animator curves, Markov weather, sim effects | weather determinism check green |
| 8 — Polish (v0.9.0) | Speed slider finalization, IndexedDB autosave, inspector polish, e2e complete | full gate green, deployed |

Stretch: wolf, beaver (terrain modification), moose; evolution v2 (NEAT brains behind pluggable brain interface).

## References

- `../.docs/sandfall/` — architecture patterns + problem log (read before starting any phase)
- The Bibites (thebibites.com) — energy master constraint, corpses→scavenger niche, settings animators
- RimWorld plant wiki — per-plant growth model
- Reynolds boids/steering; gameprogrammingpatterns.com spatial partitioning; redblobgames spatial hash
