# Critterbox — AGENTS.md

Instructions for AI agents working on this repo. Food chain sim: three.js + vite stack, pure-TS sim core. v0.11.0.

## Context budget (IMPORTANT)

Context is expensive. These rules are hard requirements, not suggestions:

- **Never read every file.** Only read files relevant to current task.
- Never read an entire file when a slice suffices: prefer the relevant part only — use `offset`/`limit`, grep for the symbol or keyword you need, then stop. Follow the 2000-line read cap; large files (PLAN.md, CHANGELOG.md, sim.ts) want targeted reads, not full passes.
- Find what you need via glob/grep/targeted Read, then stop reading.
- Single agent work: don't read whole directories in parallel when you can `ls` a file list first.
- When a task spans several files, read them in one batch, not one-by-one loops.
- Skip docs you know: PLAN.md/README/CHANGELOG are already summarized in this file; only open them if the task needs details not captured here.

## Architecture (brief)

- `src/main.ts` — boot, fixed-timestep accumulator (30 steps/s, max-steps clamp), `window.__critterbox` debug surface
- `src/sim/` — PURE TS (no three.js, no DOM) → headlessly testable. Agents (plants/animals self-registering species), sim core + step loop, spatial hash grid, energy model, corpses, environment (day/night + weather animator curves), registry, deterministic per-agent hash RNG (`agentRand`)
- `src/worldgen/` — seeded fBm value noise → heightmap, biomes, water level; size + seed chosen at gen time
- `src/render/` — three.js: terrain mesh, camera (free-flight), InstancedMesh per species
- `src/ui/` — world-gen dialog, population panel, env indicator, entity inspector
- `src/save/` — fflate gzip in module worker → IndexedDB autosave (30 s), restore-on-load before first render
- `scripts/sim-check.mjs` + `scripts/checks/*.mjs` — headless deterministic suite; `e2e/` — Playwright specs (global install, webServer :4173)

## Conventions

- Deterministic RNG everywhere (seeded, no Math.random). Same seed+size → identical world/run.
- Day = 3600 ticks (~2 min at 1×), night = 1500, year = 3 cycles. Environment is pure function of (seed, step).
- Species: self-registering modules; numeric traits with bounds + mutation; sexes, breeding gates (maturity/energy/cooldown/popCap); hunger-gated hunting with saturating intake.
- English species names throughout (mouse/hare/hamster/deer/insect/frog/fox/stork/owl/crow/carp/pike; grass/clover/cranberry/reed/tree).
- All HUD text lowercase.
- New code must mirror existing patterns.

## Verification (per change)

- Run only tests connected to your change. Full sim-check is slow; `node scripts/sim-check.mjs` runs everything (20k-step stability section included) — target a single section when possible. Never blind-run the full suite for a small change.

## Commits

- Commit every coherent part of a change separately (nice commit packages per feature).
- Never commit unless user explicitly asks.

## CHANGELOG

- Keep-a-Changelog format. Always update CHANGELOG.md for any user-visible change (Added/Changed/Fixed sections, `## [x.y.z] - YYYY-MM-DD` header, bump version in package.json accordingly).

## Plan

- PLAN.md is source of truth. Update it after each part of work is done (decisions, roadmap state, species tuning).