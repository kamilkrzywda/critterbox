# Changelog

All notable changes to Critterbox are documented here. Dates in YYYY-MM-DD.

## [Unreleased]

### Changed
- All animal species renamed to English across code and docs: mouse, hare, hamster, deer, insect, frog, fox, stork, owl, crow (species files, registry ids, palettes, population-panel labels, e2e specs, headless checks, PLAN.md roster and this changelog)

### Fixed
- Plants no longer drift — positions immutable after seeding: the plant renderer was instancing EVERY agent (animals included) because `PlantRenderer.sync` lacked the kind filter its animal-renderer counterpart has, so each animal also rendered as a generic cone that followed it around — reading as "visibly moving plants". Plant instances are now written once per agent (plus on stage/growth-bucket change) and never move; sim-side plant positions were already provably static (new headless check asserts byte-identical positions after 4000 steps, e2e asserts no animal species ever enters the plant renderer)
- Deer/tree and all-species world-space scales corrected with per-species size mapping: the raw size trait was used as a geometry scale multiplier on ~1 m base boxes, making deer (size trait 3.5–5.5) up to ~10 m tall while trees were only ~6 m. Each species now declares `bodySize` in world-space meters at its size-trait midpoint and the renderer maps the full trait range onto a fixed ±25% band (`visualScale`, base.ts); tree geometry rebuilt from explicit constants (12 m total, 4 m canopy radius — within the 8–15 m / 3–6 m sanity bands). The size trait's effect on energy capacity is unchanged. New headless check guards deer-max-height < tree-min-total-height and per-species dimension targets

## [0.6.0] - 2026-09-12

