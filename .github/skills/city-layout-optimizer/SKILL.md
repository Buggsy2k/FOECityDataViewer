---
name: city-layout-optimizer
description: 'Rules and conventions for modifying or extending the Forge of Empires city Layout Optimizer (city-viewer/src/components/LayoutOptimizer.tsx). Use when adding placement constraints, changing phase order, adjusting road routing, tweaking heuristic scoring, fixing road classification, or hoisting invariants for performance. Covers: road classification (street_connection_level, INHERENT_NO_ROAD_TYPES), 1x1 vs 2x2 road connectivity rules, phased placement order, Town Hall anchoring, road-to-Town-Hall connectivity pruning, heuristic scoring tiebreakers, and visual parity with CityGrid. DO NOT use for general React/TypeScript questions or for editing CityGrid display logic unrelated to optimizer rules.'
---

# City Layout Optimizer

Rules and invariants for the heuristic city layout solver in [LayoutOptimizer.tsx](../../../city-viewer/src/components/LayoutOptimizer.tsx). The reference implementation for road classification and visuals is [CityGrid.tsx](../../../city-viewer/src/components/CityGrid.tsx) — keep them in sync.

## When to Use

- Adding/changing building placement constraints
- Changing phase ordering or per-phase strategy
- Modifying road routing (1x1 BFS or 2x2 block BFS)
- Adjusting heuristic scoring or tiebreakers
- Fixing road classification mismatches with `CityGrid`
- Performance work on `runAttempt` (hoist invariants)
- Updating visuals to match Grid Map

## Domain Rules

### Hard Constraint: Place Every Building

Every non-`street` building from the input data **must** appear in the final layout. The set of buildings is fixed input — only road cells are flexible.

- The Town Hall (`main_building`) is fixed at its current coordinates and seeds placement.
- All other non-`street` buildings must be placed somewhere within `availableCells`. They may be relocated freely, but none may be omitted.
- Roads (1x1 and 2x2) are the **only** flexible elements. The solver may add, remove, reroute, or change the type of any road as needed to satisfy each building's `roadLevel` requirement.
- An `unplaced` list is a **failure signal**, not an acceptable outcome. If buildings end up unplaced, prefer changes that increase placement success (e.g., more attempts, broader candidate exploration, smarter ordering) over silently dropping them.
- Across-attempt scoring already prioritizes "most placed buildings" first; preserve that ordering when adding new tiebreakers.

### Road Classification

A building's required road level is computed by `getStreetConnectionLevel(entity, type)`:

1. `root = entity.requirements?.street_connection_level ?? 0`
2. `compMax = max over entity.components[*].streetConnectionRequirement.requiredLevel ?? 0`
3. `explicitLevel = max(root, compMax)`
4. If `type ∈ INHERENT_NO_ROAD_TYPES` → return `0` (overrides any explicit level)
5. Otherwise return `explicitLevel`

`INHERENT_NO_ROAD_TYPES = { 'street', 'main_building', 'tower', 'hub_main', 'hub_part', 'decoration' }`

**Critical:** Do NOT add a fallback like `return 1` for non-inherent buildings without explicit metadata. A missing/zero level means the building has no road requirement. Mirror `CityGrid`'s `needsRoad = !inherent.has(type) && requiredStreetLevel > 0`.

### 1x1 vs 2x2 Road Connectivity

- `roadLevel >= 2` → building requires a 2x2 road. Routed via `findShortestRoad2Path` over **2x2 blocks** (BFS with stride 2). 2x2 blocks may not overlap 1x1 road cells or building footprints.
- `roadLevel === 1` → building requires any road. Routed via `findShortestCellPath` over 1x1 cells. 1x1 cells may share space with 2x2 road cells (treated as already-paved).
- `roadLevel <= 0` → building has no road requirement; placed without routing.

A 2x2 road occupies 4 cells (`makeRoad2BlockCells`), tracked in both `road2Blocks` (block keys) and `road2Cells` (cell keys for overlap checks).

### Town Hall Anchor

- The single `main_building` is the fixed anchor. If absent, return an error result.
- The Town Hall is placed first; its footprint cells seed `blockedByBuildings`.
- Road sources for routing always include `townHallEdgeCells` (the perimeter cells of the Town Hall rect that are inside `availableCells`).
- 2x2 source blocks are derived from the four block positions touching each Town Hall edge cell.

