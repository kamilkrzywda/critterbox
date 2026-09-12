# Changelog

All notable changes to Critterbox are documented here. Dates in YYYY-MM-DD.

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