### Added
- Predators & scavengers complete the food chain: fox, stork, owl, crow + frog (marsh insectivore with cranberry fallback). Hunger-gated hunting — a predator only enters hunt state below its `hungerThreshold` fraction of capacity — with saturating intake: each kill raises satiation (scaled by how much of the predator's capacity the meal fills), so quick successive kills pay diminishing returns and prey patches can't be stripped
- Corpses & scavenging: every animal death (starvation, old age, predation) leaves a decaying corpse entity (`Sim.corpses`, not agents — linear scan); fox & crow feed on carcasses via `scavengerDecide` (a corpse in range beats live prey when hungry), closing the nutrient loop
- 20k-step population-stability harness (`scripts/checks/stability.mjs`) — the Phase 5 acceptance gate: every plant and animal must survive with per-species min ≥ 1, max ≤ popCap; prints a per-species min/max/avg stability report (seed 1337, default world)
- Headless predator checks (`scripts/checks/predators.mjs`): predation (kill + energy gain + corpse at death location), hunger gating (a full fox never hunts with prey nearby), corpse decay + crow scavenging, saturating intake (diminishing yield per kill)

### Changed
- Long-run stability tuning (all deterministic, seed 1337): family-cluster seeding for sparse species (guaranteed opposite-sex pairs so breeding starts before the initial cohort's old-age wave hits), roost-anchored wander + relocation for foxes/owls (unanchored random-walk diffusion carried them into "prey deserts" between clusters, past their ~45 m foraging range), directional foraging (a hungry animal with nothing in kill range steers toward the nearest food beyond sense radius instead of wandering blindly), size-scaled satiation so small-meal generalists aren't over-braked
- Plant edibility is now stage/energy-based: unestablished shoots (non-fruiting below 60% of maxEnergy) are inedible — one bite would drop them under the regrowth floor; replaces an earlier age-based grace period. Seed dispersal gained biome fidelity (a seedling only establishes in the parent's biome — without it, marsh cranberries crept ~40 m into dry meadow over long runs and grew unbounded)
- Population caps: frog 90 (the marsh food base can't support more), per-species tuning of hunger gates / breeding cooldowns / mating ranges for a stable 20k-step run — all core species hold with margin (mice/hares/hamsters/frogs/crows at cap, foxes ~8–15, owls ~6–10, storks 4–8)

## [0.5.0] - 2026-09-12

### Added
- Herbivores — mouse/hare/hamster/deer + insect pollinators complete the food chain base: per-species energy budgets, grazing behavior with plant regrowth incl. deer tree-browsing (trees recover, not killed by normal browsing), insect pollination boosting plant yield/growth (per-plant cooldown), mice eat insects
- Sexes, breeding gates (maturity/energy/cooldown/pop-cap) and simplified trait inheritance with mutation on birth for all five species; deterministic per-biome seeding (~60 mice, ~24 hares, ~18 hamsters, ~8 deer, ~250 insect clusters on the default 300×300 world)
- Animal instanced rendering (per-species palette: hare medium brown, hamster tan stocky, deer large reddish-brown, insect tiny dark speck); population panel extended with a row per animal species

### Fixed
- Terrain mesh — restored missing triangle per heightmap cell (the second quad triangle was split along the wrong diagonal, leaving a triangular hole in every land cell); added headless geometry regression check (`scripts/checks/terrain.mjs`)

## [0.4.0] - 2026-09-12

### Added
- Pure-TS sim core — agent schema, deterministic stateless rng (`agentRand` + Gaussian), uniform spatial hash grid (flat counting-sort, no per-cell churn), shared energy model
- Plants as individual agents with a RimWorld-style stage machine (seedling → growing → fruiting → regrowth → senescence) and a `graze()` API; grass/clover/cranberry/reed/trees self-register into the species registry
- Deterministic world seeding per biome (~13k plants on the default 300×300 world); trees on a ~10 m lattice with birch/oak/pine variants
- Instanced rendering (one InstancedMesh per species, tree trunk+canopy share slot mapping) with incremental change-feed updates and per-instance colour jitter from `agentRand`
- Population panel overlay — one row per plant species with live count + average energy, refreshed ~4 Hz
- `window.__critterbox` debug surface extended: `agentCount` + `populations { [species]: {count, avgEnergy} }`; speed-multiplier hook left in the accumulator for Phase 8
- Headless checks (`scripts/checks/plants.mjs`, `spatial.mjs`) — determinism, growth/graze/regrowth cycle, senescence + overgrazing death, population sanity, spatial query vs brute force

## [0.3.0] - 2026-09-12

### Added
- Free-flight camera — WASD move, mouse-drag look (no pointer lock), arrow-key rotation as mouse replacement, Shift ×4 speed, wheel dolly
- Space pause with PAUSED overlay indicator; sim steps gated while paused, rendering continues
- `window.__critterbox` debug surface extended: live `camera {pos,yaw,pitch}` + `paused` / `setPaused(bool)`
- Playwright e2e camera spec (movement, rotation, dolly, pause, input-focus key guard)

## [0.2.0] - 2026-09-12

### Added
- Heightmap worldgen with seeded fBm noise (4 octaves, absolute feature scale — comparable relief across world sizes)
- Biomes meadow/forest/marsh/grassland from elevation × moisture; fixed water level carves rivers/lakes
- Terrain rendering: indexed heightmap mesh with per-biome vertex colors + translucent water plane
- Size-at-gen dialog (100–800 m, default 300) with seed input and live "New World" rebuild
- `window.__critterbox` debug surface (seed/size/waterLevel/heightAt/biomeAt/regenerate)
- Fixed-timestep accumulator skeleton in the render loop (30 steps/s, max-steps clamp) for Phase 3
- Headless determinism checks (`scripts/checks/worldgen.mjs`) + tsc-CJS compile step in sim-check runner
- Playwright e2e worldgen spec (debug surface + New World rebuild)

## [0.1.0] - 2026-09-12

### Added
- Project scaffold: Vite + TypeScript strict + Three.js, mirroring Sandfall house conventions
- PLAN.md — single source of truth (roadmap v0.1.0 → v0.9.0)
- Minimal placeholder scene (ground plane + title overlay); real worldgen lands in v0.2.0
- Headless sim-check runner stub (`scripts/sim-check.mjs`)
- Playwright e2e smoke test (global install convention), webServer on :4173
- Deploy skeleton: nginx:alpine behind shared Traefik at critters.dev.kkhost.pl
