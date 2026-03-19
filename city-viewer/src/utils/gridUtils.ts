import type { CityData, CityMapEntry, UnlockedArea } from '../types/citydata';

export interface GridBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface PlacedBuilding {
  entry: CityMapEntry;
  x: number;
  y: number;
  width: number;
  length: number;
}

export function getGridBounds(areas: UnlockedArea[], buildings?: PlacedBuilding[]): GridBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const a of areas) {
    if (a.width == null || a.length == null) continue;
    const ax = a.x ?? 0;
    const ay = a.y ?? 0;
    minX = Math.min(minX, ax);
    minY = Math.min(minY, ay);
    maxX = Math.max(maxX, ax + a.width);
    maxY = Math.max(maxY, ay + a.length);
  }
  // Expand bounds to include all placed buildings
  if (buildings) {
    for (const b of buildings) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.length);
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

const OFF_GRID_TYPES = new Set(['friends_tavern', 'outpost_ship', 'off_grid', 'hub_main', 'hub_part']);

export function getPlacedBuildings(data: CityData): PlacedBuilding[] {
  const result: PlacedBuilding[] = [];
  for (const entry of Object.values(data.CityMapData)) {
    // Skip off-grid items (IDs > 2 billion) and off-grid building types
    if (entry.id > 2_000_000_000) continue;
    if (OFF_GRID_TYPES.has(entry.type)) continue;

    // Treat missing x/y as 0 (FOE API omits zero-value keys)
    const ex = entry.x ?? 0;
    const ey = entry.y ?? 0;

    const entity = data.CityEntities?.[entry.cityentity_id];
    // Resolve size: entity root → AllAge.placement.size → street=1, fallback=2
    const allAgePlacement = (entity as any)?.components?.AllAge?.placement?.size;
    const w = entity?.width ?? allAgePlacement?.x ?? (entry.type === 'street' ? 1 : 2);
    const l = entity?.length ?? allAgePlacement?.y ?? (entry.type === 'street' ? 1 : 2);

    result.push({
      entry,
      x: ex,
      y: ey,
      width: w,
      length: l,
    });
  }
  return result;
}

export const BUILDING_COLORS: Record<string, string> = {
  main_building: '#e6b800',
  greatbuilding: '#ffd700',
  generic_building: '#4a90d9',
  street: '#666666',
  tower: '#9b59b6',
  military: '#e74c3c',
  culture: '#27ae60',
  goods: '#2ecc71',
  production: '#e67e22',
  residential: '#3498db',
  decoration: '#c39bd3',
  hub_main: '#e67e22',
  friends_tavern: '#f39c12',
  outpost_ship: '#1abc9c',
  off_grid: '#95a5a6',
};

export function getBuildingColor(type: string): string {
  return BUILDING_COLORS[type] ?? '#888888';
}

/** Extract era from street cityentity_id, e.g. "S_IndustrialAge_Street1" → "IndustrialAge" */
export function getStreetEra(cityentityId: string): string {
  const m = cityentityId.match(/^S_([^_]+)/);
  return m ? m[1] : 'Unknown';
}