### Road Network Must Connect to Town Hall (Two-Tier Connectivity)

The road graph has two tiers with **asymmetric** connectivity rules:

- **2x2 roads connect only via other 2x2 roads.** A 2x2 block is "connected" only if it is adjacent to a Town Hall edge cell, OR adjacent (stride 2) to another connected 2x2 block. **A 2x2 block must NOT reach the Town Hall by way of any 1x1 road.**
- **1x1 roads form a chain rooted at the Town Hall, possibly via a 2x2 segment.** A 1x1 cell is "connected" if it is a Town Hall edge cell, OR 4-neighbour-adjacent to a connected 1x1 cell, OR 4-neighbour-adjacent to a cell of a connected 2x2 block. (1x1 may branch off a connected 2x2.)

Concretely: roads attached to the Town Hall may begin with one or more 2x2 segments and then branch into 1x1 chains, but a 2x2 island reachable only through a 1x1 chain is invalid and must be pruned.

**Pruning algorithm in `finalize()`:**

1. BFS over 2x2 blocks (stride-2 neighbour steps). Seed = blocks adjacent to any Town Hall edge cell that are present in `road2Blocks`. Result: `connected2x2Blocks`.
2. Compute `connected2x2Cells` = union of cells of those blocks.
3. BFS over 1x1 cells. Seed = `road1Cells` ∩ `townHallEdgeCellsBase`, plus any `road1Cells` cell 4-adjacent to a `connected2x2Cell`.
4. Delete every 1x1 cell not in the connected 1x1 set.
5. Delete every 2x2 block not in `connected2x2Blocks`.

**Placement-time invariant (already enforced):** `findShortestRoad2Path` only traverses 2x2 blocks and seeds from existing `road2Blocks` plus Town-Hall-adjacent blocks, so every newly-placed 2x2 block is, at placement time, 2x2-connected back to the Town Hall. `removeOverlappingRoad2Blocks` may later disconnect part of the chain (when a building is committed onto a 2x2 cell), which is precisely why the prune step above is necessary.

This prevents "orphan" road segments inflating the `roads` metric **and** prevents 2x2 blocks that only reach the Town Hall through 1x1 roads.

### Road Planning Must Treat the Candidate Footprint as Blocked

When `tryPlace` evaluates a candidate position for a building, the building has not yet been added to `blockedByBuildings`. Road planning (`canUseRoad2Block`, `findShortestRoad2Path`, `findShortestCellPath`) consults `blockedByBuildings` directly, so without an extra precaution it will:

- Pick 2x2 target blocks that overlap the candidate's own footprint (e.g. a perimeter cell at `(p.x, p.y)` produces a target block `blockKey(p.x - 1, p.y)` whose cells reach back into the building). The "road" is recorded, then `removeOverlappingRoad2Blocks` immediately strips it during placement commit, leaving the building disconnected.
- Route a 1x1 path *through* the candidate's interior cells.

**Rule:** Per candidate, temporarily add `cand.cells` to `blockedByBuildings` before running road planning, and remove them afterward (in every code path: success, `continue`, and after the BFS for both road levels). This is the single source of truth for "this footprint is going to exist" during scoring.

### Phased Placement Order

Per attempt, place in this strict order:

1. **Town Hall** (anchor, pre-placed).
2. **`phaseRoad2`** — buildings with `roadLevel >= 2`.
3. **`phaseRoad1`** — buildings with `roadLevel === 1`.
4. **`phaseNoRoad`** — buildings with `roadLevel <= 0`, filling remaining space.

Within each phase, attempt 0 uses deterministic sort (area desc, then id asc). Later attempts use area-desc with random tiebreak from a seeded RNG.

### Heuristic Scoring (per candidate position)

For each candidate footprint, build a `ScoredPlan` and select the best by:

1. Lowest `roadCostCells` (new road cells required).
2. Tiebreak: lowest `perimeterPenalty` = `area * max(0, roadAdjacentPerimeterCells - 1)` (footprint-size bias, see below).
3. Tiebreak: lowest `packScore` = `(x - bounds.minX) + (y - bounds.minY)` (top-left bias for bottom-right openness).

For `roadLevel <= 0`, only `packScore` matters (road cost and perimeter penalty are 0).

Across attempts, pick the best `AttemptResult` by:

1. Most placed buildings.
2. Tiebreak: fewest road cells.
3. Tiebreak: most empty cells.

#### Packing Direction (open space in bottom-right)

