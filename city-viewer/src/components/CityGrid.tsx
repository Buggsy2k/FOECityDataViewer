import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useCityData } from '../context/CityDataContext';
import { getGridBounds, getPlacedBuildings, getBuildingColor, getStreetEra, type PlacedBuilding } from '../utils/gridUtils';
import { resolveBuildingName, formatResourceName, getBuildingProduction, formatNumber, ERA_ORDER } from '../utils/dataProcessing';

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

  // Precompute set of grid cells occupied by streets for geometric road adjacency
  const streetCells = useMemo(() => {
    const cells = new Set<string>();
    for (const b of allBuildings) {
      if (b.entry.type !== 'street') continue;
      for (let dx = 0; dx < b.width; dx++) {
        for (let dy = 0; dy < b.length; dy++) {
          cells.add(`${b.x + dx},${b.y + dy}`);
        }
      }
    }
    return cells;
  }, [allBuildings]);

  // Precompute which buildings physically touch a street (share an edge)
  const touchesRoadSet = useMemo(() => {
    const result = new Set<number>();
    for (const b of allBuildings) {
      if (b.entry.type === 'street') continue;
      let found = false;
      // Check all edge cells around the building perimeter
      for (let dx = -1; dx <= b.width && !found; dx++) {
        for (let dy = -1; dy <= b.length && !found; dy++) {
          // Only check cells on the border (not interior and not corners-only)
          const onEdge = dx === -1 || dx === b.width || dy === -1 || dy === b.length;
          const isCorner = (dx === -1 || dx === b.width) && (dy === -1 || dy === b.length);
          if (!onEdge || isCorner) continue;
          if (streetCells.has(`${b.x + dx},${b.y + dy}`)) {
            found = true;
          }
        }
      }
      if (found) result.add(b.entry.id);
    }
    return result;
  }, [allBuildings, streetCells]);

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
        </div>
      </div>

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
            const needsRoad = !inherent.has(b.entry.type) && (
              (entity?.requirements?.street_connection_level ?? 0) > 0 ||
              Object.values(entity?.components ?? {}).some(
                (c: any) => (c?.streetConnectionRequirement?.requiredLevel ?? 0) > 0
              )
            );
            const touchesRoad = touchesRoadSet.has(b.entry.id);
            const disconnected = needsRoad && !touchesRoad;
            const wastedRoad = !needsRoad && touchesRoad && !inherent.has(b.entry.type);
            const showBorder = (needsRoad || wastedRoad) && !dimmed;
            const isRed = disconnected || wastedRoad;

            return (
              <g key={b.entry.id}>
                <rect
                  x={b.x * CELL_SIZE + 0.5}
                  y={b.y * CELL_SIZE + 0.5}
                  width={b.width * CELL_SIZE - 1}
                  height={b.length * CELL_SIZE - 1}
                  fill={isMatch ? '#ff0' : getBuildingColor(b.entry.type)}
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
                    strokeWidth={isRed ? 1.5 : 0.8}
                    rx={0.5}
                    pointerEvents="none"
                  />
                )}
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
