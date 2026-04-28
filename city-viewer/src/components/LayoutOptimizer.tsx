import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useCityData } from '../context/CityDataContext';
import type { CityEntity } from '../types/citydata';
import { resolveBuildingName } from '../utils/dataProcessing';
import { getGridBounds, getPlacedBuildings, getBuildingColor, type GridBounds } from '../utils/gridUtils';
import { buildLayoutReport, downloadTextFile, copyTextToClipboard, type ExportBuilding } from '../utils/layoutExport';

const PREVIEW_CELL = 12;

interface Rect {
  x: number;
  y: number;
  w: number;
  l: number;
}

interface LayoutBuilding {
  id: number;
  name: string;
  type: string;
  width: number;
  length: number;
  roadLevel: number;
}

interface PlacedLayoutBuilding extends LayoutBuilding {
  x: number;
  y: number;
}

interface AttemptResult {
  placed: PlacedLayoutBuilding[];
  unplaced: LayoutBuilding[];
  road1Cells: Set<string>;
  road2Blocks: Set<string>;
  metrics: {
    roadCells: number;
    roadEntities: number;
    road1Entities: number;
    road2Entities: number;
    emptyCells: number;
    /** Buildings placed via the last-resort fallback (no road served). */
    lastResortPlacements: number;
    phaseStats: {
      road2: { total: number; placed: number; unplaced: number };
      road1: { total: number; placed: number; unplaced: number };
      noRoad: { total: number; placed: number; unplaced: number };
    };
  };
}

interface OptimizerCurrentMetrics {
  roads: number;
  roadCells: number;
  emptyCells: number;
  road1Entities: number;
  road2Entities: number;
}

type SolverPhase = 'road2' | 'road1' | 'noRoad' | 'finalizing' | 'idle';

interface AttemptStepProgress {
  done: false;
  attemptIdx: number;
  phase: 'road2' | 'road1' | 'noRoad';
  placedInPhase: number;
  totalInPhase: number;
  totalPlaced: number;
  totalBuildings: number;
  lastBuildingName: string;
}

interface AttemptStepDone {
  done: true;
  result: AttemptResult;
}

type AttemptStepResult = AttemptStepProgress | AttemptStepDone;

interface AttemptIterator {
  step: () => AttemptStepResult;
}

interface SolverProgress {
  running: boolean;
  attempt: number;
  attempts: number;
  phase: SolverPhase;
  phasePlaced: number;
  phaseTotal: number;
  totalPlaced: number;
  totalBuildings: number;
  lastBuildingName: string;
}

const IDLE_PROGRESS: SolverProgress = {
  running: false,
  attempt: 0,
  attempts: 0,
  phase: 'idle',
  phasePlaced: 0,
  phaseTotal: 0,
  totalPlaced: 0,
  totalBuildings: 0,
  lastBuildingName: '',
};

const STARTING_PROGRESS: SolverProgress = {
  running: true,
  attempt: 1,
  attempts: 1,
  phase: 'road2',
  phasePlaced: 0,
  phaseTotal: 0,
  totalPlaced: 0,
  totalBuildings: 0,
  lastBuildingName: '',
};

function phaseLabel(phase: SolverPhase): string {
  switch (phase) {
    case 'road2': return '2x2-road buildings';
    case 'road1': return '1x1-road buildings';
    case 'noRoad': return 'no-road buildings';
    case 'finalizing': return 'finalizing & pruning roads';
    default: return 'idle';
  }
}

interface OptimizerPrepared {
  bounds: GridBounds;
  availableCells: Set<string>;
  attempts: number;
  totalBuildings: number;
  current: OptimizerCurrentMetrics;
  createAttemptIterator: (attemptIdx: number) => AttemptIterator;
}

interface OptimizerSuccess {
  bounds: GridBounds;
  placed: PlacedLayoutBuilding[];
  unplaced: LayoutBuilding[];
  road1Cells: Set<string>;
  road2Blocks: Set<string>;
  availableCells: Set<string>;
  attempts: number;
  metrics: {
    current: OptimizerCurrentMetrics;
    optimized: OptimizerCurrentMetrics;
  };
  phaseStats: {
    road2: { total: number; placed: number; unplaced: number };
    road1: { total: number; placed: number; unplaced: number };
    noRoad: { total: number; placed: number; unplaced: number };
  };
}

type OptimizerResultState = OptimizerSuccess | { error: string; bounds: GridBounds } | null;

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function blockKey(x: number, y: number): string {
  return `${x},${y}`;
}

function parseKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

function rectCells(rect: Rect): string[] {
  const cells: string[] = [];
  for (let dx = 0; dx < rect.w; dx++) {
    for (let dy = 0; dy < rect.l; dy++) {
      cells.push(cellKey(rect.x + dx, rect.y + dy));
    }
  }
  return cells;
}

function getEdgeCells(rect: Rect): string[] {
  const edges: string[] = [];
  for (let dx = -1; dx <= rect.w; dx++) {
    for (let dy = -1; dy <= rect.l; dy++) {
      const onEdge = dx === -1 || dx === rect.w || dy === -1 || dy === rect.l;
      const isCorner = (dx === -1 || dx === rect.w) && (dy === -1 || dy === rect.l);
      if (!onEdge || isCorner) continue;
      edges.push(cellKey(rect.x + dx, rect.y + dy));
    }
  }
  return edges;
}

const INHERENT_NO_ROAD_TYPES = new Set(['street', 'main_building', 'tower', 'hub_main', 'hub_part', 'decoration']);

function getStreetConnectionLevel(entity: CityEntity | undefined, buildingType: string): number {
  if (!entity) return 0;
  const root = entity.requirements?.street_connection_level ?? 0;
  let compMax = 0;
  for (const comp of Object.values(entity.components ?? {})) {
    const level = (comp as { streetConnectionRequirement?: { requiredLevel?: number } })
      .streetConnectionRequirement?.requiredLevel ?? 0;
    if (level > compMax) compMax = level;
  }
  const explicitLevel = Math.max(root, compMax);
  if (INHERENT_NO_ROAD_TYPES.has(buildingType)) return 0;
  return explicitLevel;
}

function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function findShortestCellPath(
  sourceCells: Set<string>,
  targetCells: Set<string>,
  availableCells: Set<string>,
  blockedByBuildings: Set<string>,
): string[] | null {
  if (sourceCells.size === 0 || targetCells.size === 0) return null;

  for (const s of sourceCells) {
    if (targetCells.has(s)) return [];
  }

  const queue: string[] = [];
  const prev = new Map<string, string | null>();

  for (const src of sourceCells) {
    if (!availableCells.has(src)) continue;
    if (blockedByBuildings.has(src)) continue;
    queue.push(src);
    prev.set(src, null);
  }

  let found: string | null = null;
  for (let i = 0; i < queue.length; i++) {
    const curr = queue[i];
    if (targetCells.has(curr)) {
      found = curr;
      break;
    }

    const { x, y } = parseKey(curr);
    const neighbors = [
      cellKey(x + 1, y),
      cellKey(x - 1, y),
      cellKey(x, y + 1),
      cellKey(x, y - 1),
    ];

    for (const n of neighbors) {
      if (prev.has(n)) continue;
      if (!availableCells.has(n)) continue;
      if (blockedByBuildings.has(n)) continue;
      prev.set(n, curr);
      queue.push(n);
    }
  }

  if (!found) return null;

  const pathRev: string[] = [];
  let cursor: string | null = found;
  while (cursor != null && prev.has(cursor)) {
    pathRev.push(cursor);
    cursor = prev.get(cursor) ?? null;
  }

  pathRev.reverse();
  return pathRev;
}