Candidate positions are pre-sorted by `packScore` ascending so no-road buildings naturally settle toward the **top-left** of the available bounds.

- Metric: `packScore = (x - bounds.minX) + (y - bounds.minY)`. Smaller = more top-left.
- Town Hall is fixed; it is not affected by this preference.
- **No-road buildings only.** Road-needing buildings use `thDist` (see below), NOT `packScore`, as their primary tiebreaker — packing them into the corner strands them far from the road network.

If a future requirement changes the desired open-space corner (e.g., bottom-left), invert the relevant axis in `packScore` rather than introducing a separate metric.

#### Road-Needing Buildings Cluster Around the Town Hall (`thDist`)

Each candidate carries a precomputed `thDist` = min Manhattan distance from any of the candidate's perimeter cells to any Town Hall edge cell. For road-needing buildings the `scored` sort is `(lb asc, thDist asc, packScore asc)`.

**Why:** the lb BFS is admissible (ignores building obstacles), so it under-counts. After many buildings are placed, the real per-candidate BFS (which respects `blockedByBuildings`) often fails for far-from-TH candidates even though their lb says they're cheap. If the tiebreaker is `packScore`, road-needing buildings get placed in the top-left corner where the road network can never reach them, end up unplaced, and finally get dumped via last-resort with no road served.

Diagnostic signal of this bug: optimizer report shows all buildings placed but `Buildings missing road service: N` is high and the road network is a small snake near the Town Hall while road-needing buildings sit far away.

Roads grow organically from the Town Hall (primary metric is `roadCostCells`); `thDist` keeps road-needing footprints close enough that the real-BFS road path can actually be built.

#### Candidate Selection: Lower-Bound BFS + Early Termination (no fixed cap)

`tryPlace` does **not** cap the candidate set. Instead it uses a multi-source lower-bound BFS to score candidates cheaply, sorts them, and runs the per-candidate full BFS only as needed:

1. Filter candidates whose footprint is currently unblocked.
2. For `roadLevel <= 0`: return the first candidate (already sorted by `packScore`). No BFS needed.
3. For `roadLevel >= 1`:
   - Compute an **admissible lower-bound distance map** `lbMap` from the current road network. The BFS ignores building obstacles (cells just need to be in `availableCells`), so distances under-estimate the true road cost.
     - Road1: 1x1 BFS seeded from `townHallEdgeCellsBase ∪ road1Cells ∪ road2Cells`.
     - Road2: stride-2 BFS over 2x2 blocks seeded from `buildRoad2SourceBlocks()` (existing 2x2 blocks + town-hall-adjacent blocks).
   - For each candidate, compute `lb = min over usablePerimeter of lbMap[cell]` (× 4 for road2 since each new block adds 4 cells). Skip blocks/cells that overlap the candidate footprint.
   - Sort candidates by `(lb, packScore)`. For `attemptIdx > 0`, shuffle within each `lb` bucket using the per-attempt RNG to explore alternative equally-cheap placements.
   - Iterate in order. For each candidate: temporarily add `cand.cells` to `blockedByBuildings`, run the real per-candidate BFS, restore. Compare to `best` via `isBetter`.
   - **Early termination:** stop as soon as `s.lb >= best.roadCostCells` (no remaining candidate can improve the best plan, since `lb` is an admissible lower bound).

This eliminates the previous fixed cap (which silently dropped good cheap-road candidates whenever they fell outside the top-K by `packScore`), while keeping per-building work bounded in practice (most placements terminate after very few real BFS calls because the cheapest-road candidate is usually found among the first few `lb=0` or `lb=1` entries).

#### Footprint-Size Bias (large buildings prefer low road-perimeter overlap)

Empirical heuristic: **the larger a building, the more efficient the layout becomes when its footprint shares as little of its perimeter as possible with road cells.** A large building that hugs a long stretch of road wastes road tiles that could have served multiple smaller buildings instead.

When scoring or extending the heuristic, consider biasing larger-footprint buildings toward placements where:

- The new road segment serving them is short (already covered by `roadCostCells`), AND
- The portion of the building's perimeter adjacent to existing/new road cells is minimized beyond the single connection required.

Practical implementations to consider when tuning:

- Add a perimeter-overlap penalty proportional to `width * length` (e.g., `overlapPenalty = footprintArea * roadAdjacentPerimeterCells`). Apply it as a tertiary tiebreaker after `roadCostCells` and before `distToTownHall`, or fold it into the road cost with a small weight.
- Prefer corner/edge positions for large buildings so most of their perimeter abuts other buildings or the map boundary, not roads.
- Place 2x2-road buildings (which are typically large) such that exactly one 2x2 block touches their perimeter, not multiple.

Do NOT eliminate placements that overlap roads — they may still be the only feasible option. Only bias the choice when multiple equally-feasible candidates exist.

### Visual Parity with CityGrid

| Element | Color | Notes |
|---|---|---|
| Background | `#1a1a2e` | Per unlocked area |
| Grid pattern | `#2a2a4e` stroke 0.3 | 1x1 cell grid |
| 1x1 road | `#616161` opacity 0.9 | |
| 2x2 road | `#7b7b7b` opacity 0.9 | Distinct shade |
| Buildings | `getBuildingColor(type)` | Shared util |
| 2x2-required building border | `rgba(255,255,255,0.9)`, width 1.6 | Thicker, light |
| Standard building border | `rgba(0,0,0,0.35)`, width 0.8 | |
| Hover border | `#ffffff`, width 2.2 | |

`PREVIEW_CELL = 12` px must match Grid Map's preview cell size.

## Performance: Hoist Invariants Out of Per-Attempt Code

Anything that does not depend on `attemptIdx` or per-attempt mutable state MUST be computed once in the outer `useMemo`, not inside `createAttemptIterator`. The solver runs many attempts.

**Currently hoisted (do not move back):**

- `townHallRectCells` — Town Hall footprint cells (used to seed `blockedByBuildings`).
- `townHallEdgeCellsBase` and `townHallEdgeParsed` — pre-filtered + pre-parsed edge cells.
- `placedTownHallTemplate` — invariant Town Hall placed-entry literal.
- `phaseRoad2Base` / `phaseRoad1Base` / `phaseNoRoadBase` — invariant phase partitions.
- `phaseRoad2Sorted0` / `phaseRoad1Sorted0` / `phaseNoRoadSorted0` — pre-sorted deterministic order for `attemptIdx === 0`.
- `baseCandidatesByBuildingId` — per-building candidate footprints sorted by `packScore`, with pre-computed `cells[]` and `perimeterAvail[]`.

**Must remain inside `createAttemptIterator`** (capture per-attempt mutable state):

- `blockedByBuildings`, `road1Cells`, `road2Cells`, `road2Blocks`, `placed`, `unplaced`.
- Closures `canUseRoad2Block`, `roadAnySources`, `buildRoad2SourceBlocks`, `removeOverlappingRoad2Blocks`, `tryPlace`, `finalize`.
- The candidate filter (precomputed cells × current `blockedByBuildings`) and per-attempt random shuffle.

**Rule:** Before adding new computation inside the per-attempt closure, check whether it depends on `attemptIdx` or mutable per-attempt state. If not, hoist it.

## Async Iterator Pattern (per-building progress)

`createAttemptIterator(attemptIdx)` returns an object with `step()` that places **one building per call**, returning either:

- `{ done: false, attemptIdx, phase, placedInPhase, totalInPhase, totalPlaced, totalBuildings, lastBuildingName }`
- `{ done: true, result: AttemptResult }` (after all buildings placed and finalize/prune complete)

The solver `useEffect` drives this via `setTimeout(processChunk, 0)` with `stepsPerChunk = 8`. After each chunk, it calls `setProgress` so the UI shows: current attempt N / total, current phase (`road2`, `road1`, `noRoad`, `finalizing`), per-phase placed / total, total placed / total, and last building name.

**Rule:** When adding new long-running work, integrate it as additional `step()` cases (or a new phase) so the UI keeps updating. Do not add synchronous loops over all buildings inside a single `step()` call.

## Hard Constraint Enforcement

`finalize()` enforces "every building placed" in three escalating tiers:

1. **Normal pass** — `tryPlace(b, /*relaxed=*/false)` with full scoring (lb, perimeter penalty, packScore).
2. **Relaxed retry** — for anything still unplaced, `tryPlace(b, /*relaxed=*/true)` removes the perimeter penalty and exhausts the candidate list. Sort the retry queue by **area DESC** so large buildings get first pick of remaining gaps.
3. **Last-resort placement** — for anything still unplaced after relaxed retry, scan candidates for any unblocked footprint and commit it **without extending roads**. Track these as `lastResortPlacements` in metrics.

