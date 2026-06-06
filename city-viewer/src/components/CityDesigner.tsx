import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useCityData } from '../context/CityDataContext';
import { getGridBounds, getPlacedBuildings, getBuildingColor, type PlacedBuilding } from '../utils/gridUtils';
import { ERA_RANK, extractEra, resolveBuildingName } from '../utils/dataProcessing';

const CELL_SIZE = 12;

type RoadNeed = 'none' | 'road1' | 'road2';
type ParkedSortMode = 'name' | 'era';

interface DesignerBuilding extends PlacedBuilding {
  sizeKey: string;
  roadNeed: RoadNeed;
}

interface LineCell {
  x: number;
  y: number;
  valid: boolean;
}

interface DragState {
  id: number;
  origin: { x: number; y: number } | null;
  originParked: boolean;
  pointer: { x: number; y: number };
  overPanel: boolean;
  candidate: { x: number; y: number } | null;
  valid: boolean;
  // Road line + continuous placement
  startGrid: { x: number; y: number } | null;
  cityentityId: string;
  isStreet: boolean;
  lineCells: LineCell[] | null;  // null = single-tile mode
  lineIds: number[];             // pool of same-type parked IDs for line
}

interface SavedLayout {
  name: string;
  savedAt: number;
  placements: Array<{ id: number; x: number; y: number; parked: boolean }>;
}

interface ParkedStack {
  key: string;
  id: number;
  name: string;
  era: string;
  sizeKey: string;
  roadNeed: RoadNeed;
  type: string;
  count: number;
}

interface LayoutSnapshot {
  positions: Map<number, { x: number; y: number }>;
  parkedIds: Set<number>;
}

const LAYOUT_STORAGE_KEY = 'foe-city-designer-layouts-v1';

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

const ROAD_NEED_LABELS: Record<RoadNeed, string> = {
  none: 'No Road',
  road1: '1x1 Road',
  road2: '2x2 Road',
};