function findShortestRoad2Path(
  sourceBlocks: Set<string>,
  targetBlocks: Set<string>,
  canUseBlock: (x: number, y: number) => boolean,
): Array<{ x: number; y: number }> | null {
  if (sourceBlocks.size === 0 || targetBlocks.size === 0) return null;

  for (const s of sourceBlocks) {
    if (targetBlocks.has(s)) return [];
  }

  const queue: string[] = [];
  const prev = new Map<string, string | null>();

  for (const src of sourceBlocks) {
    const { x, y } = parseKey(src);
    if (!canUseBlock(x, y)) continue;
    queue.push(src);
    prev.set(src, null);
  }

  let found: string | null = null;
  for (let i = 0; i < queue.length; i++) {
    const curr = queue[i];
    if (targetBlocks.has(curr)) {
      found = curr;
      break;
    }

    const { x, y } = parseKey(curr);
    const neighbors = [
      blockKey(x + 2, y),
      blockKey(x - 2, y),
      blockKey(x, y + 2),
      blockKey(x, y - 2),
    ];

    for (const n of neighbors) {
      if (prev.has(n)) continue;
      const pos = parseKey(n);
      if (!canUseBlock(pos.x, pos.y)) continue;
      prev.set(n, curr);
      queue.push(n);
    }
  }

  if (!found) return null;

  const pathRev: string[] = [];
  let cursor: string | null = found;
  while (cursor != null && prev.has(cursor)) {
    pathRev.push(cursor);
    cursor = prev.get(cursor) ?? null;
  }

  pathRev.reverse();
  return pathRev.map(parseKey);
}

function makeRoad2BlockCells(x: number, y: number): string[] {
  return [
    cellKey(x, y),
    cellKey(x + 1, y),
    cellKey(x, y + 1),
    cellKey(x + 1, y + 1),
  ];
}

