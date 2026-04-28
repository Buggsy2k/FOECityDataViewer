import type { CityData, CityEntity } from '../types/citydata';
import type { GridBounds } from './gridUtils';
import { getPlacedBuildings } from './gridUtils';
import { resolveBuildingName } from './dataProcessing';

// ---------- Public types ----------

export interface ExportBuilding {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  length: number;
  roadLevel: number;
}

export interface LayoutReportInput {
  source: 'current' | 'optimized';
  bounds: GridBounds;
  /** Optional explicit set of available cells (key "x,y"). If omitted, derived from `unlockedAreas`. */
  availableCells?: Set<string>;
  unlockedAreas?: Array<{ x?: number; y?: number; width: number; length: number }>;
  buildings: ExportBuilding[];
  /** Buildings the optimizer failed to place (omit / leave empty for current city). */
  unplaced?: Array<{ id: number; name: string; type: string; width: number; length: number; roadLevel: number }>;
  /** Town Hall is included in `buildings` already; this is the same entry, surfaced for convenience. */
  townHall?: ExportBuilding;
  /** 1x1 road cells. */
  road1Cells: Set<string>;
  /** Top-left corners of each placed 2x2 road block. */
  road2Blocks: Set<string>;
}

export interface LayoutReport {
  json: string;
  text: string;
}

// ---------- Constants ----------

const INHERENT_NO_ROAD_TYPES = new Set([
  'street', 'main_building', 'tower', 'hub_main', 'hub_part', 'decoration',
]);

// ASCII glyphs for the grid view. Buildings span multiple cells so the same
// glyph fills the whole footprint.
const TYPE_GLYPH: Record<string, string> = {
  main_building: 'T',
  greatbuilding: 'G',
  generic_building: 'B',
  military: 'M',
  residential: 'H',
  production: 'P',
  goods: 'g',
  culture: 'C',
  decoration: 'd',
  tower: 'W',
  hub_main: 'U',
  hub_part: 'u',
};

const GLYPH_LEGEND: Array<[string, string]> = [
  [' ', 'cell outside the unlocked area'],
  ['.', 'available empty cell'],
  ['r', '1x1 road cell'],
  ['R', '2x2 road cell'],
  ['T', 'Town Hall (main_building)'],
  ['G', 'great building'],
  ['B', 'generic building'],
  ['M', 'military'],
  ['H', 'residential'],
  ['P', 'production'],
  ['g', 'goods'],
  ['C', 'culture'],
  ['d', 'decoration'],
  ['W', 'tower'],
  ['U', 'hub_main'],
  ['u', 'hub_part'],
  ['?', 'other / unrecognized type'],
];

// ---------- Helpers ----------

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function parseKey(k: string): { x: number; y: number } {
  const [x, y] = k.split(',').map(Number);
  return { x, y };
}

function deriveAvailableCells(
  unlockedAreas: Array<{ x?: number; y?: number; width: number; length: number }>,
): Set<string> {
  const set = new Set<string>();
  for (const a of unlockedAreas) {
    const ax = a.x ?? 0;
    const ay = a.y ?? 0;
    for (let dx = 0; dx < a.width; dx++) {
      for (let dy = 0; dy < a.length; dy++) {
        set.add(cellKey(ax + dx, ay + dy));
      }
    }
  }
  return set;
}

function glyphForBuilding(b: ExportBuilding): string {
  if (b.type === 'main_building') return 'T';
  return TYPE_GLYPH[b.type] ?? '?';
}

/** Compute the connected sets of road cells/blocks from the Town Hall, using the
 * optimizer's two-tier rule:
 *  - 2x2 connected only via 2x2 (stride-2 BFS) seeded from blocks adjacent to TH.
 *  - 1x1 connected via 1x1, seeded from TH-adjacent cells AND from cells adjacent
 *    to a connected 2x2 cell. (1x1 may branch off 2x2; 2x2 may NOT reach via 1x1.)
 */
