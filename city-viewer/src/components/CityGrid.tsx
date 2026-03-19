import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useCityData } from '../context/CityDataContext';
import { getGridBounds, getPlacedBuildings, getBuildingColor, getGenericEventCode, getStreetEra, type PlacedBuilding } from '../utils/gridUtils';
import { resolveBuildingName, formatResourceName, getBuildingProduction, formatNumber } from '../utils/dataProcessing';

const CELL_SIZE = 12;

const TYPE_LABELS: Record<string, string> = {
  main_building: 'Main Building',
  greatbuilding: 'Great Building',
  generic_building: 'Generic',
  street: 'Street',
  military: 'Military',
  tower: 'Tower',
};

const EVENT_LABELS: Record<string, string> = {
  PAT: "St. Patrick's",
  WIN: 'Winter',
  FALL: 'Fall',
  SUM: 'Summer',
  WILD: 'Wildlife',
  HERO: 'Hero',
  HAL: 'Halloween',
  GR: 'Guild Raid',
  ANNI: 'Anniversary',
  FELL: 'Fellowship',
  CARE: 'Valentine',
  CUP: 'Soccer Cup',
  GBG: 'Battlegrounds',
  HIS: 'Historical',
  BOWL: 'Super Bowl',
};

function formatStreetEra(era: string): string {
  return era.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export default function CityGrid() {
  const { data } = useCityData();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredBuilding, setHoveredBuilding] = useState<PlacedBuilding | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  // Filter state
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [hiddenEvents, setHiddenEvents] = useState<Set<string>>(new Set());
  const [hiddenStreetEras, setHiddenStreetEras] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState('');

  const bounds = useMemo(() => {
    if (!data?.UnlockedAreas) return null;
    return getGridBounds(data.UnlockedAreas);
  }, [data]);

  const allBuildings = useMemo(() => {
    if (!data) return [];
    return getPlacedBuildings(data);
  }, [data]);

  // Derive available subtypes from data
  const { eventCodes, streetEras } = useMemo(() => {
    const events = new Set<string>();
    const eras = new Set<string>();
    for (const b of allBuildings) {
      if (b.entry.type === 'generic_building') {
        events.add(getGenericEventCode(b.entry.cityentity_id));
      } else if (b.entry.type === 'street') {
        eras.add(getStreetEra(b.entry.cityentity_id));
      }
    }
    return {
      eventCodes: [...events].sort(),
      streetEras: [...eras].sort(),
    };
  }, [allBuildings]);

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

  // Filtered buildings
  const buildings = useMemo(() => {
    return allBuildings.filter(b => {
      if (hiddenTypes.has(b.entry.type)) return false;
      if (b.entry.type === 'generic_building' && hiddenEvents.has(getGenericEventCode(b.entry.cityentity_id))) return false;
      if (b.entry.type === 'street' && hiddenStreetEras.has(getStreetEra(b.entry.cityentity_id))) return false;
      return true;
    });
  }, [allBuildings, hiddenTypes, hiddenEvents, hiddenStreetEras]);

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

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      vx: viewBox?.x ?? 0,
      vy: viewBox?.y ?? 0,
    };
  }, [viewBox]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !viewBox || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (e.clientX - panStart.current.x) * (viewBox.w / rect.width);
    const dy = (e.clientY - panStart.current.y) * (viewBox.h / rect.height);
    setViewBox(prev => prev ? {
      ...prev,
      x: panStart.current.vx - dx,
      y: panStart.current.vy - dy,
    } : prev);
  }, [isPanning, viewBox]);

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

  const toggleEvent = (code: string) => {
    setHiddenEvents(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
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

  const toggleAllEvents = (show: boolean) => {
    setHiddenEvents(show ? new Set() : new Set(eventCodes));
  };

  const toggleAllStreetEras = (show: boolean) => {
    setHiddenStreetEras(show ? new Set() : new Set(streetEras));
  };

  if (!data || !bounds || !viewBox) return null;

  return (
    <div className="city-grid-container">
      <h2>City Grid Map</h2>

      {/* Search */}
      <div className="grid-search">
        <input
          type="text"
          placeholder="Search buildings by name..."
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

      {/* Type filters (legend doubles as toggles) */}
      <div className="grid-filters">
        <div className="grid-filter-section">
          <span className="grid-filter-label">Types</span>
          <div className="grid-filter-chips">
            {Object.entries(TYPE_LABELS).map(([type, label]) => (
              <button
                key={type}
                className={`grid-chip ${hiddenTypes.has(type) ? 'grid-chip-off' : ''}`}
                onClick={() => toggleType(type)}
              >
                <span className="legend-color" style={{ background: getBuildingColor(type) }} />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Generic building event filters */}
        {!hiddenTypes.has('generic_building') && eventCodes.length > 0 && (
          <div className="grid-filter-section">
            <span className="grid-filter-label">
              Generic Events
              <button className="grid-toggle-all" onClick={() => toggleAllEvents(hiddenEvents.size > 0)}>
                {hiddenEvents.size > 0 ? 'All' : 'None'}
              </button>
            </span>
            <div className="grid-filter-chips">
              {eventCodes.map(code => (
                <button
                  key={code}
                  className={`grid-chip grid-chip-sm ${hiddenEvents.has(code) ? 'grid-chip-off' : ''}`}
                  onClick={() => toggleEvent(code)}
                >
                  {EVENT_LABELS[code] ?? code}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Street era filters */}
        {!hiddenTypes.has('street') && streetEras.length > 0 && (
          <div className="grid-filter-section">
            <span className="grid-filter-label">
              Street Eras
              <button className="grid-toggle-all" onClick={() => toggleAllStreetEras(hiddenStreetEras.size > 0)}>
                {hiddenStreetEras.size > 0 ? 'All' : 'None'}
              </button>
            </span>
            <div className="grid-filter-chips">
              {streetEras.map(era => (
                <button
                  key={era}
                  className={`grid-chip grid-chip-sm ${hiddenStreetEras.has(era) ? 'grid-chip-off' : ''}`}
                  onClick={() => toggleStreetEra(era)}
                >
                  {formatStreetEra(era)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid-wrapper" style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          className="city-svg"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* SVG defs for highlight glow */}
          <defs>
            <filter id="search-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Unlocked areas background */}
          {data.UnlockedAreas.map((area, i) => (
            <rect
              key={`area-${i}`}
              x={area.x * CELL_SIZE}
              y={area.y * CELL_SIZE}
              width={area.width * CELL_SIZE}
              height={area.length * CELL_SIZE}
              fill="#1a1a2e"
              stroke="#2a2a4e"
              strokeWidth={0.5}
            />
          ))}

          {/* Buildings */}
          {buildings.map(b => {
            const isHovered = hoveredBuilding?.entry.id === b.entry.id;
            const isMatch = hasSearch && searchMatches.has(b.entry.id);
            const dimmed = hasSearch && !isMatch && !isHovered;

            return (
              <rect
                key={b.entry.id}
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