export default function LayoutOptimizer() {
  const { data } = useCityData();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredBuilding, setHoveredBuilding] = useState<PlacedLayoutBuilding | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [result, setResult] = useState<OptimizerResultState>(null);
  const [progress, setProgress] = useState<SolverProgress>(IDLE_PROGRESS);
  const [hasStarted, setHasStarted] = useState(false);
  const [runVersion, setRunVersion] = useState(0);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  const prepared = useMemo<OptimizerPrepared | { error: string; bounds: GridBounds } | null>(() => {
    if (!data || !hasStarted) return null;

    const allPlaced = getPlacedBuildings(data);
    const bounds = getGridBounds(data.UnlockedAreas, allPlaced);

    const availableCells = new Set<string>();
    for (const area of data.UnlockedAreas) {
      for (let dx = 0; dx < area.width; dx++) {
        for (let dy = 0; dy < area.length; dy++) {
          availableCells.add(cellKey(area.x + dx, area.y + dy));
        }
      }
    }

    const currentBuildings = allPlaced.filter(b => b.entry.type !== 'street');
    const currentRoads = allPlaced.filter(b => b.entry.type === 'street');
    const currentRoad1Entities = currentRoads.filter(r => r.width === 1 && r.length === 1).length;
    const currentRoad2Entities = currentRoads.filter(r => r.width === 2 && r.length === 2).length;

    let currentBuildingCells = 0;
    for (const b of currentBuildings) currentBuildingCells += b.width * b.length;

    const currentRoadCells = new Set<string>();
    for (const r of currentRoads) {
      for (let dx = 0; dx < r.width; dx++) {
        for (let dy = 0; dy < r.length; dy++) {
          const key = cellKey(r.x + dx, r.y + dy);
          if (availableCells.has(key)) currentRoadCells.add(key);
        }
      }
    }

    const currentEmptyCells = Math.max(0, availableCells.size - currentBuildingCells - currentRoadCells.size);
    const currentRoadEntities = currentRoads.length;

    const mainBuilding = allPlaced.find(b => b.entry.type === 'main_building');
    if (!mainBuilding) {
      return {
        error: 'No Town Hall (main_building) found in the loaded city data.',
        bounds,
      };
    }

    const townHallRect: Rect = {
      x: mainBuilding.x,
      y: mainBuilding.y,
      w: mainBuilding.width,
      l: mainBuilding.length,
    };

    const buildings: LayoutBuilding[] = [];
    for (const b of allPlaced) {
      if (b.entry.type === 'street') continue;
      if (b.entry.type === 'main_building') continue;

      const entity = data.CityEntities[b.entry.cityentity_id];
      buildings.push({
        id: b.entry.id,
        name: resolveBuildingName(b.entry.cityentity_id, data),
        type: b.entry.type,
        width: b.width,
        length: b.length,
        roadLevel: getStreetConnectionLevel(entity, b.entry.type),
      });
    }

    // ---- Attempt-invariant precomputation (hoisted out of attempts) ----
    const townHallRectCells = rectCells(townHallRect);
    // Edge cells aren't in townHallRect, so blocked-state at attempt start excludes them.
    const townHallEdgeCellsBase = getEdgeCells(townHallRect).filter(c => availableCells.has(c));
    const townHallEdgeParsed = townHallEdgeCellsBase.map(parseKey);

    const placedTownHallTemplate: PlacedLayoutBuilding = {
      id: mainBuilding.entry.id,
      name: resolveBuildingName(mainBuilding.entry.cityentity_id, data),
      type: 'main_building',
      width: townHallRect.w,
      length: townHallRect.l,
      roadLevel: 0,
      x: townHallRect.x,
      y: townHallRect.y,
    };

    const phaseRoad2Base = buildings.filter(b => b.roadLevel >= 2);
    const phaseRoad1Base = buildings.filter(b => b.roadLevel === 1);
    const phaseNoRoadBase = buildings.filter(b => b.roadLevel <= 0);

    const sortByAreaDeterministic = (arr: LayoutBuilding[]): LayoutBuilding[] => {
      const next = [...arr];
      next.sort((a, b) => {
        const areaA = a.width * a.length;
        const areaB = b.width * b.length;
        if (areaB !== areaA) return areaB - areaA;
        return a.id - b.id;
      });
      return next;
    };
    const phaseRoad2Sorted0 = sortByAreaDeterministic(phaseRoad2Base);
    const phaseRoad1Sorted0 = sortByAreaDeterministic(phaseRoad1Base);
    const phaseNoRoadSorted0 = sortByAreaDeterministic(phaseNoRoadBase);

    // Pre-compute candidate footprint positions for each building, sorted by
    // packScore (top-left bias) so empty space accumulates in the bottom-right.
    // packScore = (x - bounds.minX) + (y - bounds.minY); smaller = closer to top-left.
    interface BaseCandidate {
      x: number;
      y: number;
      packScore: number;
      /** Manhattan distance from candidate's nearest perimeter cell to the
       *  nearest Town Hall edge cell. Used as the tiebreaker for road-needing
       *  buildings so they cluster around the TH instead of the top-left
       *  corner (which leaves them stranded with no reachable road path). */
      thDist: number;
      cells: string[];
      perimeterAvail: string[];
    }
    const baseCandidatesByBuildingId = new Map<number, BaseCandidate[]>();
    const footprintFitsAvailable = (x: number, y: number, w: number, l: number): string[] | null => {
      const cells: string[] = [];
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < l; dy++) {
          const c = cellKey(x + dx, y + dy);
          if (!availableCells.has(c)) return null;
          cells.push(c);
        }
      }
      return cells;
    };
    for (const b of buildings) {
      const list: BaseCandidate[] = [];
      const maxX = bounds.maxX - b.width;
      const maxY = bounds.maxY - b.length;
      for (let y = bounds.minY; y <= maxY; y++) {
        for (let x = bounds.minX; x <= maxX; x++) {
          const cells = footprintFitsAvailable(x, y, b.width, b.length);
          if (!cells) continue;
          const packScore = (x - bounds.minX) + (y - bounds.minY);
          const perimeterAvail = getEdgeCells({ x, y, w: b.width, l: b.length })
            .filter(c => availableCells.has(c));
          // Min Manhattan distance from any perimeter cell of this candidate
          // to any TH edge cell. This is a cheap proxy for "how far would the
          // road have to travel to reach this building".
          let thDist = Infinity;
          for (const pCell of perimeterAvail) {
            const p = parseKey(pCell);
            for (const e of townHallEdgeParsed) {
              const d = Math.abs(p.x - e.x) + Math.abs(p.y - e.y);
              if (d < thDist) thDist = d;
            }
          }
          if (!isFinite(thDist)) thDist = packScore; // fallback for candidates with no perimeter
          list.push({ x, y, packScore, thDist, cells, perimeterAvail });
        }
      }
      list.sort((a, c) => a.packScore - c.packScore);
      baseCandidatesByBuildingId.set(b.id, list);
    }

    const totalNonTHBuildings = buildings.length;

    const createAttemptIterator = (attemptIdx: number): AttemptIterator => {
      const rng = createRng(0x9e3779b9 + (attemptIdx * 2654435761));

      const sortPhaseRandom = (phase: LayoutBuilding[]): LayoutBuilding[] => {
        const next = [...phase];
        next.sort((a, b) => {
          const areaA = a.width * a.length;
          const areaB = b.width * b.length;
          if (areaB !== areaA) return areaB - areaA;
          return rng() < 0.5 ? -1 : 1;
        });
        return next;
      };

      const phaseRoad2 = attemptIdx === 0 ? phaseRoad2Sorted0 : sortPhaseRandom(phaseRoad2Base);
      const phaseRoad1 = attemptIdx === 0 ? phaseRoad1Sorted0 : sortPhaseRandom(phaseRoad1Base);
      const phaseNoRoad = attemptIdx === 0 ? phaseNoRoadSorted0 : sortPhaseRandom(phaseNoRoadBase);
      const orderedBuildings = [...phaseRoad2, ...phaseRoad1, ...phaseNoRoad];

      const phaseTotals = {
        road2: phaseRoad2.length,
        road1: phaseRoad1.length,
        noRoad: phaseNoRoad.length,
      };
      const phasePlaced = { road2: 0, road1: 0, noRoad: 0 };

      const blockedByBuildings = new Set<string>(townHallRectCells);
      const placed: PlacedLayoutBuilding[] = [{ ...placedTownHallTemplate }];
      const road1Cells = new Set<string>();
      const road2Cells = new Set<string>();
      const road2Blocks = new Set<string>();
      const unplaced: LayoutBuilding[] = [];
      let lastResortPlacements = 0;
      let preNoRoadRescueDone = false;

      let cursor = 0;
      let finalized = false;

      const phaseFor = (idx: number): 'road2' | 'road1' | 'noRoad' => {
        if (idx < phaseRoad2.length) return 'road2';
        if (idx < phaseRoad2.length + phaseRoad1.length) return 'road1';
        return 'noRoad';
      };

      const roadAnySources = (): Set<string> => {
        const s = new Set<string>(townHallEdgeCellsBase);
        for (const c of road1Cells) s.add(c);
        for (const c of road2Cells) s.add(c);
        return s;
      };

      const canUseRoad2Block = (x: number, y: number): boolean => {
        const bKey = blockKey(x, y);
        if (road2Blocks.has(bKey)) return true;
        const cells = makeRoad2BlockCells(x, y);
        for (const c of cells) {
          if (!availableCells.has(c)) return false;
          if (blockedByBuildings.has(c)) return false;
          if (road1Cells.has(c)) return false;
        }
        return true;
      };

      const buildRoad2SourceBlocks = (): Set<string> => {
        const src = new Set<string>(road2Blocks);
        for (const e of townHallEdgeParsed) {
          const candidates = [
            blockKey(e.x, e.y),
            blockKey(e.x - 1, e.y),
            blockKey(e.x, e.y - 1),
            blockKey(e.x - 1, e.y - 1),
          ];
          for (const cand of candidates) {
            const p = parseKey(cand);
            if (canUseRoad2Block(p.x, p.y)) src.add(cand);
          }
        }
        return src;
      };

      const removeOverlappingRoad2Blocks = (footprintCells: Set<string>) => {
        for (const bk of [...road2Blocks]) {
          const p = parseKey(bk);
          const cells = makeRoad2BlockCells(p.x, p.y);
          if (!cells.some(c => footprintCells.has(c))) continue;
          road2Blocks.delete(bk);
          for (const c of cells) road2Cells.delete(c);
        }
      };

      const townHallEdgeCellsSet = new Set(townHallEdgeCellsBase);
      const isOnAnyRoad = (c: string): boolean =>
        road1Cells.has(c) || road2Cells.has(c) || townHallEdgeCellsSet.has(c);

      // Walks every placed road-needing building and tries to extend the
      // existing road network to any building whose perimeter doesn't already
      // touch a road. Uses real BFS through empty cells. Process in TH-distance
      // descending order so the tree grows outward and intermediate buildings
      // get served incidentally.
      const runRoadRescuePass = () => {
        const rescueQueue = placed
          .filter(bb => bb.roadLevel >= 1 && bb.type !== 'main_building')
          .map(bb => {
            const edge = getEdgeCells({ x: bb.x, y: bb.y, w: bb.width, l: bb.length })
              .filter(c => availableCells.has(c));
            let dist = 0;
            for (const c of edge) {
              const p = parseKey(c);
              for (const e of townHallEdgeParsed) {
                const d = Math.abs(p.x - e.x) + Math.abs(p.y - e.y);
                if (d > dist) dist = d;
              }
            }
            return { bb, edge, dist };
          })
          .sort((a, b) => b.dist - a.dist);

        for (const item of rescueQueue) {
          const { bb, edge } = item;
          if (edge.some(isOnAnyRoad)) continue;

          if (bb.roadLevel >= 2) {
            const targetBlocks = new Set<string>();
            for (const pCell of edge) {
              if (blockedByBuildings.has(pCell)) continue;
              const p = parseKey(pCell);
              for (const a of [
                blockKey(p.x, p.y), blockKey(p.x - 1, p.y),
                blockKey(p.x, p.y - 1), blockKey(p.x - 1, p.y - 1),
              ]) {
                const pos = parseKey(a);
                if (canUseRoad2Block(pos.x, pos.y)) targetBlocks.add(a);
              }
            }
            if (targetBlocks.size === 0) continue;
            const sources = buildRoad2SourceBlocks();
            const path = findShortestRoad2Path(sources, targetBlocks, canUseRoad2Block);
            if (path == null) continue;
            for (const rb of path) {
              const bk = blockKey(rb.x, rb.y);
              if (road2Blocks.has(bk)) continue;
              road2Blocks.add(bk);
              for (const rc of makeRoad2BlockCells(rb.x, rb.y)) road2Cells.add(rc);
            }
          } else {
            const usablePerim = edge.filter(c => !blockedByBuildings.has(c));
            if (usablePerim.length === 0) continue;
            const sources = roadAnySources();
            const path = findShortestCellPath(
              sources,
              new Set(usablePerim),
              availableCells,
              blockedByBuildings,
            );
            if (path == null) continue;
            for (const c of path) {
              if (!road2Cells.has(c)) road1Cells.add(c);
            }
          }
        }
      };

      interface ScoredPlan {
        cand: BaseCandidate;
        road1Path: string[];
        road2Path: Array<{ x: number; y: number }>;
        roadCostCells: number;
        perimeterPenalty: number;
      }

      // Better plan: lower roadCostCells, then lower perimeter penalty (large
      // buildings prefer placements where less of their perimeter abuts road),
      // then lower packScore (top-left bias for bottom-right openness).
      const isBetter = (a: ScoredPlan, b: ScoredPlan): boolean => {
        if (a.roadCostCells !== b.roadCostCells) return a.roadCostCells < b.roadCostCells;
        if (a.perimeterPenalty !== b.perimeterPenalty) return a.perimeterPenalty < b.perimeterPenalty;
        return a.cand.packScore < b.cand.packScore;
      };

      const tryPlace = (b: LayoutBuilding, relaxed: boolean): boolean => {
        const baseCandidates = baseCandidatesByBuildingId.get(b.id);
        if (!baseCandidates || baseCandidates.length === 0) return false;

        // Filter candidates whose footprint is currently unblocked. A footprint
        // must not overlap another building OR any existing road cell
        // (1x1 or 2x2). Allowing road overlap means committing the building
        // would silently delete those road cells, severing the network and
        // orphaning every building reached via that segment.
        const candidates: BaseCandidate[] = [];
        for (const cand of baseCandidates) {
          let blocked = false;
          for (const c of cand.cells) {
            if (blockedByBuildings.has(c) || road1Cells.has(c) || road2Cells.has(c)) {
              blocked = true;
              break;
            }
          }
          if (!blocked) candidates.push(cand);
        }
        if (candidates.length === 0) return false;

        const area = b.width * b.length;

        // No-road buildings: take the best packScore candidate (top-left bias)
        // since `candidates` is already sorted by packScore ascending.
        if (b.roadLevel <= 0) {
          const c = candidates[0];
          const placedBuilding: PlacedLayoutBuilding = { ...b, x: c.x, y: c.y };
          placed.push(placedBuilding);
          for (const fc of c.cells) blockedByBuildings.add(fc);
          return true;
        }

        // ---- Multi-source lower-bound BFS from current road network. ----
        // The lb map ignores building obstacles, so it under-estimates real
        // BFS cost (admissible). We use it to (a) sort candidates so the
        // cheapest-road ones are tried first and (b) terminate early once no
        // remaining candidate can beat the best plan found so far.
        const computeRoad1LbMap = (): Map<string, number> => {
          const map = new Map<string, number>();
          const queue: string[] = [];
          const seed = (c: string) => {
            if (!availableCells.has(c) || map.has(c)) return;
            map.set(c, 0);
            queue.push(c);
          };
          for (const c of townHallEdgeCellsBase) seed(c);
          for (const c of road1Cells) seed(c);
          for (const c of road2Cells) seed(c);
          for (let i = 0; i < queue.length; i++) {
            const curr = queue[i];
            const d = map.get(curr)!;
            const p = parseKey(curr);
            const neighbors = [
              cellKey(p.x + 1, p.y), cellKey(p.x - 1, p.y),
              cellKey(p.x, p.y + 1), cellKey(p.x, p.y - 1),
            ];
            for (const n of neighbors) {
              if (map.has(n) || !availableCells.has(n)) continue;
              map.set(n, d + 1);
              queue.push(n);
            }
          }
          return map;
        };

        const computeRoad2LbMap = (): Map<string, number> => {
          const map = new Map<string, number>();
          const queue: string[] = [];
          const blockAvail = (x: number, y: number): boolean => {
            for (const c of makeRoad2BlockCells(x, y)) {
              if (!availableCells.has(c)) return false;
            }
            return true;
          };
          const sources = buildRoad2SourceBlocks();
          for (const bk of sources) {
            if (!map.has(bk)) { map.set(bk, 0); queue.push(bk); }
          }
          for (let i = 0; i < queue.length; i++) {
            const curr = queue[i];
            const d = map.get(curr)!;
            const p = parseKey(curr);
            const neighbors = [
              blockKey(p.x + 2, p.y), blockKey(p.x - 2, p.y),
              blockKey(p.x, p.y + 2), blockKey(p.x, p.y - 2),
            ];
            for (const n of neighbors) {
              if (map.has(n)) continue;
              const pos = parseKey(n);
              if (!blockAvail(pos.x, pos.y)) continue;
              map.set(n, d + 1);
              queue.push(n);
            }
          }
          return map;
        };

        const lbMap = b.roadLevel >= 2 ? computeRoad2LbMap() : computeRoad1LbMap();

        interface PerCandidateLb {
          cand: BaseCandidate;
          lb: number;
          usablePerimeter: string[];
        }

        const scored: PerCandidateLb[] = [];
        for (const c of candidates) {
          const usablePerimeter: string[] = [];
          for (const cell of c.perimeterAvail) {
            if (!blockedByBuildings.has(cell)) usablePerimeter.push(cell);
          }
          if (usablePerimeter.length === 0) continue;

          let bestLb = Infinity;
          if (b.roadLevel >= 2) {
            const cellsSet = new Set(c.cells);
            for (const pCell of usablePerimeter) {
              const p = parseKey(pCell);
              const around = [
                blockKey(p.x, p.y), blockKey(p.x - 1, p.y),
                blockKey(p.x, p.y - 1), blockKey(p.x - 1, p.y - 1),
              ];
              for (const a of around) {
                const pos = parseKey(a);
                // Skip blocks that overlap the candidate footprint.
                const blockCells = makeRoad2BlockCells(pos.x, pos.y);
                let overlaps = false;
                for (const bc of blockCells) {
                  if (cellsSet.has(bc)) { overlaps = true; break; }
                }
                if (overlaps) continue;
                const d = lbMap.get(a);
                if (d == null) continue;
                const cost = d * 4;
                if (cost < bestLb) bestLb = cost;
              }
            }
          } else {
            for (const pCell of usablePerimeter) {
              const d = lbMap.get(pCell);
              if (d == null) continue;
              if (d < bestLb) bestLb = d;
            }
          }

          if (!isFinite(bestLb)) continue;
          scored.push({ cand: c, lb: bestLb, usablePerimeter });
        }

        if (scored.length === 0) return false;

        // Sort by (lb asc, thDist asc, packScore asc). Road-needing buildings
        // tiebreak on distance to Town Hall so the road network stays compact
        // and reachable -- packing them toward the top-left corner instead
        // strands them with no real road path even when lb says they're
        // reachable.
        scored.sort((a, b) =>
          a.lb - b.lb
          || a.cand.thDist - b.cand.thDist
          || a.cand.packScore - b.cand.packScore
        );
        if (attemptIdx > 0 && scored.length > 1) {
          let i = 0;
          while (i < scored.length) {
            let j = i;
            while (j < scored.length && scored[j].lb === scored[i].lb) j++;
            for (let k = j - 1; k > i; k--) {
              const r = i + Math.floor(rng() * (k - i + 1));
              const tmp = scored[k]; scored[k] = scored[r]; scored[r] = tmp;
            }
            i = j;
          }
        }

        // Iterate scored candidates in order. Run actual per-candidate BFS
        // (with cand.cells temporarily blocked) only as needed; stop once no
        // remaining candidate can beat the best plan.
        let best: ScoredPlan | null = null;
        for (const s of scored) {
          if (best && s.lb >= best.roadCostCells) break;

          for (const fc of s.cand.cells) blockedByBuildings.add(fc);

          let plan: ScoredPlan | null = null;

          if (b.roadLevel >= 2) {
            const sourceBlocks = buildRoad2SourceBlocks();
            const targetBlocks = new Set<string>();
            for (const pCell of s.usablePerimeter) {
              const p = parseKey(pCell);
              const around = [
                blockKey(p.x, p.y), blockKey(p.x - 1, p.y),
                blockKey(p.x, p.y - 1), blockKey(p.x - 1, p.y - 1),
              ];
              for (const a of around) {
                const pos = parseKey(a);
                if (canUseRoad2Block(pos.x, pos.y)) targetBlocks.add(a);
              }
            }
            const road2Path = findShortestRoad2Path(sourceBlocks, targetBlocks, canUseRoad2Block);
            if (road2Path != null) {
              let newRoadCells = 0;
              const newRoadCellSet = new Set<string>();
              for (const rb of road2Path) {
                const bk = blockKey(rb.x, rb.y);
                if (road2Blocks.has(bk)) continue;
                newRoadCells += 4;
                for (const rc of makeRoad2BlockCells(rb.x, rb.y)) newRoadCellSet.add(rc);
              }
              let overlapCount = 0;
              for (const pCell of s.usablePerimeter) {
                if (road1Cells.has(pCell) || road2Cells.has(pCell) || newRoadCellSet.has(pCell)) overlapCount++;
              }
              const perimeterPenalty = relaxed ? 0 : area * Math.max(0, overlapCount - 1);
              plan = {
                cand: s.cand, road1Path: [], road2Path,
                roadCostCells: newRoadCells, perimeterPenalty,
              };
            }
          } else {
            const sourceCells = roadAnySources();
            const targetCells = new Set<string>(s.usablePerimeter);
            const fullPath = findShortestCellPath(sourceCells, targetCells, availableCells, blockedByBuildings);
            if (fullPath != null) {
              let newRoadCells = 0;
              const newRoadPath: string[] = [];
              const newRoadCellSet = new Set<string>();
              for (const cell of fullPath) {
                if (road1Cells.has(cell) || road2Cells.has(cell)) continue;
                newRoadCells += 1;
                newRoadPath.push(cell);
                newRoadCellSet.add(cell);
              }
              let overlapCount = 0;
              for (const pCell of s.usablePerimeter) {
                if (road1Cells.has(pCell) || road2Cells.has(pCell) || newRoadCellSet.has(pCell)) overlapCount++;
              }
              const perimeterPenalty = relaxed ? 0 : area * Math.max(0, overlapCount - 1);
              plan = {
                cand: s.cand, road1Path: newRoadPath, road2Path: [],
                roadCostCells: newRoadCells, perimeterPenalty,
              };
            }
          }

          for (const fc of s.cand.cells) blockedByBuildings.delete(fc);

          if (plan && (!best || isBetter(plan, best))) {
            best = plan;
          }
        }

        if (!best) return false;

        for (const c of best.road1Path) {
          if (!road2Cells.has(c)) road1Cells.add(c);
        }
        for (const rb of best.road2Path) {
          const bKey = blockKey(rb.x, rb.y);
          if (!road2Blocks.has(bKey)) {
            road2Blocks.add(bKey);
            for (const rc of makeRoad2BlockCells(rb.x, rb.y)) road2Cells.add(rc);
          }
        }

        const placedBuilding: PlacedLayoutBuilding = { ...b, x: best.cand.x, y: best.cand.y };
        placed.push(placedBuilding);

        const footprintCells = new Set(rectCells({ x: best.cand.x, y: best.cand.y, w: b.width, l: b.length }));
        // Candidates that overlap road cells were filtered out above, so
        // road1Cells/road2Cells should never need cleanup here. We keep the
        // 2x2-block overlap check only as defence-in-depth for legacy callers.
        removeOverlappingRoad2Blocks(footprintCells);
        for (const c of footprintCells) {
          blockedByBuildings.add(c);
        }
        return true;
      };

      const finalize = (): AttemptResult => {
        // Hard constraint: every building must be placed. Retry unplaced with
        // relaxed search (no candidate cap, no perimeter penalty). Sort by
        // area DESC so larger buildings get first pick of remaining slots.
        if (unplaced.length > 0) {
          const retryQueue = unplaced.splice(0).sort((a, b) => {
            const areaA = a.width * a.length;
            const areaB = b.width * b.length;
            return areaB - areaA;
          });
          for (const b of retryQueue) {
            const ok = tryPlace(b, true);
            const phase = b.roadLevel >= 2 ? 'road2' : (b.roadLevel === 1 ? 'road1' : 'noRoad');
            if (ok) phasePlaced[phase]++;
            else unplaced.push(b);
          }
        }

        // Last-resort: any building still unplaced gets its footprint placed
        // anywhere it fits, WITHOUT extending roads. The connectivity report
        // will flag these as unserved (acceptable: roads are flexible and the
        // user can add them manually). Dropping buildings is not acceptable
        // (hard constraint).
        if (unplaced.length > 0) {
          const lastResort = unplaced.splice(0).sort((a, b) => {
            const areaA = a.width * a.length;
            const areaB = b.width * b.length;
            return areaB - areaA;
          });
          for (const b of lastResort) {
            const baseCandidates = baseCandidatesByBuildingId.get(b.id);
            let placedHere = false;
            if (baseCandidates) {
              for (const cand of baseCandidates) {
                let blocked = false;
                for (const c of cand.cells) {
                  if (blockedByBuildings.has(c) || road1Cells.has(c) || road2Cells.has(c)) {
                    blocked = true;
                    break;
                  }
                }
                if (blocked) continue;
                placed.push({ ...b, x: cand.x, y: cand.y });
                for (const c of cand.cells) blockedByBuildings.add(c);
                const phase = b.roadLevel >= 2 ? 'road2' : (b.roadLevel === 1 ? 'road1' : 'noRoad');
                phasePlaced[phase]++;
                lastResortPlacements++;
                placedHere = true;
                break;
              }
            }
            if (!placedHere) unplaced.push(b);
          }
        }

        // ---- Road-rescue pass ----
        // Many road-needing buildings end up placed without a road touching
        // them (especially via last-resort, but also from greedy lb=0
        // placements that wall off the TH). Walk every placed road-needing
        // building; if its perimeter doesn't already touch a road or TH edge,
        // try to extend the existing road network to it via real BFS through
        // empty cells.
        //
        // CRITICAL: this MUST run before the noRoad phase. Otherwise the
        // noRoad phase fills every available empty cell and there are no
        // corridors left for the rescue BFS to path through.
        runRoadRescuePass();

        // Prune roads not connected to Town Hall, with two-tier rules:
        //   * 2x2 blocks are connected only via other 2x2 blocks (stride-2 BFS),
        //     seeded from blocks adjacent to a Town Hall edge cell.
        //   * 1x1 cells are connected via other 1x1 cells, seeded from Town
        //     Hall edge cells AND from any 1x1 cell adjacent to a connected
        //     2x2 cell. (1x1 may branch off 2x2; 2x2 may NOT reach TH via 1x1.)

        const connected2x2Blocks = new Set<string>();
        const q2: string[] = [];
        for (const e of townHallEdgeParsed) {
          const seedCandidates = [
            blockKey(e.x, e.y),
            blockKey(e.x - 1, e.y),
            blockKey(e.x, e.y - 1),
            blockKey(e.x - 1, e.y - 1),
          ];
          for (const bk of seedCandidates) {
            if (!road2Blocks.has(bk) || connected2x2Blocks.has(bk)) continue;
            connected2x2Blocks.add(bk);
            q2.push(bk);
          }
        }
        for (let i = 0; i < q2.length; i++) {
          const p = parseKey(q2[i]);
          const neighbors = [
            blockKey(p.x + 2, p.y), blockKey(p.x - 2, p.y),
            blockKey(p.x, p.y + 2), blockKey(p.x, p.y - 2),
          ];
          for (const n of neighbors) {
            if (!road2Blocks.has(n) || connected2x2Blocks.has(n)) continue;
            connected2x2Blocks.add(n);
            q2.push(n);
          }
        }

        const connected2x2Cells = new Set<string>();
        for (const bk of connected2x2Blocks) {
          const p = parseKey(bk);
          for (const c of makeRoad2BlockCells(p.x, p.y)) connected2x2Cells.add(c);
        }

        const connected1x1Cells = new Set<string>();
        const q1: string[] = [];
        for (const c of road1Cells) {
          let seed = townHallEdgeCellsSet.has(c);
          if (!seed) {
            const p = parseKey(c);
            const neighbors = [
              cellKey(p.x + 1, p.y), cellKey(p.x - 1, p.y),
              cellKey(p.x, p.y + 1), cellKey(p.x, p.y - 1),
            ];
            for (const n of neighbors) {
              if (connected2x2Cells.has(n)) { seed = true; break; }
            }
          }
          if (seed) {
            connected1x1Cells.add(c);
            q1.push(c);
          }
        }
        for (let i = 0; i < q1.length; i++) {
          const p = parseKey(q1[i]);
          const neighbors = [
            cellKey(p.x + 1, p.y), cellKey(p.x - 1, p.y),
            cellKey(p.x, p.y + 1), cellKey(p.x, p.y - 1),
          ];
          for (const n of neighbors) {
            if (!road1Cells.has(n) || connected1x1Cells.has(n)) continue;
            connected1x1Cells.add(n);
            q1.push(n);
          }
        }

        for (const c of [...road1Cells]) {
          if (!connected1x1Cells.has(c)) road1Cells.delete(c);
        }
        for (const bk of [...road2Blocks]) {
          if (!connected2x2Blocks.has(bk)) {
            road2Blocks.delete(bk);
            const p = parseKey(bk);
            for (const c of makeRoad2BlockCells(p.x, p.y)) road2Cells.delete(c);
          }
        }

        const optimizedBuildingCells = placed.reduce((sum: number, bb) => sum + (bb.width * bb.length), 0);
        const optimizedRoadCells = road1Cells.size + road2Cells.size;
        const optimizedRoadEntities = road1Cells.size + road2Blocks.size;
        const optimizedEmptyCells = Math.max(0, availableCells.size - optimizedBuildingCells - optimizedRoadCells);

        const placedRoad2 = placed.filter(bb => bb.roadLevel >= 2).length;
        const placedRoad1 = placed.filter(bb => bb.roadLevel === 1).length;
        const placedNoRoad = placed.filter(bb => bb.roadLevel <= 0 && bb.type !== 'main_building').length;

        return {
          placed,
          unplaced,
          road1Cells,
          road2Blocks,
          metrics: {
            roadCells: optimizedRoadCells,
            roadEntities: optimizedRoadEntities,
            road1Entities: road1Cells.size,
            road2Entities: road2Blocks.size,
            emptyCells: optimizedEmptyCells,
            lastResortPlacements,
            phaseStats: {
              road2: { total: phaseRoad2.length, placed: placedRoad2, unplaced: phaseRoad2.length - placedRoad2 },
              road1: { total: phaseRoad1.length, placed: placedRoad1, unplaced: phaseRoad1.length - placedRoad1 },
              noRoad: { total: phaseNoRoad.length, placed: placedNoRoad, unplaced: phaseNoRoad.length - placedNoRoad },
            },
          },
        };
      };

      return {
        step(): AttemptStepResult {
          if (finalized) {
            throw new Error('AttemptIterator already done');
          }
          // CRITICAL: run the road rescue pass BEFORE the noRoad phase fills
          // every empty cell. After noRoad placement, no empty corridors
          // remain for the rescue BFS to path through. This step does not
          // place a building -- it just builds out the road network.
          if (
            !preNoRoadRescueDone
            && cursor >= phaseRoad2.length + phaseRoad1.length
            && cursor < orderedBuildings.length
          ) {
            preNoRoadRescueDone = true;
            runRoadRescuePass();
            return {
              done: false,
              attemptIdx,
              phase: 'noRoad',
              placedInPhase: phasePlaced.noRoad,
              totalInPhase: phaseTotals.noRoad,
              totalPlaced: placed.length - 1,
              totalBuildings: orderedBuildings.length,
              lastBuildingName: '(road rescue)',
            };
          }
          if (cursor < orderedBuildings.length) {
            const b = orderedBuildings[cursor];
            const phase = phaseFor(cursor);
            const ok = tryPlace(b, false);
            if (ok) phasePlaced[phase]++;
            else unplaced.push(b);
            cursor++;
            return {
              done: false,
              attemptIdx,
              phase,
              placedInPhase: phasePlaced[phase],
              totalInPhase: phaseTotals[phase],
              totalPlaced: placed.length - 1, // exclude Town Hall
              totalBuildings: orderedBuildings.length,
              lastBuildingName: b.name,
            };
          }
          finalized = true;
          const result = finalize();
          return { done: true, result };
        },
      };
    };

    const ATTEMPTS = 5;

    return {
      bounds,
      availableCells,
      attempts: ATTEMPTS,
      totalBuildings: totalNonTHBuildings,
      current: {
        roads: currentRoadEntities,
        roadCells: currentRoadCells.size,
        emptyCells: currentEmptyCells,
        road1Entities: currentRoad1Entities,
        road2Entities: currentRoad2Entities,
      },
      createAttemptIterator,
    };
  }, [data, hasStarted]);

  useEffect(() => {
    setHasStarted(false);
    setResult(null);
    setProgress(IDLE_PROGRESS);
  }, [data]);

  useEffect(() => {
    if (!hasStarted) return;
    if (!prepared) {
      setResult(null);
      setProgress(IDLE_PROGRESS);
      return;
    }
    if ('error' in prepared) {
      setResult(prepared);
      setProgress(IDLE_PROGRESS);
      return;
    }

    let cancelled = false;
    setViewBox(null);
    setProgress({
      running: true,
      attempt: 1,
      attempts: prepared.attempts,
      phase: 'road2',
      phasePlaced: 0,
      phaseTotal: 0,
      totalPlaced: 0,
      totalBuildings: prepared.totalBuildings,
      lastBuildingName: '',
    });

    const stepsPerChunk = 8;
    let attemptIdx = 0;
    let iterator = prepared.createAttemptIterator(attemptIdx);
    let bestAttempt: AttemptResult | null = null;

    const compareAttempt = (a: AttemptResult, b: AttemptResult): number => {
      // Returns positive if `a` is strictly better than `b`.
      // Priority order:
      //  1. Most placed (hard constraint).
      //  2. Fewest last-resort (no-road) placements -- a properly road-served
      //     building beats one dumped via fallback. Without this, an attempt
      //     that gave up early and dumped buildings would unfairly win the
      //     "fewer road cells" tiebreaker against an attempt that legitimately
      //     served everything with a denser road network.
      //  3. Fewer road cells.
      //  4. More empty cells.
      const placedDiff = a.placed.length - b.placed.length;
      if (placedDiff !== 0) return placedDiff;
      const lastResortDiff = b.metrics.lastResortPlacements - a.metrics.lastResortPlacements;
      if (lastResortDiff !== 0) return lastResortDiff;
      const roadDiff = b.metrics.roadCells - a.metrics.roadCells;
      if (roadDiff !== 0) return roadDiff;
      return a.metrics.emptyCells - b.metrics.emptyCells;
    };

    const finishAll = () => {
      const chosen = bestAttempt!;
      const nextResult: OptimizerSuccess = {
        bounds: prepared.bounds,
        placed: chosen.placed,
        unplaced: chosen.unplaced,
        road1Cells: chosen.road1Cells,
        road2Blocks: chosen.road2Blocks,
        availableCells: prepared.availableCells,
        attempts: prepared.attempts,
        metrics: {
          current: prepared.current,
          optimized: {
            roads: chosen.metrics.roadEntities,
            roadCells: chosen.metrics.roadCells,
            emptyCells: chosen.metrics.emptyCells,
            road1Entities: chosen.metrics.road1Entities,
            road2Entities: chosen.metrics.road2Entities,
          },
        },
        phaseStats: chosen.metrics.phaseStats,
      };
      setResult(nextResult);
      setProgress({
        running: false,
        attempt: prepared.attempts,
        attempts: prepared.attempts,
        phase: 'idle',
        phasePlaced: 0,
        phaseTotal: 0,
        totalPlaced: chosen.placed.length - 1,
        totalBuildings: prepared.totalBuildings,
        lastBuildingName: '',
      });
    };

    const processChunk = () => {
      if (cancelled) return;
      let lastProgress: AttemptStepProgress | null = null;
      let attemptDone = false;

      for (let n = 0; n < stepsPerChunk; n++) {
        const r = iterator.step();
        if (r.done) {
          attemptDone = true;
          if (!bestAttempt || compareAttempt(r.result, bestAttempt) > 0) {
            bestAttempt = r.result;
          }
          attemptIdx++;
          if (attemptIdx >= prepared.attempts) {
            finishAll();
            return;
          }
          iterator = prepared.createAttemptIterator(attemptIdx);
          break;
        }
        lastProgress = r;
      }

      if (lastProgress) {
        setProgress({
          running: true,
          attempt: lastProgress.attemptIdx + 1,
          attempts: prepared.attempts,
          phase: lastProgress.phase,
          phasePlaced: lastProgress.placedInPhase,
          phaseTotal: lastProgress.totalInPhase,
          totalPlaced: lastProgress.totalPlaced,
          totalBuildings: lastProgress.totalBuildings,
          lastBuildingName: lastProgress.lastBuildingName,
        });
      } else if (attemptDone) {
        setProgress(p => ({
          ...p,
          attempt: attemptIdx + 1,
          phase: 'finalizing',
        }));
      }

      setTimeout(processChunk, 0);
    };

    setTimeout(processChunk, 0);
    return () => {
      cancelled = true;
    };
  }, [prepared, hasStarted, runVersion]);

  const successfulResult: OptimizerSuccess | null = result && !('error' in result) ? result : null;
  const boundsForViewBox = successfulResult?.bounds ?? null;
  const initialViewBox = boundsForViewBox
    ? {
        x: (boundsForViewBox.minX - 1) * PREVIEW_CELL,
        y: (boundsForViewBox.minY - 1) * PREVIEW_CELL,
        w: (boundsForViewBox.width + 2) * PREVIEW_CELL,
        h: (boundsForViewBox.height + 2) * PREVIEW_CELL,
      }
    : {
        x: 0,
        y: 0,
        w: PREVIEW_CELL * 10,
        h: PREVIEW_CELL * 10,
      };

  useEffect(() => {
    if (!boundsForViewBox) return;
    setViewBox(prev => prev ?? initialViewBox);
  }, [boundsForViewBox?.minX, boundsForViewBox?.minY, boundsForViewBox?.width, boundsForViewBox?.height]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setViewBox(prev => {
      const current = prev ?? initialViewBox;
      const scale = e.deltaY > 0 ? 1.1 : 0.9;
      const svg = svgRef.current;
      if (!svg) return current;

      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;

      const newW = current.w * scale;
      const newH = current.h * scale;
      return {
        x: current.x + (current.w - newW) * mx,
        y: current.y + (current.h - newH) * my,
        w: newW,
        h: newH,
      };
    });
  }, [initialViewBox]);

  const wrapperCallbackRef = useCallback((node: HTMLDivElement | null) => {
    const prev = wrapperRef.current;
    if (prev) prev.removeEventListener('wheel', handleWheel);
    wrapperRef.current = node;
    if (node) node.addEventListener('wheel', handleWheel, { passive: false });
  }, [handleWheel]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const current = viewBox ?? initialViewBox;
    setIsPanning(true);
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      vx: current.x,
      vy: current.y,
    };
  }, [viewBox, initialViewBox]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    setViewBox(prev => {
      const current = prev ?? initialViewBox;
      const dx = (e.clientX - panStart.current.x) * (current.w / rect.width);
      const dy = (e.clientY - panStart.current.y) * (current.h / rect.height);
      return {
        ...current,
        x: panStart.current.vx - dx,
        y: panStart.current.vy - dy,
      };
    });
  }, [isPanning, initialViewBox]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const activeViewBox = viewBox ?? initialViewBox;

  if (!hasStarted) {
    return (
      <div className="layout-optimizer">
        <div className="optimizer-card optimizer-start-card">
          <div className="optimizer-label">Layout Optimizer</div>
          <div className="optimizer-sub">
            The optimizer is idle. Click start to begin iterative layout search.
          </div>
          <button
            className="optimizer-start-btn"
            onClick={() => {
              setProgress(STARTING_PROGRESS);
              setHasStarted(true);
              setRunVersion(v => v + 1);
            }}
          >
            Start Layout Optimizer
          </button>
        </div>
      </div>
    );
  }

  if (!result && !progress.running) return null;

  if (result && 'error' in result) {
    return <div className="optimizer-empty">{result.error}</div>;
  }

  if (!successfulResult) {
    const overallPct = progress.totalBuildings > 0
      ? (((progress.attempt - 1) * progress.totalBuildings + progress.totalPlaced) /
          (progress.attempts * progress.totalBuildings)) * 100
      : 0;
    return (
      <div className="layout-optimizer">
        <div className="optimizer-card optimizer-progress-card">
          <div className="optimizer-label">Calculating Layout</div>
          <div className="optimizer-value">Attempt {progress.attempt} / {progress.attempts}</div>
          <div className="optimizer-sub">Phase: {phaseLabel(progress.phase)}</div>
          {progress.phaseTotal > 0 && (
            <div className="optimizer-sub">{progress.phasePlaced} / {progress.phaseTotal} in this phase</div>
          )}
          <div className="optimizer-sub">{progress.totalPlaced} / {progress.totalBuildings} buildings placed in this attempt</div>
          {progress.lastBuildingName && (
            <div className="optimizer-sub">Last placed: {progress.lastBuildingName}</div>
          )}
          <div className="optimizer-progress-track">
            <div
              className="optimizer-progress-fill"
              style={{ width: `${overallPct}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  const roadDelta = successfulResult.metrics.optimized.roads - successfulResult.metrics.current.roads;
  const emptyDelta = successfulResult.metrics.optimized.emptyCells - successfulResult.metrics.current.emptyCells;

  return (
    <div className="layout-optimizer">
      <div className="optimizer-header">
        <h2>Layout Optimizer (Heuristic)</h2>
        <p>
          Places every building from the input data, then minimizes the roads needed to serve them.
          Buildings are packed toward the top-left so open space accumulates in the bottom-right.
        </p>
        <p className="optimizer-sub">Roads are the only flexible part of the layout: the solver creates 1x1 and 2x2 roads as needed and prunes any not connected to the Town Hall.</p>
        <button
          className="optimizer-start-btn"
          onClick={() => {
            setProgress(STARTING_PROGRESS);
            setResult(null);
            setHasStarted(true);
            setRunVersion(v => v + 1);
          }}
          disabled={progress.running}
        >
          {progress.running ? 'Running...' : 'Re-run Optimizer'}
        </button>
        <button
          className="optimizer-start-btn"
          style={{ marginLeft: 8 }}
          title="Download a text+JSON layout report (optimized result)"
          disabled={progress.running}
          onClick={() => {
            const buildings: ExportBuilding[] = successfulResult.placed.map(b => ({
              id: b.id, name: b.name, type: b.type,
              x: b.x, y: b.y, width: b.width, length: b.length,
              roadLevel: b.roadLevel,
            }));
            const r = buildLayoutReport({
              source: 'optimized',
              bounds: successfulResult.bounds,
              availableCells: successfulResult.availableCells,
              buildings,
              unplaced: successfulResult.unplaced.map(u => ({
                id: u.id, name: u.name, type: u.type,
                width: u.width, length: u.length, roadLevel: u.roadLevel,
              })),
              road1Cells: successfulResult.road1Cells,
              road2Blocks: successfulResult.road2Blocks,
            });
            downloadTextFile('city-layout-optimized.txt', r.text, 'text/plain');
            downloadTextFile('city-layout-optimized.json', r.json, 'application/json');
          }}
        >
          Export Layout
        </button>
        <button
          className="optimizer-start-btn"
          style={{ marginLeft: 8 }}
          title="Copy the optimized layout report (text + JSON) to the clipboard"
          disabled={progress.running}
          onClick={async () => {
            const buildings: ExportBuilding[] = successfulResult.placed.map(b => ({
              id: b.id, name: b.name, type: b.type,
              x: b.x, y: b.y, width: b.width, length: b.length,
              roadLevel: b.roadLevel,
            }));
            const r = buildLayoutReport({
              source: 'optimized',
              bounds: successfulResult.bounds,
              availableCells: successfulResult.availableCells,
              buildings,
              unplaced: successfulResult.unplaced.map(u => ({
                id: u.id, name: u.name, type: u.type,
                width: u.width, length: u.length, roadLevel: u.roadLevel,
              })),
              road1Cells: successfulResult.road1Cells,
              road2Blocks: successfulResult.road2Blocks,
            });
            const ok = await copyTextToClipboard(r.text);
            if (!ok) downloadTextFile('city-layout-optimized.txt', r.text, 'text/plain');
          }}
        >
          Copy Layout
        </button>
      </div>

      <div className="optimizer-metrics">
        <div className="optimizer-card">
          <div className="optimizer-label">Current Roads</div>
          <div className="optimizer-value">{successfulResult.metrics.current.roads}</div>
          <div className="optimizer-sub">{successfulResult.metrics.current.roadCells} road cells</div>
          <div className="optimizer-sub">1x1: {successfulResult.metrics.current.road1Entities} | 2x2: {successfulResult.metrics.current.road2Entities}</div>
        </div>
        <div className="optimizer-card">
          <div className="optimizer-label">Optimized Roads</div>
          <div className="optimizer-value">{successfulResult.metrics.optimized.roads}</div>
          <div className={`optimizer-sub ${roadDelta <= 0 ? 'good' : 'bad'}`}>
            {roadDelta > 0 ? '+' : ''}{roadDelta} vs current
          </div>
          <div className="optimizer-sub">1x1: {successfulResult.metrics.optimized.road1Entities} | 2x2: {successfulResult.metrics.optimized.road2Entities}</div>
        </div>
        <div className="optimizer-card">
          <div className="optimizer-label">Current Empty Tiles</div>
          <div className="optimizer-value">{successfulResult.metrics.current.emptyCells}</div>
        </div>
        <div className="optimizer-card">
          <div className="optimizer-label">Optimized Empty Tiles</div>
          <div className="optimizer-value">{successfulResult.metrics.optimized.emptyCells}</div>
          <div className={`optimizer-sub ${emptyDelta >= 0 ? 'good' : 'bad'}`}>
            {emptyDelta > 0 ? '+' : ''}{emptyDelta} vs current
          </div>
        </div>
        {progress.running && (
          <div className="optimizer-card optimizer-progress-card">
            <div className="optimizer-label">Solver Progress</div>
            <div className="optimizer-value">Attempt {progress.attempt} / {progress.attempts}</div>
            <div className="optimizer-sub">{phaseLabel(progress.phase)}</div>
            <div className="optimizer-sub">{progress.totalPlaced} / {progress.totalBuildings} placed</div>
            <div className="optimizer-progress-track">
              <div
                className="optimizer-progress-fill"
                style={{
                  width: `${progress.totalBuildings > 0
                    ? (((progress.attempt - 1) * progress.totalBuildings + progress.totalPlaced) /
                        (progress.attempts * progress.totalBuildings)) * 100
                    : 0}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="optimizer-body">
        <div className="optimizer-preview-wrap">
          <div
            className="optimizer-grid-wrapper"
            ref={wrapperCallbackRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
          <svg
            ref={svgRef}
            className="optimizer-preview"
            viewBox={`${activeViewBox.x} ${activeViewBox.y} ${activeViewBox.w} ${activeViewBox.h}`}
            role="img"
            aria-label="Optimized city layout preview"
          >
            <defs>
              <pattern id="optimizer-grid-1x1" width={PREVIEW_CELL} height={PREVIEW_CELL} patternUnits="userSpaceOnUse">
                <rect width={PREVIEW_CELL} height={PREVIEW_CELL} fill="none" stroke="#2a2a4e" strokeWidth={0.3} />
              </pattern>
            </defs>

            {data?.UnlockedAreas.map((area, idx) => (
              <g key={`opt-area-${idx}`}>
                <rect
                  x={area.x * PREVIEW_CELL}
                  y={area.y * PREVIEW_CELL}
                  width={area.width * PREVIEW_CELL}
                  height={area.length * PREVIEW_CELL}
                  fill="#1a1a2e"
                />
                <rect
                  x={area.x * PREVIEW_CELL}
                  y={area.y * PREVIEW_CELL}
                  width={area.width * PREVIEW_CELL}
                  height={area.length * PREVIEW_CELL}
                  fill="url(#optimizer-grid-1x1)"
                />
              </g>
            ))}

            {[...successfulResult.road1Cells].map(c => {
              const p = parseKey(c);
              return (
                <rect
                  key={`r1-${c}`}
                  x={p.x * PREVIEW_CELL}
                  y={p.y * PREVIEW_CELL}
                  width={PREVIEW_CELL}
                  height={PREVIEW_CELL}
                  fill="#616161"
                  opacity={0.9}
                />
              );
            })}

            {[...successfulResult.road2Blocks].map(bk => {
              const p = parseKey(bk);
              return (
                <rect
                  key={`r2-${bk}`}
                  x={p.x * PREVIEW_CELL}
                  y={p.y * PREVIEW_CELL}
                  width={PREVIEW_CELL * 2}
                  height={PREVIEW_CELL * 2}
                  fill="#7b7b7b"
                  opacity={0.9}
                />
              );
            })}

            {successfulResult.placed.map(b => (
              <rect
                key={`pb-${b.id}`}
                x={b.x * PREVIEW_CELL + 0.5}
                y={b.y * PREVIEW_CELL + 0.5}
                width={b.width * PREVIEW_CELL - 1}
                height={b.length * PREVIEW_CELL - 1}
                fill={getBuildingColor(b.type)}
                stroke={hoveredBuilding?.id === b.id ? '#ffffff' : (b.roadLevel >= 2 ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.35)')}
                strokeWidth={hoveredBuilding?.id === b.id ? 2.2 : (b.roadLevel >= 2 ? 1.6 : 0.8)}
                rx={1}
                onMouseEnter={e => {
                  setHoveredBuilding(b);
                  setTooltipPos({ x: e.clientX, y: e.clientY });
                }}
                onMouseMove={e => {
                  setTooltipPos({ x: e.clientX, y: e.clientY });
                }}
                onMouseLeave={() => setHoveredBuilding(null)}
              />
            ))}
          </svg>
          </div>

          {hoveredBuilding && (
            <div
              className="grid-tooltip"
              style={{
                position: 'fixed',
                left: tooltipPos.x + 12,
                top: tooltipPos.y - 10,
              }}
            >
              <strong>{hoveredBuilding.name}</strong>
              <br />
              <span className="tooltip-type">{hoveredBuilding.type.replace(/_/g, ' ')}</span>
            </div>
          )}

          <div className="optimizer-legend">
            <span><i className="swatch building" /> Building</span>
            <span><i className="swatch townhall" /> Town Hall</span>
            <span><i className="swatch road1" /> 1x1 Road</span>
            <span><i className="swatch road2" /> 2x2 Road</span>
            <span><i className="swatch req2" /> 2x2-road building border</span>
          </div>
          <p className="grid-hint">Scroll to zoom, drag to pan</p>
        </div>

        <div className="optimizer-notes">
          <h3>Placement Notes</h3>
          <p>Layouts tested: {successfulResult.attempts}</p>
          <p>Total placed buildings: {successfulResult.placed.length}</p>
          <p>
            Unplaced buildings: {successfulResult.unplaced.length}
          </p>
          <p><strong>Phase stats:</strong></p>
          <p>2x2-road phase: {successfulResult.phaseStats.road2.placed}/{successfulResult.phaseStats.road2.total} placed ({successfulResult.phaseStats.road2.unplaced} unplaced)</p>
          <p>1x1-road phase: {successfulResult.phaseStats.road1.placed}/{successfulResult.phaseStats.road1.total} placed ({successfulResult.phaseStats.road1.unplaced} unplaced)</p>
          <p>No-road phase: {successfulResult.phaseStats.noRoad.placed}/{successfulResult.phaseStats.noRoad.total} placed ({successfulResult.phaseStats.noRoad.unplaced} unplaced)</p>
          {successfulResult.unplaced.length > 0 && (
            <ul>
              {successfulResult.unplaced.slice(0, 15).map(b => (
                <li key={`un-${b.id}`}>
                  {b.name} ({b.width}x{b.length}, road lvl {b.roadLevel})
                </li>
              ))}
            </ul>
          )}
          <p className="optimizer-disclaimer">
            This is a fast heuristic optimizer, not an exhaustive solver. It is designed to produce
            high-quality layouts quickly for large city datasets.
          </p>
        </div>
      </div>
    </div>
  );
}
