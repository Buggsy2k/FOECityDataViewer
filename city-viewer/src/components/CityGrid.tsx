import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useCityData } from '../context/CityDataContext';
import { getGridBounds, getPlacedBuildings, getBuildingColor, getStreetEra, type PlacedBuilding } from '../utils/gridUtils';
import { resolveBuildingName, formatResourceName, getBuildingProduction, formatNumber, ERA_ORDER } from '../utils/dataProcessing';
import { buildCurrentLayoutReport, downloadTextFile, copyTextToClipboard } from '../utils/layoutExport';

const CELL_SIZE = 12;

const TYPE_LABELS: Record<string, string> = {
  main_building: 'Main Building',
  greatbuilding: 'Great Building',
  generic_building: 'Generic',
  street: 'Street',
  military: 'Military',
  tower: 'Tower',
  goods: 'Goods',
  production: 'Production',
  residential: 'Residential',
  decoration: 'Decoration',
  culture: 'Culture',
};

function formatStreetEra(era: string): string {
  return era.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export default function CityGrid() {
  const { data } = useCityData();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hoveredBuilding, setHoveredBuilding] = useState<PlacedBuilding | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  // Filter state
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [hiddenSizes, setHiddenSizes] = useState<Set<string>>(new Set());
  const [hiddenStreetEras, setHiddenStreetEras] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState('');
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const [sizeDropdownOpen, setSizeDropdownOpen] = useState(false);
  const [streetDropdownOpen, setStreetDropdownOpen] = useState(false);
  const typeDropdownRef = useRef<HTMLDivElement>(null);
  const sizeDropdownRef = useRef<HTMLDivElement>(null);
  const streetDropdownRef = useRef<HTMLDivElement>(null);

  const allBuildings = useMemo(() => {
    if (!data) return [];
    return getPlacedBuildings(data);
  }, [data]);

  const bounds = useMemo(() => {
    if (!data?.UnlockedAreas) return null;
    return getGridBounds(data.UnlockedAreas, allBuildings);
  }, [data, allBuildings]);

  // Derive available types and street eras from all buildings (static)
  const { presentTypes, streetEras } = useMemo(() => {
    const types = new Set<string>();
    const eras = new Set<string>();
    for (const b of allBuildings) {
      types.add(b.entry.type);
      if (b.entry.type === 'street') {
        eras.add(getStreetEra(b.entry.cityentity_id));
      }
    }
    // Sort street eras by ERA_ORDER
    const sortedEras = [...eras].sort((a, b) => {
      const ai = ERA_ORDER.indexOf(a);
      const bi = ERA_ORDER.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    // Only include types that exist in the data, in TYPE_LABELS order
    const orderedTypes = Object.keys(TYPE_LABELS).filter(t => types.has(t));
    for (const t of types) {
      if (!TYPE_LABELS[t] && !orderedTypes.includes(t)) orderedTypes.push(t);
    }
    return {
      presentTypes: orderedTypes,
      streetEras: sortedEras,
    };
  }, [allBuildings]);

  // Derive available sizes from buildings that pass type + street era filters
  const buildingSizes = useMemo(() => {
    const sizes = new Set<string>();
    for (const b of allBuildings) {
      if (hiddenTypes.has(b.entry.type)) continue;
      if (b.entry.type === 'street' && hiddenStreetEras.has(getStreetEra(b.entry.cityentity_id))) continue;
      sizes.add(`${b.width}x${b.length}`);
    }
    return [...sizes].sort((a, b) => {
      const [aw, al] = a.split('x').map(Number);
      const [bw, bl] = b.split('x').map(Number);
      return (aw * al) - (bw * bl) || aw - bw;
    });
  }, [allBuildings, hiddenTypes, hiddenStreetEras]);

  // When available sizes change, adjust hiddenSizes:
  // - If all were selected (hiddenSizes empty), keep all selected
  // - If a partial filter was applied and all hidden sizes vanished, reset to all selected
  // - If new sizes appear while a partial filter is active, hide them (not selected)
  // - Remove hidden sizes that no longer exist
  const prevSizesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const availableSet = new Set(buildingSizes);
    const prevSet = prevSizesRef.current;
    prevSizesRef.current = availableSet;

    if (hiddenSizes.size === 0) return;

    const stillValid = [...hiddenSizes].some(s => availableSet.has(s));
    if (!stillValid) {
      setHiddenSizes(new Set());
      return;
    }

    let next = new Set([...hiddenSizes].filter(s => availableSet.has(s)));
    // Hide any newly appearing sizes
    for (const s of buildingSizes) {
      if (!prevSet.has(s)) next.add(s);
    }
    if (next.size !== hiddenSizes.size || [...next].some(s => !hiddenSizes.has(s))) {
      setHiddenSizes(next);
    }
  }, [buildingSizes]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (typeDropdownRef.current && !typeDropdownRef.current.contains(e.target as Node)) setTypeDropdownOpen(false);
      if (sizeDropdownRef.current && !sizeDropdownRef.current.contains(e.target as Node)) setSizeDropdownOpen(false);
      if (streetDropdownRef.current && !streetDropdownRef.current.contains(e.target as Node)) setStreetDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Build name map for search
  const nameMap = useMemo(() => {
    if (!data) return new Map<number, string>();
    const m = new Map<number, string>();
    for (const b of allBuildings) {
      m.set(b.entry.id, resolveBuildingName(b.entry.cityentity_id, data));
    }
    return m;
  }, [data, allBuildings]);

  // Search matches
  const searchMatches = useMemo(() => {
    if (!searchText.trim()) return new Set<number>();
    const lower = searchText.toLowerCase();
    const matches = new Set<number>();
    for (const [id, name] of nameMap) {
      if (name.toLowerCase().includes(lower)) matches.add(id);
    }
    return matches;
  }, [searchText, nameMap]);

  const hasSearch = searchText.trim().length > 0;

  const getRequiredStreetLevelFor = useCallback((b: PlacedBuilding): number => {
    const entity = data?.CityEntities?.[b.entry.cityentity_id];
    const root = entity?.requirements?.street_connection_level ?? 0;
    let comp = 0;
    for (const c of Object.values(entity?.components ?? {})) {
      const lvl = (c as { streetConnectionRequirement?: { requiredLevel?: number } })
        ?.streetConnectionRequirement?.requiredLevel ?? 0;
      if (lvl > comp) comp = lvl;
    }
    return Math.max(root, comp);
  }, [data]);

  const roadConnectivity = useMemo(() => {
    const streetByCellAny = new Map<string, number>();
    const streetByCell2x2 = new Map<string, number>();
    const streetNeighborsAny = new Map<number, Set<number>>();
    const streetNeighbors2x2 = new Map<number, Set<number>>();
    const streetIds = new Set<number>();
    const street2x2Ids = new Set<number>();
    const connectedStreetIdsAny = new Set<number>();
    const connectedStreetIds2x2 = new Set<number>();
    const connectedBuildingIdsAny = new Set<number>();
    const connectedBuildingIds2x2 = new Set<number>();
    const mainBuilding = allBuildings.find(b => b.entry.type === 'main_building') ?? null;

    const isTwoByTwoStreet = (building: PlacedBuilding): boolean => {
      return building.entry.type === 'street' && building.width === 2 && building.length === 2;
    };

    const getRequiredStreetLevel = (building: PlacedBuilding): number => {
      const entity = data?.CityEntities?.[building.entry.cityentity_id];
      const rootLevel = entity?.requirements?.street_connection_level ?? 0;
      let componentLevel = 0;
      for (const comp of Object.values(entity?.components ?? {})) {
        const level = (comp as { streetConnectionRequirement?: { requiredLevel?: number } })
          ?.streetConnectionRequirement?.requiredLevel ?? 0;
        if (level > componentLevel) componentLevel = level;
      }
      return Math.max(rootLevel, componentLevel);
    };

    const getEdgeCells = (building: PlacedBuilding): string[] => {
      const edgeCells: string[] = [];
      for (let dx = -1; dx <= building.width; dx++) {
        for (let dy = -1; dy <= building.length; dy++) {
          const onEdge = dx === -1 || dx === building.width || dy === -1 || dy === building.length;
          const isCorner = (dx === -1 || dx === building.width) && (dy === -1 || dy === building.length);
          if (!onEdge || isCorner) continue;
          edgeCells.push(`${building.x + dx},${building.y + dy}`);
        }
      }
      return edgeCells;
    };

    for (const building of allBuildings) {
      if (building.entry.type !== 'street') continue;
      streetIds.add(building.entry.id);
      streetNeighborsAny.set(building.entry.id, new Set());
      if (isTwoByTwoStreet(building)) {
        street2x2Ids.add(building.entry.id);
        streetNeighbors2x2.set(building.entry.id, new Set());
      }
      for (let dx = 0; dx < building.width; dx++) {
        for (let dy = 0; dy < building.length; dy++) {
          const key = `${building.x + dx},${building.y + dy}`;
          streetByCellAny.set(key, building.entry.id);
          if (isTwoByTwoStreet(building)) {
            streetByCell2x2.set(key, building.entry.id);
          }
        }
      }
    }

    for (const building of allBuildings) {
      if (building.entry.type !== 'street') continue;
      const neighborsAny = streetNeighborsAny.get(building.entry.id);
      if (!neighborsAny) continue;
      for (const cell of getEdgeCells(building)) {
        const neighborAnyId = streetByCellAny.get(cell);
        if (neighborAnyId != null && neighborAnyId !== building.entry.id) {
          neighborsAny.add(neighborAnyId);
        }

        if (street2x2Ids.has(building.entry.id)) {
          const neighbors2x2 = streetNeighbors2x2.get(building.entry.id);
          const neighbor2x2Id = streetByCell2x2.get(cell);
          if (neighbors2x2 && neighbor2x2Id != null && neighbor2x2Id !== building.entry.id) {
            neighbors2x2.add(neighbor2x2Id);
          }
        }
      }
    }

    const queueAny: number[] = [];
    const queue2x2: number[] = [];
    if (mainBuilding) {
      for (const cell of getEdgeCells(mainBuilding)) {
        const anyStreetId = streetByCellAny.get(cell);
        if (anyStreetId != null && !connectedStreetIdsAny.has(anyStreetId)) {
          connectedStreetIdsAny.add(anyStreetId);
          queueAny.push(anyStreetId);
        }

        const street2x2Id = streetByCell2x2.get(cell);
        if (street2x2Id != null && !connectedStreetIds2x2.has(street2x2Id)) {
          connectedStreetIds2x2.add(street2x2Id);
          queue2x2.push(street2x2Id);
        }
      }
    }

    while (queueAny.length > 0) {
      const streetId = queueAny.shift();
      if (streetId == null) continue;
      for (const neighborStreetId of streetNeighborsAny.get(streetId) ?? []) {
        if (connectedStreetIdsAny.has(neighborStreetId)) continue;
        connectedStreetIdsAny.add(neighborStreetId);
        queueAny.push(neighborStreetId);
      }
    }

    while (queue2x2.length > 0) {
      const streetId = queue2x2.shift();
      if (streetId == null) continue;
      for (const neighborStreetId of streetNeighbors2x2.get(streetId) ?? []) {
        if (connectedStreetIds2x2.has(neighborStreetId)) continue;
        connectedStreetIds2x2.add(neighborStreetId);
        queue2x2.push(neighborStreetId);
      }
    }

    for (const building of allBuildings) {
      if (building.entry.type === 'street') continue;
      const requiredStreetLevel = getRequiredStreetLevel(building);
      for (const cell of getEdgeCells(building)) {
        const anyStreetId = streetByCellAny.get(cell);
        if (anyStreetId != null && connectedStreetIdsAny.has(anyStreetId)) {
          connectedBuildingIdsAny.add(building.entry.id);
        }

        if (requiredStreetLevel >= 2) {
          const street2x2Id = streetByCell2x2.get(cell);
          if (street2x2Id != null && connectedStreetIds2x2.has(street2x2Id)) {
            connectedBuildingIds2x2.add(building.entry.id);
          }
        }

        if (requiredStreetLevel < 2 && connectedBuildingIdsAny.has(building.entry.id)) {
          break;
        }
        if (requiredStreetLevel >= 2 && connectedBuildingIds2x2.has(building.entry.id)) {
          break;
        }
      }
    }

    return {
      streetIds,
      connectedStreetIdsAny,
      connectedStreetIds2x2,
      connectedBuildingIdsAny,
      connectedBuildingIds2x2,
    };
  }, [allBuildings, data]);

  // Filtered buildings
  const buildings = useMemo(() => {
    return allBuildings.filter(b => {
      if (hiddenTypes.has(b.entry.type)) return false;
      if (hiddenSizes.size > 0 && hiddenSizes.has(`${b.width}x${b.length}`)) return false;
      if (b.entry.type === 'street' && hiddenStreetEras.has(getStreetEra(b.entry.cityentity_id))) return false;
      return true;
    });
  }, [allBuildings, hiddenTypes, hiddenSizes, hiddenStreetEras]);

  // Initialize viewBox from bounds
  useEffect(() => {
    if (bounds && !viewBox) {
      const pad = 2;
      setViewBox({
        x: (bounds.minX - pad) * CELL_SIZE,
        y: (bounds.minY - pad) * CELL_SIZE,
        w: (bounds.width + pad * 2) * CELL_SIZE,
        h: (bounds.height + pad * 2) * CELL_SIZE,
      });
    }
  }, [bounds, viewBox]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setViewBox(prev => {
      if (!prev) return prev;
      const scale = e.deltaY > 0 ? 1.1 : 0.9;
      const svg = svgRef.current;
      if (!svg) return prev;

      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;

      const newW = prev.w * scale;
      const newH = prev.h * scale;
      return {
        x: prev.x + (prev.w - newW) * mx,
        y: prev.y + (prev.h - newH) * my,
        w: newW,
        h: newH,
      };
    });
  }, []);

  // Attach non-passive wheel listener via callback ref (fires when element mounts)
  const wrapperCallbackRef = useCallback((node: HTMLDivElement | null) => {
    (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    if (node) {
      node.addEventListener('wheel', handleWheel, { passive: false });
    }
  }, [handleWheel]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    setViewBox(prev => {
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        vx: prev?.x ?? 0,
        vy: prev?.y ?? 0,
      };
      return prev;
    });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    setViewBox(prev => {
      if (!prev) return prev;
      const dx = (e.clientX - panStart.current.x) * (prev.w / rect.width);
      const dy = (e.clientY - panStart.current.y) * (prev.h / rect.height);
      return {
        ...prev,
        x: panStart.current.vx - dx,
        y: panStart.current.vy - dy,
      };
    });
  }, [isPanning]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const toggleType = (type: string) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  const toggleSize = (size: string) => {
    setHiddenSizes(prev => {
      const next = new Set(prev);
      if (next.has(size)) next.delete(size); else next.add(size);
      return next;
    });
  };

  const toggleStreetEra = (era: string) => {
    setHiddenStreetEras(prev => {
      const next = new Set(prev);
      if (next.has(era)) next.delete(era); else next.add(era);
      return next;
    });
  };

  const gridStats = useMemo(() => {
    if (!data || !bounds) return null;
    let availableCells = 0;
    for (const a of data.UnlockedAreas) availableCells += a.width * a.length;

    let buildingCells = 0;
    let roadCells = 0;
    let road1Count = 0;
    let road2Count = 0;
    let needs2Count = 0;
    let needs1Count = 0;
    let noRoadCount = 0;
    let disconnectedCount = 0;
    let wastedRoadCount = 0;
    let orphanRoadCount = 0;
    const inherent = new Set(['street', 'main_building', 'tower', 'hub_main', 'hub_part', 'decoration']);
    const typeCounts = new Map<string, number>();

    for (const b of allBuildings) {
      const cells = b.width * b.length;
      if (b.entry.type === 'street') {
        roadCells += cells;
        if (b.width === 2 && b.length === 2) road2Count++;
        else if (b.width === 1 && b.length === 1) road1Count++;
        if (!roadConnectivity.connectedStreetIdsAny.has(b.entry.id)) orphanRoadCount++;
      } else {
        buildingCells += cells;
        typeCounts.set(b.entry.type, (typeCounts.get(b.entry.type) ?? 0) + 1);
        const lvl = getRequiredStreetLevelFor(b);
        const needsRoad = !inherent.has(b.entry.type) && lvl > 0;
        if (lvl >= 2) needs2Count++;
        else if (lvl === 1) needs1Count++;
        else if (b.entry.type !== 'main_building') noRoadCount++;
        if (needsRoad) {
          const ok = lvl >= 2
            ? roadConnectivity.connectedBuildingIds2x2.has(b.entry.id)
            : roadConnectivity.connectedBuildingIdsAny.has(b.entry.id);
          if (!ok) disconnectedCount++;
        } else if (!inherent.has(b.entry.type)) {
          if (roadConnectivity.connectedBuildingIdsAny.has(b.entry.id)) wastedRoadCount++;
        }
      }
    }

    const emptyCells = Math.max(0, availableCells - buildingCells - roadCells);
    const buildingsTotal = needs2Count + needs1Count + noRoadCount; // excludes main_building
    const topTypes = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    return {
      availableCells,
      buildingCells,
      roadCells,
      emptyCells,
      road1Count,
      road2Count,
      roadEntities: road1Count + road2Count,
      needs2Count,
      needs1Count,
      noRoadCount,
      buildingsTotal,
      disconnectedCount,
      wastedRoadCount,
      orphanRoadCount,
      topTypes,
      areaCount: data.UnlockedAreas.length,
      gridWidth: bounds.width,
      gridHeight: bounds.height,
    };
  }, [data, bounds, allBuildings, roadConnectivity, getRequiredStreetLevelFor]);

  if (!data || !bounds || !viewBox) return null;

  return (
    <div className="city-grid-container">
      <div className="grid-header">
        <h2>City Grid Map</h2>
        <div className="grid-toolbar">
          {/* Types dropdown */}
          <div className="grid-dropdown" ref={typeDropdownRef}>
            <button className="grid-dropdown-btn" onClick={() => setTypeDropdownOpen(v => !v)}>
              {hiddenTypes.size === 0 ? 'All Types' : `${presentTypes.length - hiddenTypes.size} of ${presentTypes.length} Types`}
              <span className="grid-dropdown-arrow">{typeDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
          {typeDropdownOpen && (
            <div className="grid-dropdown-menu">
              <label className="grid-dropdown-item grid-dropdown-all">
                <input
                  type="checkbox"
                  checked={hiddenTypes.size === 0}
                  onChange={() => setHiddenTypes(hiddenTypes.size === 0 ? new Set(presentTypes) : new Set())}
                />
                All
              </label>
              {presentTypes.map(type => (
                <label key={type} className="grid-dropdown-item">
                  <input
                    type="checkbox"
                    checked={!hiddenTypes.has(type)}
                    onChange={() => toggleType(type)}
                  />
                  <span className="legend-color" style={{ background: getBuildingColor(type) }} />
                  {TYPE_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Size dropdown */}
        {buildingSizes.length > 0 && (
          <div className="grid-dropdown" ref={sizeDropdownRef}>
            <button className="grid-dropdown-btn" onClick={() => setSizeDropdownOpen(v => !v)}>
              {hiddenSizes.size === 0 ? 'All Sizes' : `${buildingSizes.length - hiddenSizes.size} of ${buildingSizes.length} Sizes`}
              <span className="grid-dropdown-arrow">{sizeDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {sizeDropdownOpen && (
              <div className="grid-dropdown-menu">
                <label className="grid-dropdown-item grid-dropdown-all">
                  <input
                    type="checkbox"
                    checked={hiddenSizes.size === 0}
                    onChange={() => setHiddenSizes(hiddenSizes.size === 0 ? new Set(buildingSizes) : new Set())}
                  />
                  All
                </label>
                {buildingSizes.map(size => (
                  <label key={size} className="grid-dropdown-item">
                    <input
                      type="checkbox"
                      checked={!hiddenSizes.has(size)}
                      onChange={() => toggleSize(size)}
                    />
                    {size}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Street era dropdown */}
        {!hiddenTypes.has('street') && streetEras.length > 0 && (
          <div className="grid-dropdown" ref={streetDropdownRef}>
            <button className="grid-dropdown-btn" onClick={() => setStreetDropdownOpen(v => !v)}>
              {hiddenStreetEras.size === 0 ? 'All Street Eras' : `${streetEras.length - hiddenStreetEras.size} of ${streetEras.length} Eras`}
              <span className="grid-dropdown-arrow">{streetDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {streetDropdownOpen && (
              <div className="grid-dropdown-menu">
                <label className="grid-dropdown-item grid-dropdown-all">
                  <input
                    type="checkbox"
                    checked={hiddenStreetEras.size === 0}
                    onChange={() => setHiddenStreetEras(hiddenStreetEras.size === 0 ? new Set(streetEras) : new Set())}
                  />
                  All
                </label>
                {streetEras.map(era => (
                  <label key={era} className="grid-dropdown-item">
                    <input
                      type="checkbox"
                      checked={!hiddenStreetEras.has(era)}
                      onChange={() => toggleStreetEra(era)}
                    />
                    {formatStreetEra(era)}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

          <div className="grid-search">
            <input
              type="text"
              placeholder="Search buildings..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="grid-search-input"
            />
            {hasSearch && (
              <span className="grid-search-count">
                {searchMatches.size} match{searchMatches.size !== 1 ? 'es' : ''}
              </span>
            )}
          </div>
          <div className="grid-export">
            <button
              className="grid-dropdown-btn"
              title="Download a text+JSON layout report (current city)"
              onClick={() => {
                if (!data || !bounds) return;
                const r = buildCurrentLayoutReport(data, bounds);
                downloadTextFile('city-layout-current.txt', r.text, 'text/plain');
                downloadTextFile('city-layout-current.json', r.json, 'application/json');
              }}
            >
              Export Layout
            </button>
            <button
              className="grid-dropdown-btn"
              title="Copy the layout report (text + JSON) to the clipboard"
              onClick={async () => {
                if (!data || !bounds) return;
                const r = buildCurrentLayoutReport(data, bounds);
                const ok = await copyTextToClipboard(r.text);
                if (!ok) downloadTextFile('city-layout-current.txt', r.text, 'text/plain');
              }}
            >
              Copy Layout
            </button>
          </div>
        </div>
      </div>

      <div className="grid-body">
      <div
        className="grid-wrapper"
        ref={wrapperCallbackRef}
        style={{ position: 'relative' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          ref={svgRef}
          className="city-svg"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        >
          {/* Grid pattern definition for 1x1 cells */}
          <defs>
            <pattern id="grid-1x1" width={CELL_SIZE} height={CELL_SIZE} patternUnits="userSpaceOnUse">
              <rect width={CELL_SIZE} height={CELL_SIZE} fill="none" stroke="#2a2a4e" strokeWidth={0.3} />
            </pattern>
            <filter id="search-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Unlocked areas background — single fill per area, 1x1 grid overlay */}
          {data.UnlockedAreas.map((area, i) => (
            <g key={`area-${i}`}>
              <rect
                x={area.x * CELL_SIZE}
                y={area.y * CELL_SIZE}
                width={area.width * CELL_SIZE}
                height={area.length * CELL_SIZE}
                fill="#1a1a2e"
              />
              <rect
                x={area.x * CELL_SIZE}
                y={area.y * CELL_SIZE}
                width={area.width * CELL_SIZE}
                height={area.length * CELL_SIZE}
                fill="url(#grid-1x1)"
              />
            </g>
          ))}

          {/* Buildings */}
          {buildings.map(b => {
            const isHovered = hoveredBuilding?.entry.id === b.entry.id;
            const isMatch = hasSearch && searchMatches.has(b.entry.id);
            const dimmed = hasSearch && !isMatch && !isHovered;
            const entity = data.CityEntities?.[b.entry.cityentity_id];
            const inherent = new Set(['street', 'main_building', 'tower', 'hub_main', 'hub_part', 'decoration']);
            const isStreet = b.entry.type === 'street';
            const isTwoByTwoStreet = isStreet && b.width === 2 && b.length === 2;
            const rootStreetLevel = entity?.requirements?.street_connection_level ?? 0;
            const componentStreetLevel = (Object.values(entity?.components ?? []) as Array<{ streetConnectionRequirement?: { requiredLevel?: number } }>).reduce<number>((maxLevel, c) => {
              const level = c.streetConnectionRequirement?.requiredLevel ?? 0;
              return Math.max(maxLevel, level);
            }, 0);
            const requiredStreetLevel = Math.max(rootStreetLevel, componentStreetLevel);
            const needsRoad = !inherent.has(b.entry.type) && (
              requiredStreetLevel > 0
            );
            const requires2x2RoadPath = requiredStreetLevel >= 2;
            const hasConnectedRoadPath = requires2x2RoadPath
              ? roadConnectivity.connectedBuildingIds2x2.has(b.entry.id)
              : roadConnectivity.connectedBuildingIdsAny.has(b.entry.id);
            const hasAnyConnectedRoadPath = roadConnectivity.connectedBuildingIdsAny.has(b.entry.id);
            const disconnected = needsRoad && !hasConnectedRoadPath;
            const wastedRoad = !needsRoad && hasAnyConnectedRoadPath && !inherent.has(b.entry.type);
            const orphanRoad = isStreet && !roadConnectivity.connectedStreetIdsAny.has(b.entry.id);
            const showBorder = (needsRoad || wastedRoad || orphanRoad) && !dimmed;
            const isRed = disconnected || wastedRoad || orphanRoad;
            const fillColor = isStreet
              ? (isTwoByTwoStreet ? '#7b7b7b' : '#616161')
              : getBuildingColor(b.entry.type);
            const innerBorderWidth = requires2x2RoadPath
              ? (isRed ? 2.2 : 1.4)
              : (isRed ? 1.5 : 0.8);

            return (
              <g key={b.entry.id}>
                <rect
                  x={b.x * CELL_SIZE + 0.5}
                  y={b.y * CELL_SIZE + 0.5}
                  width={b.width * CELL_SIZE - 1}
                  height={b.length * CELL_SIZE - 1}
                  fill={isMatch ? '#ff0' : fillColor}
                  opacity={dimmed ? 0.15 : isHovered ? 1 : isMatch ? 0.95 : 0.75}
                  stroke={isHovered ? '#fff' : isMatch ? '#ff0' : 'rgba(0,0,0,0.3)'}
                  strokeWidth={isHovered ? 2 : isMatch ? 1.5 : 0.5}
                  rx={1}
                  filter={isMatch ? 'url(#search-glow)' : undefined}
                  onMouseEnter={(e) => {
                    setHoveredBuilding(b);
                    setTooltipPos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => setHoveredBuilding(null)}
                  style={{ cursor: 'pointer' }}
                />
                {showBorder && (
                  <rect
                    x={b.x * CELL_SIZE + 2}
                    y={b.y * CELL_SIZE + 2}
                    width={b.width * CELL_SIZE - 4}
                    height={b.length * CELL_SIZE - 4}
                    fill="none"
                    stroke={isRed ? 'rgba(255,0,0,0.9)' : 'rgba(255,255,255,0.6)'}
                    strokeWidth={innerBorderWidth}
                    rx={0.5}
                    pointerEvents="none"
                  />
                )}
                {!isStreet && !dimmed && (() => {
                  const pxPad = 1.5;
                  const wPx = b.width * CELL_SIZE - 1;
                  const hPx = b.length * CELL_SIZE - 1;
                  const rotated = b.length > b.width;
                  // After rotation the inner content's effective box is hPx x wPx.
                  const innerW = rotated ? hPx : wPx;
                  const innerH = rotated ? wPx : hPx;
                  const name = resolveBuildingName(b.entry.cityentity_id, data);
                  return (
                    <foreignObject
                      x={b.x * CELL_SIZE + 0.5}
                      y={b.y * CELL_SIZE + 0.5}
                      width={wPx}
                      height={hPx}
                      pointerEvents="none"
                    >
                      <div
                        // @ts-expect-error xmlns is valid on HTML inside foreignObject
                        xmlns="http://www.w3.org/1999/xhtml"
                        style={{
                          width: `${innerW}px`,
                          height: `${innerH}px`,
                          transform: rotated
                            ? `translate(${wPx}px, 0) rotate(90deg)`
                            : undefined,
                          transformOrigin: '0 0',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          textAlign: 'center',
                          padding: `${pxPad}px`,
                          boxSizing: 'border-box',
                          overflow: 'hidden',
                          fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
                          fontSize: '4px',
                          lineHeight: 1,
                          color: '#fff',
                          textShadow: '0 0 1px rgba(0,0,0,0.95), 0 0 1px rgba(0,0,0,0.95)',
                          fontWeight: 300,
                          fontStretch: 'condensed',
                          letterSpacing: '-0.05px',
                          wordBreak: 'break-word',
                          overflowWrap: 'anywhere',
                          hyphens: 'auto',
                        }}
                      >
                        {name}
                      </div>
                    </foreignObject>
                  );
                })()}
              </g>
            );
          })}
        </svg>

        {hoveredBuilding && (
          <div
            className="grid-tooltip"
            style={{
              position: 'fixed',
              left: tooltipPos.x + 12,
              top: tooltipPos.y - 10,
            }}
          >
            <strong>{resolveBuildingName(hoveredBuilding.entry.cityentity_id, data)}</strong>
            <br />
            <span className="tooltip-type">{hoveredBuilding.entry.type.replace(/_/g, ' ')}</span>
            {hoveredBuilding.entry.level !== undefined && (
              <><br />Level: {hoveredBuilding.entry.level}</>
            )}
            <TooltipProduction entry={hoveredBuilding.entry} />
          </div>
        )}
      </div>
        {gridStats && (
          <aside className="grid-stats">
            <h3>City Statistics</h3>

            <div className="grid-stats-section">
              <div className="grid-stats-section-title">Layout</div>
              <div className="grid-stats-row"><span>Grid extent</span><b>{gridStats.gridWidth} × {gridStats.gridHeight}</b></div>
              <div className="grid-stats-row"><span>Unlocked areas</span><b>{gridStats.areaCount}</b></div>
              <div className="grid-stats-row"><span>Available cells</span><b>{gridStats.availableCells.toLocaleString()}</b></div>
              <div className="grid-stats-row"><span>Building cells</span><b>{gridStats.buildingCells.toLocaleString()}</b></div>
              <div className="grid-stats-row"><span>Road cells</span><b>{gridStats.roadCells.toLocaleString()}</b></div>
              <div className="grid-stats-row"><span>Empty cells</span><b>{gridStats.emptyCells.toLocaleString()}</b></div>
            </div>

            <div className="grid-stats-section">
              <div className="grid-stats-section-title">Roads</div>
              <div className="grid-stats-row"><span><i className="swatch road1" /> 1×1 road tiles</span><b>{gridStats.road1Count}</b></div>
              <div className="grid-stats-row"><span><i className="swatch road2" /> 2×2 road tiles</span><b>{gridStats.road2Count}</b></div>
              <div className="grid-stats-row"><span>Total road entities</span><b>{gridStats.roadEntities}</b></div>
              <div className="grid-stats-row"><span>Orphan roads (no path to TH)</span>
                <b className={gridStats.orphanRoadCount > 0 ? 'bad' : ''}>{gridStats.orphanRoadCount}</b>
              </div>
            </div>

            <div className="grid-stats-section">
              <div className="grid-stats-section-title">Buildings ({gridStats.buildingsTotal})</div>
              <div className="grid-stats-row"><span>Need 2×2 road</span><b>{gridStats.needs2Count}</b></div>
              <div className="grid-stats-row"><span>Need 1×1 road</span><b>{gridStats.needs1Count}</b></div>
              <div className="grid-stats-row"><span>No road needed</span><b>{gridStats.noRoadCount}</b></div>
              <div className="grid-stats-row"><span>Disconnected (no road served)</span>
                <b className={gridStats.disconnectedCount > 0 ? 'bad' : ''}>{gridStats.disconnectedCount}</b>
              </div>
              <div className="grid-stats-row"><span>Wasted road (no road needed)</span>
                <b className={gridStats.wastedRoadCount > 0 ? 'warn' : ''}>{gridStats.wastedRoadCount}</b>
              </div>
            </div>

            {gridStats.topTypes.length > 0 && (
              <div className="grid-stats-section">
                <div className="grid-stats-section-title">By type</div>
                {gridStats.topTypes.map(([type, count]) => (
                  <div key={type} className="grid-stats-row">
                    <span>
                      <i className="legend-color" style={{ background: getBuildingColor(type) }} />
                      {TYPE_LABELS[type] ?? type.replace(/_/g, ' ')}
                    </span>
                    <b>{count}</b>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
      <p className="grid-hint">Scroll to zoom, drag to pan</p>
    </div>
  );
}

function TooltipProduction({ entry }: { entry: import('../types/citydata').CityMapEntry }) {
  const prod = getBuildingProduction(entry);
  const items = Object.entries(prod.base).slice(0, 3);
  if (items.length === 0) return null;
  return (
    <div className="tooltip-production">
      {items.map(([k, v]) => (
        <div key={k}>{formatNumber(v)} {formatResourceName(k)}</div>
      ))}
    </div>
  );
}