Last-resort placements are valid (the building IS placed, satisfying the hard constraint) but inferior — the connectivity report's `unservedRoad1Buildings` / `unservedRoad2Buildings` will flag them. Roads are flexible; the user can add a road manually after the fact.

**Cross-attempt comparator must penalise last-resort placements.** Order: (1) most placed, (2) **fewest `lastResortPlacements`**, (3) fewest road cells, (4) most empty cells. Without step 2, an attempt that gave up early and dumped buildings via last-resort would unfairly win the "fewer road cells" tiebreaker against an attempt that legitimately served everything with a denser road network.

## Road-Rescue Pass (between road1 and noRoad phases)

`runRoadRescuePass()` walks every placed road-needing building and, for each one whose perimeter doesn't already touch a road or TH edge cell, attempts a real BFS from the existing road network (TH edges + roads) to a usable perimeter cell of the building. If a path exists through empty cells, commit it as new road; if not, leave the building unserved.

**The rescue MUST run between the road1 and noRoad phases — NOT in `finalize()`.** The noRoad phase fills nearly every empty cell (typical coverage ~95%), leaving no corridors for the rescue BFS to path through. Empirically, running rescue in `finalize()` adds zero road cells in dense layouts.

Implementation pattern (in the `step()` iterator): set a `preNoRoadRescueDone` flag; on the first `step()` call where `cursor` has crossed from road1 into noRoad territory and the flag is unset, run rescue and return a synthetic step result (no building placed). The next `step()` proceeds normally to noRoad placement, which respects the new road cells via the existing footprint-vs-road filter.

**Why it works there:** the road1 phase has placed every building that needs a road, and there's still ~50%+ empty cells available as path corridors. The rescue paths through them. Then noRoad placement fills what's left of the empty space, automatically routing around the new roads.

Process the rescue queue **in TH-distance descending order** so the road tree extends outward and intermediate buildings are served incidentally by the path that reaches the furthest one.

Diagnostic signal of a missing/broken rescue pass (or one running in the wrong place): optimizer report shows everything placed (`unplacedBuildings: 0`) but `Buildings missing road service: N` is high (e.g. 78 of 99) and the road network has far fewer cells than placed road-needing buildings.

## Building Footprints Must Never Overlap Existing Roads

Candidate filtering in `tryPlace` must reject any footprint that overlaps a cell already in `road1Cells` or `road2Cells`, in addition to `blockedByBuildings`. **All three sets matter.**

Why: the placement commit step adds footprint cells to `blockedByBuildings`. If the footprint also overlaps existing road cells, those road cells must either be deleted (silently severing the network and orphaning every building reached through that segment) or left intact (a road cell beneath a building, which violates the visual/connectivity model). Neither is acceptable.

This applies to **every** placement, including the no-road fast path — a no-road building placed by packScore alone will happily stomp through the road network the road1 phase just built unless this filter rejects road-overlapping candidates.

Diagnostic signal of this bug: optimizer output has very few road cells (e.g. 1) and many road-needing buildings reported as "unserved" or unplaced. If you see `road1Cells: 1, unservedRoad1Buildings: 31`, suspect this rule first.

## React / Lifecycle Constraints

- All hooks must be unconditional (no early returns before hook calls). Use `successfulResult` narrowing for render-time conditionals.
- Heavy work in the outer `useMemo` is gated by `hasStarted`; do not run it before the user clicks Start.
- The async solver chunks step calls via `setTimeout(processChunk, 0)`. Cancel via the `cancelled` flag in cleanup.
- On Start, immediately call `setProgress(STARTING_PROGRESS)` so the UI updates before the heavy `useMemo` runs.

## Checklist When Editing the Optimizer

1. Does the change affect road classification? Update **both** `LayoutOptimizer` and `CityGrid` (or extract a shared helper).
2. Does the new logic touch invariant data? Hoist it out of the per-attempt closure.
3. Does it add a new `roadLevel` tier? Update phase split, `INHERENT_NO_ROAD_TYPES` semantics, and `phaseStats`.
4. Does it create roads? Ensure post-placement connectivity pruning still removes orphans.
5. Does it add long-running work? Integrate it into the `step()` iterator so UI progress keeps updating.
6. Does it change packing direction? Update `packScore` (single source of truth).
7. Run `npm run build` from `city-viewer/` to verify TypeScript strict + Vite build pass.