function computeConnectivity(
  townHall: ExportBuilding | undefined,
  road1Cells: Set<string>,
  road2Blocks: Set<string>,
): {
  connected2x2Blocks: Set<string>;
  connected1x1Cells: Set<string>;
  thEdgeCells: Set<string>;
} {
  const thEdgeCells = new Set<string>();
  if (townHall) {
    for (let dx = -1; dx <= townHall.width; dx++) {
      for (let dy = -1; dy <= townHall.length; dy++) {
        const onEdge = dx === -1 || dx === townHall.width || dy === -1 || dy === townHall.length;
        const isCorner = (dx === -1 || dx === townHall.width) && (dy === -1 || dy === townHall.length);
        if (!onEdge || isCorner) continue;
        thEdgeCells.add(cellKey(townHall.x + dx, townHall.y + dy));
      }
    }
  }

  const connected2x2Blocks = new Set<string>();
  const q2: string[] = [];
  for (const e of thEdgeCells) {
    const p = parseKey(e);
    const seedCandidates = [
      cellKey(p.x, p.y), cellKey(p.x - 1, p.y),
      cellKey(p.x, p.y - 1), cellKey(p.x - 1, p.y - 1),
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
      cellKey(p.x + 2, p.y), cellKey(p.x - 2, p.y),
      cellKey(p.x, p.y + 2), cellKey(p.x, p.y - 2),
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
    connected2x2Cells.add(cellKey(p.x, p.y));
    connected2x2Cells.add(cellKey(p.x + 1, p.y));
    connected2x2Cells.add(cellKey(p.x, p.y + 1));
    connected2x2Cells.add(cellKey(p.x + 1, p.y + 1));
  }

  const connected1x1Cells = new Set<string>();
  const q1: string[] = [];
  for (const c of road1Cells) {
    let seed = thEdgeCells.has(c);
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

  return { connected2x2Blocks, connected1x1Cells, thEdgeCells };
}

/** Count buildings that need a road but have no connected road cell on their perimeter. */
function countUnservedRoadBuildings(
  buildings: ExportBuilding[],
  connected1x1Cells: Set<string>,
  connected2x2Blocks: Set<string>,
): { unservedRoad1: number; unservedRoad2: number } {
  let unservedRoad1 = 0;
  let unservedRoad2 = 0;
  const connected2x2Cells = new Set<string>();
  for (const bk of connected2x2Blocks) {
    const p = parseKey(bk);
    connected2x2Cells.add(cellKey(p.x, p.y));
    connected2x2Cells.add(cellKey(p.x + 1, p.y));
    connected2x2Cells.add(cellKey(p.x, p.y + 1));
    connected2x2Cells.add(cellKey(p.x + 1, p.y + 1));
  }
  for (const b of buildings) {
    if (b.roadLevel <= 0 || b.type === 'main_building') continue;
    let served = false;
    for (let dx = -1; dx <= b.width && !served; dx++) {
      for (let dy = -1; dy <= b.length && !served; dy++) {
        const onEdge = dx === -1 || dx === b.width || dy === -1 || dy === b.length;
        const isCorner = (dx === -1 || dx === b.width) && (dy === -1 || dy === b.length);
        if (!onEdge || isCorner) continue;
        const k = cellKey(b.x + dx, b.y + dy);
        if (b.roadLevel >= 2) {
          if (connected2x2Cells.has(k)) served = true;
        } else if (connected1x1Cells.has(k) || connected2x2Cells.has(k)) {
          served = true;
        }
      }
    }
    if (!served) {
      if (b.roadLevel >= 2) unservedRoad2++;
      else unservedRoad1++;
    }
  }
  return { unservedRoad1, unservedRoad2 };
}

// ---------- Main entry ----------

export function buildLayoutReport(input: LayoutReportInput): LayoutReport {
  const availableCells = input.availableCells
    ?? (input.unlockedAreas ? deriveAvailableCells(input.unlockedAreas) : new Set<string>());

  const townHall = input.townHall ?? input.buildings.find(b => b.type === 'main_building');

  // Derive 2x2 road cells (4 per block).
  const road2Cells = new Set<string>();
  for (const bk of input.road2Blocks) {
    const p = parseKey(bk);
    road2Cells.add(cellKey(p.x, p.y));
    road2Cells.add(cellKey(p.x + 1, p.y));
    road2Cells.add(cellKey(p.x, p.y + 1));
    road2Cells.add(cellKey(p.x + 1, p.y + 1));
  }

  let buildingCellCount = 0;
  for (const b of input.buildings) buildingCellCount += b.width * b.length;
  const roadCellCount = input.road1Cells.size + road2Cells.size;
  const emptyCellCount = Math.max(0, availableCells.size - buildingCellCount - roadCellCount);

  const conn = computeConnectivity(townHall, input.road1Cells, input.road2Blocks);
  const unserved = countUnservedRoadBuildings(input.buildings, conn.connected1x1Cells, conn.connected2x2Blocks);

  // Phase stats (excluding Town Hall)
  const nonTH = input.buildings.filter(b => b.type !== 'main_building');
  const phaseStats = {
    road2: { total: nonTH.filter(b => b.roadLevel >= 2).length },
    road1: { total: nonTH.filter(b => b.roadLevel === 1).length },
    noRoad: { total: nonTH.filter(b => b.roadLevel <= 0).length },
  };

  // Building summary by type
  const byType: Record<string, { count: number; cells: number }> = {};
  for (const b of input.buildings) {
    const e = byType[b.type] ?? { count: 0, cells: 0 };
    e.count++;
    e.cells += b.width * b.length;
    byType[b.type] = e;
  }

  const sortedBuildings = [...input.buildings].sort((a, b) => a.y - b.y || a.x - b.x);

  const unplaced = input.unplaced ?? [];
  const unplacedByPhase = {
    road2: unplaced.filter(u => u.roadLevel >= 2).length,
    road1: unplaced.filter(u => u.roadLevel === 1).length,
    noRoad: unplaced.filter(u => u.roadLevel <= 0).length,
  };

  // Build the JSON report
  const jsonReport = {
    source: input.source,
    bounds: input.bounds,
    totals: {
      availableCells: availableCells.size,
      buildingCells: buildingCellCount,
      buildings: input.buildings.length,
      nonTownHallBuildings: nonTH.length,
      unplacedBuildings: unplaced.length,
      road1Cells: input.road1Cells.size,
      road2Cells: road2Cells.size,
      road2Blocks: input.road2Blocks.size,
      roadCellsTotal: roadCellCount,
      emptyCells: emptyCellCount,
      coveragePct: availableCells.size > 0
        ? +((buildingCellCount + roadCellCount) / availableCells.size * 100).toFixed(2)
        : 0,
    },
    unplaced,
    unplacedByPhase,
    phaseStats,
    buildingsByType: byType,
    townHall: townHall ? {
      x: townHall.x, y: townHall.y, width: townHall.width, length: townHall.length,
    } : null,
    connectivity: {
      road1Total: input.road1Cells.size,
      road1Connected: conn.connected1x1Cells.size,
      road1Orphan: input.road1Cells.size - conn.connected1x1Cells.size,
      road2BlocksTotal: input.road2Blocks.size,
      road2BlocksConnected: conn.connected2x2Blocks.size,
      road2BlocksOrphan: input.road2Blocks.size - conn.connected2x2Blocks.size,
      unservedRoad1Buildings: unserved.unservedRoad1,
      unservedRoad2Buildings: unserved.unservedRoad2,
    },
    roads: {
      r1: [...input.road1Cells].sort().map(parseKey).map(p => [p.x, p.y]),
      r2BlockTopLefts: [...input.road2Blocks].sort().map(parseKey).map(p => [p.x, p.y]),
    },
    buildings: sortedBuildings.map(b => ({
      id: b.id,
      name: b.name,
      type: b.type,
      x: b.x,
      y: b.y,
      width: b.width,
      length: b.length,
      roadLevel: b.roadLevel,
    })),
  };

  // Build the ASCII grid
  const { minX, minY, maxX, maxY } = input.bounds;
  const w = maxX - minX;
  const h = maxY - minY;

  const grid: string[][] = [];
  for (let row = 0; row < h; row++) {
    const line: string[] = [];
    for (let col = 0; col < w; col++) {
      const k = cellKey(minX + col, minY + row);
      line.push(availableCells.has(k) ? '.' : ' ');
    }
    grid.push(line);
  }

  const setCell = (x: number, y: number, glyph: string) => {
    const r = y - minY;
    const c = x - minX;
    if (r < 0 || r >= h || c < 0 || c >= w) return;
    grid[r][c] = glyph;
  };

  // Buildings (footprint glyph). Town Hall last so it always wins over overlap.
  for (const b of sortedBuildings) {
    if (b.type === 'main_building') continue;
    const g = glyphForBuilding(b);
    for (let dx = 0; dx < b.width; dx++) {
      for (let dy = 0; dy < b.length; dy++) {
        setCell(b.x + dx, b.y + dy, g);
      }
    }
  }
  // 1x1 then 2x2 then Town Hall (priority order so Town Hall is unmistakable)
  for (const c of input.road1Cells) {
    const p = parseKey(c);
    setCell(p.x, p.y, 'r');
  }
  for (const c of road2Cells) {
    const p = parseKey(c);
    setCell(p.x, p.y, 'R');
  }
  if (townHall) {
    for (let dx = 0; dx < townHall.width; dx++) {
      for (let dy = 0; dy < townHall.length; dy++) {
        setCell(townHall.x + dx, townHall.y + dy, 'T');
      }
    }
  }

  const asciiGrid = grid.map(r => r.join('')).join('\n');

  // Build the human-readable text report
  const lines: string[] = [];
  lines.push(`# Layout Report (${input.source})`);
  lines.push('');
  lines.push(`Bounds: x=${minX}..${maxX} (w=${w})  y=${minY}..${maxY} (h=${h})`);
  lines.push(`Available cells: ${availableCells.size}`);
  lines.push(`Buildings: ${input.buildings.length} (non-Town-Hall: ${nonTH.length})`);
  if (unplaced.length > 0) {
    lines.push(`UNPLACED buildings: ${unplaced.length}  [road2:${unplacedByPhase.road2}  road1:${unplacedByPhase.road1}  noRoad:${unplacedByPhase.noRoad}]`);
  }
  lines.push(`Building cells: ${buildingCellCount}`);
  lines.push(`Roads: ${input.road1Cells.size} 1x1 cells + ${input.road2Blocks.size} 2x2 blocks (${road2Cells.size} cells) = ${roadCellCount} road cells total`);
  lines.push(`Empty cells: ${emptyCellCount}  |  Coverage: ${jsonReport.totals.coveragePct}%`);
  lines.push('');
  lines.push('## Phase totals (non-Town-Hall)');
  lines.push(`  road2 (>=2): ${phaseStats.road2.total}`);
  lines.push(`  road1 (=1):  ${phaseStats.road1.total}`);
  lines.push(`  noRoad(<=0): ${phaseStats.noRoad.total}`);
  lines.push('');
  lines.push('## Connectivity (two-tier prune)');
  lines.push(`  1x1 road cells:  ${conn.connected1x1Cells.size} connected / ${input.road1Cells.size} total  (orphan: ${input.road1Cells.size - conn.connected1x1Cells.size})`);
  lines.push(`  2x2 road blocks: ${conn.connected2x2Blocks.size} connected / ${input.road2Blocks.size} total  (orphan: ${input.road2Blocks.size - conn.connected2x2Blocks.size})`);
  lines.push(`  Buildings missing road service: ${unserved.unservedRoad1} (need 1x1) + ${unserved.unservedRoad2} (need 2x2)`);
  lines.push('');
  lines.push('## Buildings by type');
  for (const [t, v] of Object.entries(byType).sort((a, b) => b[1].cells - a[1].cells)) {
    lines.push(`  ${t.padEnd(20, ' ')} count=${String(v.count).padStart(3)} cells=${v.cells}`);
  }
  lines.push('');
  lines.push('## ASCII grid legend');
  for (const [g, desc] of GLYPH_LEGEND) {
    lines.push(`  '${g}' = ${desc}`);
  }
  lines.push('');
  lines.push('## ASCII grid');
  lines.push(asciiGrid);
  lines.push('');
  lines.push('## JSON');
  lines.push(JSON.stringify(jsonReport, null, 2));

  return {
    json: JSON.stringify(jsonReport, null, 2),
    text: lines.join('\n'),
  };
}

// ---------- Adapter for the current city (CityGrid) ----------

function getStreetConnectionLevel(entity: CityEntity | undefined, buildingType: string): number {
  if (!entity) return 0;
  if (INHERENT_NO_ROAD_TYPES.has(buildingType)) return 0;
  const root = entity.requirements?.street_connection_level ?? 0;
  let compMax = 0;
  for (const comp of Object.values(entity.components ?? {})) {
    const level = (comp as { streetConnectionRequirement?: { requiredLevel?: number } })
      .streetConnectionRequirement?.requiredLevel ?? 0;
    if (level > compMax) compMax = level;
  }
  return Math.max(root, compMax);
}

/** Build a LayoutReport from the raw CityData (current state). */
export function buildCurrentLayoutReport(data: CityData, bounds: GridBounds): LayoutReport {
  const placed = getPlacedBuildings(data);

  const availableCells = deriveAvailableCells(data.UnlockedAreas as Array<{ x?: number; y?: number; width: number; length: number }>);

  const buildings: ExportBuilding[] = [];
  const road1Cells = new Set<string>();
  const road2Blocks = new Set<string>();

  // For 2x2 detection in the current city: a placed `street` of size 2x2 maps
  // directly to a road2Block top-left; a 1x1 street is a single 1x1 cell.
  for (const b of placed) {
    if (b.entry.type === 'street') {
      if (b.width === 2 && b.length === 2) {
        road2Blocks.add(cellKey(b.x, b.y));
      } else {
        // Could be 1x1 or some other shape; fill all cells as 1x1.
        for (let dx = 0; dx < b.width; dx++) {
          for (let dy = 0; dy < b.length; dy++) {
            road1Cells.add(cellKey(b.x + dx, b.y + dy));
          }
        }
      }
      continue;
    }
    const entity = data.CityEntities[b.entry.cityentity_id];
    buildings.push({
      id: b.entry.id,
      name: resolveBuildingName(b.entry.cityentity_id, data),
      type: b.entry.type,
      x: b.x,
      y: b.y,
      width: b.width,
      length: b.length,
      roadLevel: getStreetConnectionLevel(entity, b.entry.type),
    });
  }

  return buildLayoutReport({
    source: 'current',
    bounds,
    availableCells,
    buildings,
    road1Cells,
    road2Blocks,
  });
}

// ---------- Browser helpers ----------

/** Trigger a browser download of the given text content. */
export function downloadTextFile(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Best-effort copy-to-clipboard using the modern API; returns success boolean. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