const INHERENT_NO_ROAD_TYPES = new Set(['street', 'main_building', 'tower', 'hub_main', 'hub_part', 'decoration']);

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export default function CityDesigner() {
  const { data } = useCityData();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const historyRef = useRef<LayoutSnapshot[]>([]);
  const positionsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const parkedIdsRef = useRef<Set<number>>(new Set());

  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map());
  const [parkedIds, setParkedIds] = useState<Set<number>>(new Set());

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [hiddenSizes, setHiddenSizes] = useState<Set<string>>(new Set());
  const [hiddenRoadNeeds, setHiddenRoadNeeds] = useState<Set<RoadNeed>>(new Set());
  const [searchText, setSearchText] = useState('');
  const [parkedSortMode, setParkedSortMode] = useState<ParkedSortMode>('name');
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as SavedLayout[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const [sizeDropdownOpen, setSizeDropdownOpen] = useState(false);
  const [roadDropdownOpen, setRoadDropdownOpen] = useState(false);
  const typeDropdownRef = useRef<HTMLDivElement>(null);
  const sizeDropdownRef = useRef<HTMLDivElement>(null);
  const roadDropdownRef = useRef<HTMLDivElement>(null);

  const getRoadNeed = useCallback((b: PlacedBuilding): RoadNeed => {
    const entity = data?.CityEntities?.[b.entry.cityentity_id];
    const rootLevel = entity?.requirements?.street_connection_level ?? 0;
    let componentLevel = 0;
    for (const comp of Object.values(entity?.components ?? {})) {
      const level = (comp as { streetConnectionRequirement?: { requiredLevel?: number } })
        ?.streetConnectionRequirement?.requiredLevel ?? 0;
      if (level > componentLevel) componentLevel = level;
    }

    const requiredLevel = Math.max(rootLevel, componentLevel);
    if (requiredLevel >= 2) return 'road2';
    if (requiredLevel === 1) return 'road1';
    if (INHERENT_NO_ROAD_TYPES.has(b.entry.type)) return 'none';
    return 'none';
  }, [data]);

  const allBuildings = useMemo<DesignerBuilding[]>(() => {
    if (!data) return [];
    return getPlacedBuildings(data).map((b) => ({
      ...b,
      sizeKey: `${b.width}x${b.length}`,
      roadNeed: getRoadNeed(b),
    }));
  }, [data, getRoadNeed]);

  const buildingById = useMemo(() => {
    const map = new Map<number, DesignerBuilding>();
    for (const b of allBuildings) map.set(b.entry.id, b);
    return map;
  }, [allBuildings]);

  const bounds = useMemo(() => {
    if (!data?.UnlockedAreas) return null;
    return getGridBounds(data.UnlockedAreas, allBuildings);
  }, [data, allBuildings]);

  const unlockedCells = useMemo(() => {
    const cells = new Set<string>();
    if (!data) return cells;
    for (const area of data.UnlockedAreas) {
      for (let dx = 0; dx < area.width; dx++) {
        for (let dy = 0; dy < area.length; dy++) {
          cells.add(`${area.x + dx},${area.y + dy}`);
        }
      }
    }
    return cells;
  }, [data]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    parkedIdsRef.current = parkedIds;
  }, [parkedIds]);

  const applyLayoutSnapshot = useCallback((snapshot: LayoutSnapshot) => {
    setPositions(new Map(snapshot.positions));
    setParkedIds(new Set(snapshot.parkedIds));
  }, []);

  const recordHistory = useCallback(() => {
    historyRef.current.push({
      positions: new Map(positionsRef.current),
      parkedIds: new Set(parkedIdsRef.current),
    });

    if (historyRef.current.length > 100) {
      historyRef.current.shift();
    }
  }, []);

  useEffect(() => {
    const next = new Map<number, { x: number; y: number }>();
    for (const b of allBuildings) next.set(b.entry.id, { x: b.x, y: b.y });
    setPositions(next);
    setParkedIds(new Set());
    setViewBox(null);
    historyRef.current = [];
  }, [allBuildings]);

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

  const presentTypes = useMemo(() => {
    const types = new Set<string>();
    for (const b of allBuildings) types.add(b.entry.type);
    const ordered = Object.keys(TYPE_LABELS).filter(t => types.has(t));
    for (const t of types) {
      if (!ordered.includes(t)) ordered.push(t);
    }
    return ordered;
  }, [allBuildings]);

  const presentSizes = useMemo(() => {
    const sizes = new Set<string>();
    for (const b of allBuildings) sizes.add(b.sizeKey);
    return [...sizes].sort((a, b) => {
      const [aw, ah] = a.split('x').map(Number);
      const [bw, bh] = b.split('x').map(Number);
      return aw * ah - bw * bh || aw - bw;
    });
  }, [allBuildings]);

  const matchesFilters = useCallback((b: DesignerBuilding): boolean => {
    if (!data) return false;
    if (hiddenTypes.has(b.entry.type)) return false;
    if (hiddenSizes.has(b.sizeKey)) return false;
    if (hiddenRoadNeeds.has(b.roadNeed)) return false;
    if (!searchText.trim()) return true;
    return resolveBuildingName(b.entry.cityentity_id, data).toLowerCase().includes(searchText.toLowerCase());
  }, [hiddenTypes, hiddenSizes, hiddenRoadNeeds, searchText, data]);

  const mapBuildings = useMemo(() => {
    return allBuildings
      .filter(b => !parkedIds.has(b.entry.id))
      .map(b => {
        const pos = positions.get(b.entry.id) ?? { x: b.x, y: b.y };
        return { ...b, x: pos.x, y: pos.y };
      });
  }, [allBuildings, parkedIds, positions]);

  const canPlace = useCallback((id: number, x: number, y: number): boolean => {
    const current = buildingById.get(id);
    if (!current) return false;

    for (let dx = 0; dx < current.width; dx++) {
      for (let dy = 0; dy < current.length; dy++) {
        if (!unlockedCells.has(`${x + dx},${y + dy}`)) return false;
      }
    }

    for (const other of allBuildings) {
      if (other.entry.id === id) continue;
      if (parkedIds.has(other.entry.id)) continue;
      const p = positions.get(other.entry.id) ?? { x: other.x, y: other.y };
      const overlapX = x < p.x + other.width && x + current.width > p.x;
      const overlapY = y < p.y + other.length && y + current.length > p.y;
      if (overlapX && overlapY) return false;
    }

    return true;
  }, [buildingById, unlockedCells, allBuildings, parkedIds, positions]);

  // Keep a ref so the drag effect always calls the latest canPlace/screenToGrid
  // without needing to re-subscribe every time positions/parkedIds change.
  const canPlaceRef = useRef(canPlace);
  useEffect(() => { canPlaceRef.current = canPlace; }, [canPlace]);

  const allBuildingsRef = useRef(allBuildings);
  useEffect(() => { allBuildingsRef.current = allBuildings; }, [allBuildings]);

  const buildingByIdRef = useRef(buildingById);
  useEffect(() => { buildingByIdRef.current = buildingById; }, [buildingById]);

  const unlockedCellsRef = useRef(unlockedCells);
  useEffect(() => { unlockedCellsRef.current = unlockedCells; }, [unlockedCells]);

  const mousePositionRef = useRef({ x: 0, y: 0 });

  // Check if all cells of a building are within unlocked areas (called at drop time with fresh refs)
  const checkOutsideBounds = (buildingId: number, x: number, y: number): boolean => {
    const building = buildingByIdRef.current.get(buildingId);
    if (!building) return true;
    for (let dx = 0; dx < building.width; dx++) {
      for (let dy = 0; dy < building.length; dy++) {
        if (!unlockedCellsRef.current.has(`${x + dx},${y + dy}`)) return true;
      }
    }
    return false;
  };

  const screenToGrid = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!svgRef.current || !viewBox) return null;
    const rect = svgRef.current.getBoundingClientRect();
    if (!pointInRect(clientX, clientY, rect)) return null;

    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    return {
      x: Math.floor((viewBox.x + sx * viewBox.w) / CELL_SIZE),
      y: Math.floor((viewBox.y + sy * viewBox.h) / CELL_SIZE),
    };
  }, [viewBox]);

  const screenToGridRef = useRef(screenToGrid);
  useEffect(() => { screenToGridRef.current = screenToGrid; }, [screenToGrid]);

  useEffect(() => {
    if (!dragState) return;
    const dragId = dragState.id;

    const onMouseMove = (e: MouseEvent) => {
      mousePositionRef.current = { x: e.clientX, y: e.clientY };
      const overPanel = panelRef.current ? pointInRect(e.clientX, e.clientY, panelRef.current.getBoundingClientRect()) : false;
      let candidate = screenToGridRef.current(e.clientX, e.clientY);
      let valid = candidate ? canPlaceRef.current(dragId, candidate.x, candidate.y) : false;
      let lineCells: LineCell[] | null = null;

      // Road line mode: only when dragging from staging
      if (dragState.isStreet && dragState.originParked && dragState.startGrid && dragState.lineIds.length > 0) {
        const sg = dragState.startGrid;
        const building = buildingByIdRef.current.get(dragId);
        if (building) {
          const step = building.width; // 1 for 1×1, 2 for 2×2
          const cur = candidate ?? sg;
          const dx = cur.x - sg.x;
          const dy = cur.y - sg.y;
          const useH = Math.abs(dx) >= Math.abs(dy);
          const primary = useH ? dx : dy;
          const dir = primary >= 0 ? 1 : -1;
          const stepsAway = Math.floor(Math.abs(primary) / step);
          const count = Math.min(stepsAway + 1, dragState.lineIds.length);

          lineCells = [];
          for (let i = 0; i < count; i++) {
            const cx = useH ? sg.x + dir * i * step : sg.x;
            const cy = useH ? sg.y : sg.y + dir * i * step;
            lineCells.push({ x: cx, y: cy, valid: canPlaceRef.current(dragState.lineIds[i], cx, cy) });
          }

          candidate = { x: sg.x, y: sg.y };
          valid = lineCells.length > 0 && lineCells.some(c => c.valid);
        }
      }

      setDragState(prev => prev ? {
        ...prev,
        pointer: { x: e.clientX, y: e.clientY },
        overPanel,
        candidate,
        valid,
        lineCells,
      } : prev);
    };

    const onMouseUp = () => {
      // ── Road line drop ──────────────────────────────────────────────
      if (dragState.lineCells && dragState.lineCells.length > 0 && !dragState.overPanel) {
        const validCells = dragState.lineCells.filter(c => c.valid);
        if (validCells.length > 0) {
          recordHistory();
          setPositions(prev => {
            const next = new Map(prev);
            validCells.forEach((cell, i) => {
              next.set(dragState.lineIds[i], { x: cell.x, y: cell.y });
            });
            return next;
          });
          setParkedIds(prev => {
            const next = new Set(prev);
            validCells.forEach((_, i) => next.delete(dragState.lineIds[i]));
            return next;
          });

          // Are there more of the same road type still parked?
          const remaining = dragState.lineIds.slice(validCells.length);
          if (remaining.length > 0) {
            const mx = mousePositionRef.current.x;
            const my = mousePositionRef.current.y;
            const sg = screenToGridRef.current(mx, my);
            setDragState({
              id: remaining[0],
              origin: positionsRef.current.get(remaining[0]) ?? null,
              originParked: true,
              pointer: { x: mx, y: my },
              overPanel: false,
              candidate: sg,
              valid: sg ? canPlaceRef.current(remaining[0], sg.x, sg.y) : false,
              startGrid: sg,
              cityentityId: dragState.cityentityId,
              isStreet: true,
              lineCells: null,
              lineIds: remaining,
            });
          } else {
            setDragState(null);
          }
        } else {
          // Nothing valid — restore original
          if (dragState.origin) {
            setPositions(prev => {
              const next = new Map(prev);
              next.set(dragState.id, dragState.origin!);
              return next;
            });
          }
          setDragState(null);
        }
        setIsPanning(false);
        return;
      }

      // ── Single-tile drop ────────────────────────────────────────────
      const isOutside = dragState.candidate ? checkOutsideBounds(dragState.id, dragState.candidate.x, dragState.candidate.y) : true;
      const dropValid = dragState.candidate && dragState.valid && !isOutside;
      const dropOnPanel = dragState.overPanel;

      if (dropValid) {
        // ── Valid drop on map ──
        recordHistory();
        setPositions(prev => {
          const next = new Map(prev);
          next.set(dragState.id, dragState.candidate!);
          return next;
        });
        setParkedIds(prev => {
          const next = new Set(prev);
          next.delete(dragState.id);
          return next;
        });

        // ── Continuous placement: auto-start next of same type ─────────
        if (dragState.originParked && !dragState.isStreet) {
          const nextB = allBuildingsRef.current.find(
            b => b.entry.cityentity_id === dragState.cityentityId &&
                 b.entry.id !== dragState.id &&
                 parkedIdsRef.current.has(b.entry.id)
          );
          if (nextB) {
            const mx = mousePositionRef.current.x;
            const my = mousePositionRef.current.y;
            const sg = screenToGridRef.current(mx, my);
            setDragState({
              id: nextB.entry.id,
              origin: positionsRef.current.get(nextB.entry.id) ?? null,
              originParked: true,
              pointer: { x: mx, y: my },
              overPanel: false,
              candidate: sg,
              valid: sg ? canPlaceRef.current(nextB.entry.id, sg.x, sg.y) : false,
              startGrid: sg,
              cityentityId: nextB.entry.cityentity_id,
              isStreet: false,
              lineCells: null,
              lineIds: [],
            });
            setIsPanning(false);
            return;
          }
        }
      } else if (dropOnPanel) {
        // ── Drop on staging panel: always stage ──
        recordHistory();
        setPositions(prev => {
          const next = new Map(prev);
          if (dragState.origin) {
            next.set(dragState.id, dragState.origin);
          }
          return next;
        });
        setParkedIds(prev => {
          const next = new Set(prev);
          next.add(dragState.id);
          return next;
        });
      } else if (isOutside) {
        // ── Drop outside city boundaries: move to staging ──
        recordHistory();
        setPositions(prev => {
          const next = new Map(prev);
          if (dragState.origin) {
            next.set(dragState.id, dragState.origin);
          }
          return next;
        });
        setParkedIds(prev => {
          const next = new Set(prev);
          next.add(dragState.id);
          return next;
        });
      } else {
        // ── Invalid drop inside city: restore to origin ──
        recordHistory();
        setPositions(prev => {
          const next = new Map(prev);
          if (dragState.origin) {
            next.set(dragState.id, dragState.origin);
          }
          return next;
        });
        setParkedIds(prev => {
          const next = new Set(prev);
          if (dragState.originParked) next.add(dragState.id);
          else next.delete(dragState.id);
          return next;
        });
      }

      setDragState(null);
      setIsPanning(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState, recordHistory]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (typeDropdownRef.current && !typeDropdownRef.current.contains(e.target as Node)) setTypeDropdownOpen(false);
      if (sizeDropdownRef.current && !sizeDropdownRef.current.contains(e.target as Node)) setSizeDropdownOpen(false);
      if (roadDropdownRef.current && !roadDropdownRef.current.contains(e.target as Node)) setRoadDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayouts));
  }, [savedLayouts]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      if (isEditableTarget(e.target)) return;

      const previous = historyRef.current.pop();
      if (!previous) return;

      e.preventDefault();
      applyLayoutSnapshot(previous);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyLayoutSnapshot]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setViewBox(prev => {
      if (!prev || !svgRef.current) return prev;
      const rect = svgRef.current.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      const scale = e.deltaY > 0 ? 1.1 : 0.9;
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

  const handleWrapperWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    handleWheel(e.nativeEvent);
  }, [handleWheel]);

  const wrapperCallbackRef = useCallback((node: HTMLDivElement | null) => {
    (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, []);

  const startDrag = useCallback((e: React.MouseEvent, buildingId: number) => {
    e.preventDefault();
    e.stopPropagation();
    const source = buildingById.get(buildingId);
    if (!source) return;

    const isParked = parkedIds.has(buildingId);
    const isStreet = source.entry.type === 'street';
    const origin = positions.get(buildingId) ?? { x: source.x, y: source.y };
    const candidate = screenToGridRef.current(e.clientX, e.clientY);

    // Build the pool of same-type parked IDs for road line mode
    const lineIds: number[] = [];
    if (isStreet && isParked) {
      for (const b of allBuildings) {
        if (b.entry.cityentity_id === source.entry.cityentity_id && parkedIds.has(b.entry.id)) {
          lineIds.push(b.entry.id);
        }
      }
      lineIds.sort((a, b) => a - b);
      // Ensure dragged ID is first
      const idx = lineIds.indexOf(buildingId);
      if (idx > 0) { lineIds.splice(idx, 1); lineIds.unshift(buildingId); }
    }

    setDragState({
      id: buildingId,
      origin,
      originParked: isParked,
      pointer: { x: e.clientX, y: e.clientY },
      overPanel: false,
      candidate,
      valid: !!candidate && canPlaceRef.current(buildingId, candidate.x, candidate.y),
      startGrid: candidate,
      cityentityId: source.entry.cityentity_id,
      isStreet,
      lineCells: null,
      lineIds,
    });
  }, [buildingById, positions, parkedIds, allBuildings]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (dragState || e.button !== 0) return;
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
  }, [dragState]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !svgRef.current || dragState) return;
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
  }, [isPanning, dragState]);

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

  const toggleRoadNeed = (need: RoadNeed) => {
    setHiddenRoadNeeds(prev => {
      const next = new Set(prev);
      if (next.has(need)) next.delete(need); else next.add(need);
      return next;
    });
  };

  const parkBuilding = useCallback((buildingId: number) => {
    if (parkedIdsRef.current.has(buildingId)) return;
    recordHistory();
    setParkedIds(prev => {
      const next = new Set(prev);
      next.add(buildingId);
      return next;
    });
  }, [recordHistory]);

  const clearLayout = useCallback(() => {
    if (parkedIdsRef.current.size === allBuildings.length) return;
    recordHistory();
    setParkedIds(new Set(allBuildings.map(b => b.entry.id)));
  }, [allBuildings, recordHistory]);

  const placedCount = allBuildings.length - parkedIds.size;

  const captureCurrentLayout = useCallback((name: string): SavedLayout => {
    return {
      name,
      savedAt: Date.now(),
      placements: allBuildings.map(b => {
        const pos = positions.get(b.entry.id) ?? { x: b.x, y: b.y };
        return {
          id: b.entry.id,
          x: pos.x,
          y: pos.y,
          parked: parkedIds.has(b.entry.id),
        };
      }),
    };
  }, [allBuildings, positions, parkedIds]);

  const saveLayout = useCallback(() => {
    const input = window.prompt('Enter a name for this layout version:');
    const name = (input ?? '').trim();
    if (!name) return;

    const nextLayout = captureCurrentLayout(name);
    setSavedLayouts(prev => {
      const idx = prev.findIndex(l => l.name.toLowerCase() === name.toLowerCase());
      if (idx === -1) return [nextLayout, ...prev];
      if (!window.confirm(`A layout named "${name}" already exists. Overwrite it?`)) return prev;
      const next = [...prev];
      next[idx] = nextLayout;
      return next.sort((a, b) => b.savedAt - a.savedAt);
    });
  }, [captureCurrentLayout]);

  const loadLayout = useCallback((layoutName: string) => {
    const layout = savedLayouts.find(l => l.name === layoutName);
    if (!layout) return;

    const map = new Map<number, { x: number; y: number }>();
    const parked = new Set<number>();

    for (const b of allBuildings) {
      const match = layout.placements.find(p => p.id === b.entry.id);
      if (match) {
        map.set(b.entry.id, { x: match.x, y: match.y });
        if (match.parked) parked.add(b.entry.id);
      } else {
        map.set(b.entry.id, { x: b.x, y: b.y });
      }
    }

    recordHistory();
    setPositions(map);
    setParkedIds(parked);
  }, [savedLayouts, allBuildings, recordHistory]);

  const exportLayout = useCallback((layoutName: string) => {
    const layout = savedLayouts.find(l => l.name === layoutName);
    if (!layout) return;

    const payload = {
      exportedAt: new Date().toISOString(),
      layout,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const safe = layout.name.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `city-designer-${safe || 'layout'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }, [savedLayouts]);

  const deleteLayout = useCallback((layoutName: string) => {
    if (!window.confirm(`Delete layout "${layoutName}"?`)) return;
    setSavedLayouts(prev => prev.filter(l => l.name !== layoutName));
  }, []);

  const parkedStacks = useMemo<ParkedStack[]>(() => {
    if (!data) return [];

    const grouped = new Map<string, ParkedStack>();
    for (const building of allBuildings) {
      if (!parkedIds.has(building.entry.id)) continue;
      if (!matchesFilters(building)) continue;

      const name = resolveBuildingName(building.entry.cityentity_id, data);
      const era = extractEra(building.entry.cityentity_id, data, building.entry.level);
      const key = `${building.entry.cityentity_id}::${era}`;
      const existing = grouped.get(key);

      if (existing) {
        existing.count += 1;
        if (building.entry.id < existing.id) existing.id = building.entry.id;
        continue;
      }

      grouped.set(key, {
        key,
        id: building.entry.id,
        name,
        era,
        sizeKey: building.sizeKey,
        roadNeed: building.roadNeed,
        type: building.entry.type,
        count: 1,
      });
    }

    return [...grouped.values()].sort((a, b) => {
      if (parkedSortMode === 'era') {
        const eraDiff = (ERA_RANK[a.era] ?? 999) - (ERA_RANK[b.era] ?? 999);
        if (eraDiff !== 0) return eraDiff;
      }
      return a.name.localeCompare(b.name) || a.era.localeCompare(b.era);
    });
  }, [allBuildings, parkedIds, matchesFilters, data, parkedSortMode]);

  if (!data || !bounds || !viewBox) return null;

  return (
    <div className="city-designer-container">
      <div className="grid-header">
        <h2>City Designer</h2>
        <div className="grid-toolbar">
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
                    <input type="checkbox" checked={!hiddenTypes.has(type)} onChange={() => toggleType(type)} />
                    <span className="legend-color" style={{ background: getBuildingColor(type) }} />
                    {TYPE_LABELS[type] ?? type.replace(/_/g, ' ')}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid-dropdown" ref={sizeDropdownRef}>
            <button className="grid-dropdown-btn" onClick={() => setSizeDropdownOpen(v => !v)}>
              {hiddenSizes.size === 0 ? 'All Sizes' : `${presentSizes.length - hiddenSizes.size} of ${presentSizes.length} Sizes`}
              <span className="grid-dropdown-arrow">{sizeDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {sizeDropdownOpen && (
              <div className="grid-dropdown-menu">
                <label className="grid-dropdown-item grid-dropdown-all">
                  <input
                    type="checkbox"
                    checked={hiddenSizes.size === 0}
                    onChange={() => setHiddenSizes(hiddenSizes.size === 0 ? new Set(presentSizes) : new Set())}
                  />
                  All
                </label>
                {presentSizes.map(size => (
                  <label key={size} className="grid-dropdown-item">
                    <input type="checkbox" checked={!hiddenSizes.has(size)} onChange={() => toggleSize(size)} />
                    {size}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid-dropdown" ref={roadDropdownRef}>
            <button className="grid-dropdown-btn" onClick={() => setRoadDropdownOpen(v => !v)}>
              {hiddenRoadNeeds.size === 0 ? 'All Road Needs' : `${3 - hiddenRoadNeeds.size} of 3 Needs`}
              <span className="grid-dropdown-arrow">{roadDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {roadDropdownOpen && (
              <div className="grid-dropdown-menu">
                <label className="grid-dropdown-item grid-dropdown-all">
                  <input
                    type="checkbox"
                    checked={hiddenRoadNeeds.size === 0}
                    onChange={() => setHiddenRoadNeeds(hiddenRoadNeeds.size === 0 ? new Set(['none', 'road1', 'road2']) : new Set())}
                  />
                  All
                </label>
                {(['none', 'road1', 'road2'] as RoadNeed[]).map(need => (
                  <label key={need} className="grid-dropdown-item">
                    <input type="checkbox" checked={!hiddenRoadNeeds.has(need)} onChange={() => toggleRoadNeed(need)} />
                    {ROAD_NEED_LABELS[need]}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid-search">
            <input
              type="text"
              placeholder="Search buildings..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="grid-search-input"
            />
            <button
              className="grid-dropdown-btn"
              title="Move all buildings and roads into the staging area"
              onClick={clearLayout}
            >
              Clear Layout
            </button>
            <button
              className="grid-dropdown-btn"
              title="Reset layout to original positions"
              onClick={() => {
                recordHistory();
                const next = new Map<number, { x: number; y: number }>();
                for (const b of allBuildings) next.set(b.entry.id, { x: b.x, y: b.y });
                setPositions(next);
                setParkedIds(new Set());
              }}
            >
              Reset Layout
            </button>
          </div>
        </div>
      </div>

      <div className="city-designer-body">
        <aside className={`designer-panel ${dragState?.overPanel ? 'drop-ready' : ''}`} ref={panelRef}>
          <div className="designer-panel-header">
            <h3>Staging Area</h3>
            <button
              className={`designer-sort-btn ${parkedSortMode === 'era' ? 'active' : ''}`}
              onClick={() => setParkedSortMode(prev => prev === 'name' ? 'era' : 'name')}
              title={parkedSortMode === 'era' ? 'Currently sorting parked stacks by era' : 'Currently sorting parked stacks by name'}
            >
              Sort: {parkedSortMode === 'era' ? 'Era' : 'Name'}
            </button>
          </div>
          <p>Drag buildings here to get them out of the way, then drag them back onto the map.</p>
          <div className="designer-metrics">
            <div><strong>{parkedIds.size}</strong> parked</div>
            <div><strong>{placedCount}</strong> on map</div>
            <div><strong>{allBuildings.length}</strong> total</div>
          </div>
          <div className="designer-list">
            {parkedStacks.map(stack => {
              return (
                <button
                  key={stack.key}
                  className="designer-item parked"
                  onMouseDown={(e) => startDrag(e, stack.id)}
                  title="Drag onto map or staging area"
                >
                  <span className="designer-item-color" style={{ background: getBuildingColor(stack.type) }} />
                  <span className="designer-item-name">{stack.name}</span>
                  <span className="designer-item-count">x{stack.count}</span>
                  <span className="designer-item-meta">{stack.era} | {stack.sizeKey} | {ROAD_NEED_LABELS[stack.roadNeed]}</span>
                </button>
              );
            })}
            {parkedStacks.length === 0 && (
              <div className="designer-empty">No parked buildings match the selected filters.</div>
            )}
          </div>

          <div className="designer-versions">
            <div className="designer-versions-header">
              <h4>Saved Versions</h4>
              <button className="grid-dropdown-btn" onClick={saveLayout}>Save Version</button>
            </div>
            <div className="designer-versions-list">
              {savedLayouts.length === 0 && <div className="designer-empty">No saved versions yet.</div>}
              {savedLayouts.map(layout => (
                <div key={layout.name} className="designer-version-item">
                  <div className="designer-version-meta">
                    <strong>{layout.name}</strong>
                    <span>{new Date(layout.savedAt).toLocaleString()}</span>
                  </div>
                  <div className="designer-version-actions">
                    <button className="designer-mini-btn" onClick={() => loadLayout(layout.name)}>Load</button>
                    <button className="designer-mini-btn" onClick={() => exportLayout(layout.name)}>Export</button>
                    <button className="designer-mini-btn danger" onClick={() => deleteLayout(layout.name)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <div
          className="grid-wrapper"
          ref={wrapperCallbackRef}
          style={{ position: 'relative' }}
          onWheelCapture={handleWrapperWheel}
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
            <defs>
              <pattern id="designer-grid-1x1" width={CELL_SIZE} height={CELL_SIZE} patternUnits="userSpaceOnUse">
                <rect width={CELL_SIZE} height={CELL_SIZE} fill="none" stroke="#2a2a4e" strokeWidth={0.3} />
              </pattern>
            </defs>

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
                  fill="url(#designer-grid-1x1)"
                />
              </g>
            ))}

            {mapBuildings.filter(b => b.entry.id !== dragState?.id).map(b => (
              <g key={b.entry.id}>
                <rect
                  x={b.x * CELL_SIZE + 0.5}
                  y={b.y * CELL_SIZE + 0.5}
                  width={b.width * CELL_SIZE - 1}
                  height={b.length * CELL_SIZE - 1}
                  fill={getBuildingColor(b.entry.type)}
                  opacity={0.85}
                  stroke="rgba(0,0,0,0.35)"
                  strokeWidth={0.6}
                  rx={1}
                  onMouseDown={(e) => {
                    if (e.altKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      parkBuilding(b.entry.id);
                      return;
                    }
                    startDrag(e, b.entry.id);
                  }}
                  style={{ cursor: 'grab' }}
                />
                {b.entry.type !== 'street' && (
                  <foreignObject
                    x={b.x * CELL_SIZE + 0.5}
                    y={b.y * CELL_SIZE + 0.5}
                    width={b.width * CELL_SIZE - 1}
                    height={b.length * CELL_SIZE - 1}
                    pointerEvents="none"
                  >
                    <div
                      // @ts-expect-error xmlns is valid on HTML inside foreignObject
                      xmlns="http://www.w3.org/1999/xhtml"
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textAlign: 'center',
                        padding: '1px',
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                        fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
                        fontSize: '4px',
                        lineHeight: 1,
                        color: '#fff',
                        textShadow: '0 0 1px rgba(0,0,0,0.95), 0 0 1px rgba(0,0,0,0.95)',
                        fontWeight: 300,
                        wordBreak: 'break-word',
                      }}
                    >
                      {resolveBuildingName(b.entry.cityentity_id, data)}
                    </div>
                  </foreignObject>
                )}
              </g>
            ))}

            {dragState && buildingById.get(dragState.id) && (() => {
              const b = buildingById.get(dragState.id);
              if (!b) return null;

              // Road line preview
              if (dragState.lineCells && dragState.lineCells.length > 0) {
                return (
                  <g pointerEvents="none">
                    {dragState.lineCells.map((cell, i) => (
                      <rect
                        key={i}
                        x={cell.x * CELL_SIZE + 0.5}
                        y={cell.y * CELL_SIZE + 0.5}
                        width={b.width * CELL_SIZE - 1}
                        height={b.length * CELL_SIZE - 1}
                        fill={cell.valid ? 'rgba(88, 214, 141, 0.4)' : 'rgba(231, 76, 60, 0.35)'}
                        stroke={cell.valid ? 'rgba(88, 214, 141, 0.95)' : 'rgba(231, 76, 60, 0.95)'}
                        strokeWidth={1.4}
                        rx={1}
                      />
                    ))}
                  </g>
                );
              }

              // Single tile preview
              if (!dragState.candidate) return null;
              return (
                <rect
                  x={dragState.candidate.x * CELL_SIZE + 0.5}
                  y={dragState.candidate.y * CELL_SIZE + 0.5}
                  width={b.width * CELL_SIZE - 1}
                  height={b.length * CELL_SIZE - 1}
                  fill={dragState.valid ? 'rgba(88, 214, 141, 0.4)' : 'rgba(231, 76, 60, 0.35)'}
                  stroke={dragState.valid ? 'rgba(88, 214, 141, 0.95)' : 'rgba(231, 76, 60, 0.95)'}
                  strokeWidth={1.4}
                  rx={1}
                  pointerEvents="none"
                />
              );
            })()}
          </svg>
        </div>
      </div>

      <p className="grid-hint">Scroll to zoom · drag background to pan · drag to move · Alt+Click to stage · Ctrl+Z to undo · drag parked road to lay a line</p>
    </div>
  );
}
