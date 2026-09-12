# Changelog

All notable changes to Critterbox are documented here. Dates in YYYY-MM-DD.

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
