import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useCityData } from '../context/CityDataContext';
import { getGridBounds, getPlacedBuildings, getBuildingColor, type PlacedBuilding } from '../utils/gridUtils';
import { ERA_RANK, extractEra, resolveBuildingName } from '../utils/dataProcessing';

const CELL_SIZE = 12;
const MIN_VIEW = 5 * CELL_SIZE;   // max zoom in  (~5 cells visible)
const MAX_VIEW = 400 * CELL_SIZE; // max zoom out (~400 cells visible)

type RoadNeed = 'none' | 'road1' | 'road2';
type ParkedSortMode = 'name' | 'era' | 'size';
type SortDirection = 'asc' | 'desc';

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
  gridAnchorOffset: { dx: number; dy: number };
  groupIds: number[];
  groupOffsets: Record<number, { dx: number; dy: number }>;
  startPointer?: { x: number; y: number };
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
  cityentityId: string;
  status: 'available' | 'deleted';
  dragId: number | null;
  ids: number[];
  name: string;
  era: string;
  sizeKey: string;
  roadNeed: RoadNeed;
  type: string;
  count: number;
  isPlaceholder: boolean;
  placeholderTemplateId?: number;
}

interface LayoutSnapshot {
  positions: Map<number, { x: number; y: number }>;
  parkedIds: Set<number>;
}

interface SelectionRegion {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

interface PlaceholderTemplate {
  id: number;
  name: string;
  width: number;
  length: number;
  roadNeed: RoadNeed;
}

interface PlaceholderInstance {
  id: number;
  templateId: number;
}

const LAYOUT_STORAGE_KEY = 'foe-city-designer-layouts-v1';
const PLACEHOLDER_STORAGE_KEY = 'foe-city-designer-placeholders-v1';

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
const PLACEHOLDER_BASE_COLOR = '#19c5e8';

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isFinitePoint(p: { x: number; y: number } | null | undefined): p is { x: number; y: number } {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function sizeArea(sizeKey: string): number {
  const [w, h] = sizeKey.split('x').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 0;
  return w * h;
}

function getPlaceholderDefaultName(width: number, length: number, roadNeed: RoadNeed): string {
  const roadLevel = roadNeed === 'road2' ? 2 : roadNeed === 'road1' ? 1 : 0;
  return `${length}x${width} r-${roadLevel}`;
}

export default function CityDesigner({ isFullscreen, onFullscreenChange }: { isFullscreen: boolean; onFullscreenChange: (fullscreen: boolean) => void }) {
  const { data } = useCityData();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const historyRef = useRef<LayoutSnapshot[]>([]);
  const positionsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const parkedIdsRef = useRef<Set<number>>(new Set());
  const markedForDeletionIdsRef = useRef<Set<number>>(new Set());

  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const isCtrlPanningRef = useRef(false);
  const suppressDropOnMouseUpRef = useRef(false);

  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map());
  const [parkedIds, setParkedIds] = useState<Set<number>>(new Set());
  const [markedForDeletionIds, setMarkedForDeletionIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectionRegion, setSelectionRegion] = useState<SelectionRegion | null>(null);
  const [validationInvalidIds, setValidationInvalidIds] = useState<Set<number>>(new Set());
  const [validationRan, setValidationRan] = useState(false);
  const validatedPositionsRef = useRef<Map<number, { x: number; y: number }> | null>(null);
  const validatedParkedIdsRef = useRef<Set<number> | null>(null);

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [hiddenSizes, setHiddenSizes] = useState<Set<string>>(new Set());
  const [hiddenRoadNeeds, setHiddenRoadNeeds] = useState<Set<RoadNeed>>(new Set());
  const [searchText, setSearchText] = useState('');
  const [mapSearchText, setMapSearchText] = useState('');
  const [mapHiddenSizes, setMapHiddenSizes] = useState<Set<string>>(new Set());
  const [showChangedHighlights, setShowChangedHighlights] = useState(false);
  const [parkedSortMode, setParkedSortMode] = useState<ParkedSortMode>('name');
  const [parkedSortDirection, setParkedSortDirection] = useState<SortDirection>('asc');
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
  const [placeholderTemplates, setPlaceholderTemplates] = useState<PlaceholderTemplate[]>(() => {
    try {
      const raw = localStorage.getItem(PLACEHOLDER_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as PlaceholderTemplate[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [placeholderName, setPlaceholderName] = useState('');
  const [placeholderWidth, setPlaceholderWidth] = useState(2);
  const [placeholderLength, setPlaceholderLength] = useState(2);
  const [placeholderRoadNeed, setPlaceholderRoadNeed] = useState<RoadNeed>('none');
  const [placeholderNameEdited, setPlaceholderNameEdited] = useState(false);
  const [placeholderInstances, setPlaceholderInstances] = useState<PlaceholderInstance[]>([]);

  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const [sizeDropdownOpen, setSizeDropdownOpen] = useState(false);
  const [roadDropdownOpen, setRoadDropdownOpen] = useState(false);
  const [mapSizeDropdownOpen, setMapSizeDropdownOpen] = useState(false);
  const [isStagingCollapsed, setIsStagingCollapsed] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const typeDropdownRef = useRef<HTMLDivElement>(null);
  const sizeDropdownRef = useRef<HTMLDivElement>(null);
  const roadDropdownRef = useRef<HTMLDivElement>(null);
  const mapSizeDropdownRef = useRef<HTMLDivElement>(null);
  const importLayoutInputRef = useRef<HTMLInputElement>(null);
  const stagingNoticeTimeoutRef = useRef<number | null>(null);
  const [stagingNotice, setStagingNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<'positive' | 'negative' | null>(null);

  const placeholderTemplateById = useMemo(() => {
    const map = new Map<number, PlaceholderTemplate>();
    for (const tpl of placeholderTemplates) map.set(tpl.id, tpl);
    return map;
  }, [placeholderTemplates]);

  const placeholderInstanceById = useMemo(() => {
    const map = new Map<number, PlaceholderInstance>();
    for (const instance of placeholderInstances) map.set(instance.id, instance);
    return map;
  }, [placeholderInstances]);

  const getPlaceholderForBuildingId = useCallback((buildingId: number): PlaceholderTemplate | null => {
    const instance = placeholderInstanceById.get(buildingId);
    if (instance) return placeholderTemplateById.get(instance.templateId) ?? null;
    // Backward compatibility for any old template-id based references.
    return placeholderTemplateById.get(buildingId) ?? null;
  }, [placeholderInstanceById, placeholderTemplateById]);

  const placeholderNamePreview = useMemo(() => (
    getPlaceholderDefaultName(placeholderWidth, placeholderLength, placeholderRoadNeed)
  ), [placeholderWidth, placeholderLength, placeholderRoadNeed]);

  useEffect(() => {
    if (!placeholderNameEdited) {
      setPlaceholderName(placeholderNamePreview);
    }
  }, [placeholderNameEdited, placeholderNamePreview]);

  const showStagingNotice = useCallback((message: string, type: 'positive' | 'negative' = 'positive') => {
    setStagingNotice(message);
    setNoticeType(type);
    if (stagingNoticeTimeoutRef.current !== null) {
      window.clearTimeout(stagingNoticeTimeoutRef.current);
    }
    stagingNoticeTimeoutRef.current = window.setTimeout(() => {
      setStagingNotice(null);
      setNoticeType(null);
      stagingNoticeTimeoutRef.current = null;
    }, 3200);
  }, []);

  useEffect(() => {
    const handleMouseDown = () => {
      if (stagingNotice) {
        setStagingNotice(null);
        setNoticeType(null);
        if (stagingNoticeTimeoutRef.current !== null) {
          window.clearTimeout(stagingNoticeTimeoutRef.current);
          stagingNoticeTimeoutRef.current = null;
        }
      }
    };

    if (stagingNotice) {
      document.addEventListener('mousedown', handleMouseDown);
      return () => document.removeEventListener('mousedown', handleMouseDown);
    }
  }, [stagingNotice]);

  useEffect(() => {
    return () => {
      if (stagingNoticeTimeoutRef.current !== null) {
        window.clearTimeout(stagingNoticeTimeoutRef.current);
      }
    };
  }, []);

  const getRoadNeed = useCallback((b: PlacedBuilding): RoadNeed => {
    if (INHERENT_NO_ROAD_TYPES.has(b.entry.type)) return 'none';

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
    return 'none';
  }, [data]);

  const getRequiredStreetLevelFor = useCallback((b: DesignerBuilding): number => {
    const placeholder = getPlaceholderForBuildingId(b.entry.id);
    if (placeholder) {
      if (placeholder.roadNeed === 'road2') return 2;
      if (placeholder.roadNeed === 'road1') return 1;
      return 0;
    }

    const entity = data?.CityEntities?.[b.entry.cityentity_id];
    const rootLevel = entity?.requirements?.street_connection_level ?? 0;
    let componentLevel = 0;
    for (const comp of Object.values(entity?.components ?? {})) {
      const level = (comp as { streetConnectionRequirement?: { requiredLevel?: number } })
        ?.streetConnectionRequirement?.requiredLevel ?? 0;
      if (level > componentLevel) componentLevel = level;
    }
    return Math.max(rootLevel, componentLevel);
  }, [data, getPlaceholderForBuildingId]);

  const getDesignerBuildingName = useCallback((b: DesignerBuilding): string => {
    const placeholder = getPlaceholderForBuildingId(b.entry.id);
    if (placeholder) return placeholder.name;
    if (!data) return b.entry.cityentity_id;
    return resolveBuildingName(b.entry.cityentity_id, data);
  }, [getPlaceholderForBuildingId, data]);

  const getDesignerBuildingEra = useCallback((b: DesignerBuilding): string => {
    if (getPlaceholderForBuildingId(b.entry.id)) return 'Custom';
    if (!data) return 'Unknown';
    return extractEra(b.entry.cityentity_id, data, b.entry.level);
  }, [getPlaceholderForBuildingId, data]);

  const baseBuildings = useMemo<DesignerBuilding[]>(() => {
    if (!data) return [];
    return getPlacedBuildings(data).map((b) => ({
      ...b,
      sizeKey: `${b.length}x${b.width}`,
      roadNeed: getRoadNeed(b),
    }));
  }, [data, getRoadNeed]);

  const customBuildings = useMemo<DesignerBuilding[]>(() => {
    const result: DesignerBuilding[] = [];
    for (const instance of placeholderInstances) {
      const tpl = placeholderTemplateById.get(instance.templateId);
      if (!tpl) continue;
      result.push({
        entry: {
          id: instance.id,
          player_id: 0,
          cityentity_id: `__placeholder__${tpl.id}`,
          type: 'generic_building',
          x: 0,
          y: 0,
          level: 0,
          bonuses: [],
          state: {},
        },
        x: 0,
        y: 0,
        width: tpl.width,
        length: tpl.length,
        sizeKey: `${tpl.length}x${tpl.width}`,
        roadNeed: tpl.roadNeed,
      });
    }
    return result;
  }, [placeholderInstances, placeholderTemplateById]);

  const allBuildings = useMemo<DesignerBuilding[]>(() => {
    return [...baseBuildings, ...customBuildings];
  }, [baseBuildings, customBuildings]);

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
    if (!data?.UnlockedAreas) return cells;
    for (const area of data.UnlockedAreas) {
      const ax = area.x ?? 0;
      const ay = area.y ?? 0;
      const aw = area.width ?? 0;
      const al = area.length ?? 0;
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(aw) || !Number.isFinite(al)) continue;
      if (aw <= 0 || al <= 0) continue;

      for (let dx = 0; dx < aw; dx++) {
        for (let dy = 0; dy < al; dy++) {
          cells.add(`${ax + dx},${ay + dy}`);
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

  useEffect(() => {
    markedForDeletionIdsRef.current = markedForDeletionIds;
  }, [markedForDeletionIds]);

  useEffect(() => {
    setMarkedForDeletionIds(prev => {
      const next = new Set<number>();
      prev.forEach(id => {
        if (parkedIds.has(id) && buildingById.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [parkedIds, buildingById]);

  const applyLayoutSnapshot = useCallback((snapshot: LayoutSnapshot) => {
    setPositions(() => {
      const next = new Map<number, { x: number; y: number }>();
      for (const [id, pos] of snapshot.positions) {
        if (isFinitePoint(pos)) next.set(id, pos);
      }
      return next;
    });
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
    const allIds = new Set(allBuildings.map(b => b.entry.id));
    setPositions(prev => {
      const next = new Map<number, { x: number; y: number }>();
      for (const b of allBuildings) {
        next.set(b.entry.id, prev.get(b.entry.id) ?? { x: b.x, y: b.y });
      }
      return next;
    });

    setParkedIds(prev => {
      const next = new Set<number>();
      for (const b of allBuildings) {
        const id = b.entry.id;
        if (prev.has(id)) {
          next.add(id);
        }
      }
      return next;
    });

    setSelectedIds(prev => {
      const next = new Set<number>();
      prev.forEach(id => {
        if (allIds.has(id)) next.add(id);
      });
      return next;
    });
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

  const fitToScreen = useCallback(() => {
    if (!bounds) return;

    const pad = 2;
    const mapX = (bounds.minX - pad) * CELL_SIZE;
    const mapY = (bounds.minY - pad) * CELL_SIZE;
    const mapW = (bounds.width + pad * 2) * CELL_SIZE;
    const mapH = (bounds.height + pad * 2) * CELL_SIZE;

    const wrapper = wrapperRef.current;
    const wrapperW = wrapper?.clientWidth ?? 0;
    const wrapperH = wrapper?.clientHeight ?? 0;
    if (wrapperW <= 0 || wrapperH <= 0 || mapW <= 0 || mapH <= 0) {
      setViewBox({ x: mapX, y: mapY, w: mapW, h: mapH });
      return;
    }

    const mapAspect = mapW / mapH;
    const wrapperAspect = wrapperW / wrapperH;

    let viewW = mapW;
    let viewH = mapH;
    if (wrapperAspect > mapAspect) {
      viewW = mapH * wrapperAspect;
    } else {
      viewH = mapW / wrapperAspect;
    }

    setViewBox({
      x: mapX - (viewW - mapW) / 2,
      y: mapY - (viewH - mapH) / 2,
      w: viewW,
      h: viewH,
    });
  }, [bounds]);

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
    return getDesignerBuildingName(b).toLowerCase().includes(searchText.toLowerCase());
  }, [hiddenTypes, hiddenSizes, hiddenRoadNeeds, searchText, data, getDesignerBuildingName]);

  const mapBuildings = useMemo(() => {
    return allBuildings
      .filter(b => !parkedIds.has(b.entry.id))
      .map(b => {
        const fallback = { x: b.x, y: b.y };
        const raw = positions.get(b.entry.id);
        const pos = isFinitePoint(raw) ? raw : fallback;
        return { ...b, x: pos.x, y: pos.y };
      })
      .filter(b => Number.isFinite(b.x) && Number.isFinite(b.y));
  }, [allBuildings, parkedIds, positions]);

  const mapPresentSizes = useMemo(() => {
    const sizes = new Set<string>();
    for (const b of mapBuildings) sizes.add(b.sizeKey);
    return [...sizes].sort((a, b) => {
      const [aw, ah] = a.split('x').map(Number);
      const [bw, bh] = b.split('x').map(Number);
      return aw * ah - bw * bh || aw - bw;
    });
  }, [mapBuildings]);

  const mapHiddenPresentCount = useMemo(
    () => mapPresentSizes.filter(size => mapHiddenSizes.has(size)).length,
    [mapPresentSizes, mapHiddenSizes],
  );

  const mapSizeFilterActive = mapPresentSizes.length > 0 && mapHiddenPresentCount > 0;

  const mapSearchQuery = mapSearchText.trim().toLowerCase();
  const mapSearchActive = mapSearchQuery.length > 0;

  const computeRoadConnectivity = useCallback((placed: DesignerBuilding[]) => {
    const streetByCellAny = new Map<string, number>();
    const streetByCell2x2 = new Map<string, number>();
    const streetNeighborsAny = new Map<number, Set<number>>();
    const streetNeighbors2x2 = new Map<number, Set<number>>();
    const street2x2Ids = new Set<number>();
    const connectedStreetIdsAny = new Set<number>();
    const connectedStreetIds2x2 = new Set<number>();
    const connectedBuildingIdsAny = new Set<number>();
    const connectedBuildingIds2x2 = new Set<number>();
    const mainBuilding = placed.find(b => b.entry.type === 'main_building') ?? null;

    const isTwoByTwoStreet = (building: DesignerBuilding): boolean => (
      building.entry.type === 'street' && building.width === 2 && building.length === 2
    );

    const getEdgeCells = (building: DesignerBuilding): string[] => {
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

    for (const building of placed) {
      if (building.entry.type !== 'street') continue;
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

    for (const building of placed) {
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

    for (const building of placed) {
      if (building.entry.type === 'street') continue;
      const requiredStreetLevel = getRequiredStreetLevelFor(building);
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

        if (requiredStreetLevel < 2 && connectedBuildingIdsAny.has(building.entry.id)) break;
        if (requiredStreetLevel >= 2 && connectedBuildingIds2x2.has(building.entry.id)) break;
      }
    }

    return {
      connectedStreetIdsAny,
      connectedBuildingIdsAny,
      connectedBuildingIds2x2,
    };
  }, [getRequiredStreetLevelFor]);

  const validateRoadRules = useCallback((
    targetIds: number[],
    overrides: Map<number, { x: number; y: number }>,
    forcedPlacedIds: Set<number>
  ): boolean => {
    const placed: DesignerBuilding[] = [];
    for (const b of allBuildings) {
      if (parkedIds.has(b.entry.id) && !forcedPlacedIds.has(b.entry.id)) continue;
      const p = overrides.get(b.entry.id) ?? positions.get(b.entry.id) ?? { x: b.x, y: b.y };
      placed.push({ ...b, x: p.x, y: p.y });
    }

    const placedById = new Map<number, DesignerBuilding>();
    for (const b of placed) placedById.set(b.entry.id, b);

    const connectivity = computeRoadConnectivity(placed);

    for (const id of targetIds) {
      const building = placedById.get(id);
      if (!building) return false;

      if (building.entry.type === 'street') {
        if (!connectivity.connectedStreetIdsAny.has(id)) return false;
        continue;
      }

      const requiredStreetLevel = getRequiredStreetLevelFor(building);
      const needsRoad = !INHERENT_NO_ROAD_TYPES.has(building.entry.type) && requiredStreetLevel > 0;

      if (needsRoad) {
        const isConnected = requiredStreetLevel >= 2
          ? connectivity.connectedBuildingIds2x2.has(id)
          : connectivity.connectedBuildingIdsAny.has(id);
        if (!isConnected) return false;
      } else if (!INHERENT_NO_ROAD_TYPES.has(building.entry.type)) {
        if (connectivity.connectedBuildingIdsAny.has(id)) return false;
      }
    }

    return true;
  }, [allBuildings, parkedIds, positions, computeRoadConnectivity, getRequiredStreetLevelFor]);

  const canPlaceGeometry = useCallback((id: number, x: number, y: number): boolean => {
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

  const canPlace = useCallback((id: number, x: number, y: number): boolean => {
    if (!canPlaceGeometry(id, x, y)) return false;

    const overrides = new Map<number, { x: number; y: number }>();
    overrides.set(id, { x, y });
    return validateRoadRules([id], overrides, new Set([id]));
  }, [canPlaceGeometry, validateRoadRules]);

  // Keep a ref so the drag effect always calls the latest canPlace/screenToGrid
  // without needing to re-subscribe every time positions/parkedIds change.
  const canPlaceGeometryRef = useRef(canPlaceGeometry);
  useEffect(() => { canPlaceGeometryRef.current = canPlaceGeometry; }, [canPlaceGeometry]);

  const canPlaceRef = useRef(canPlace);
  useEffect(() => { canPlaceRef.current = canPlace; }, [canPlace]);

  const validateRoadRulesRef = useRef(validateRoadRules);
  useEffect(() => { validateRoadRulesRef.current = validateRoadRules; }, [validateRoadRules]);

  const allBuildingsRef = useRef(allBuildings);
  useEffect(() => { allBuildingsRef.current = allBuildings; }, [allBuildings]);

  const buildingByIdRef = useRef(buildingById);
  useEffect(() => { buildingByIdRef.current = buildingById; }, [buildingById]);

  const unlockedCellsRef = useRef(unlockedCells);
  useEffect(() => { unlockedCellsRef.current = unlockedCells; }, [unlockedCells]);

  const mousePositionRef = useRef({ x: 0, y: 0 });

  const dragStateRef = useRef<DragState | null>(null);
  useEffect(() => { dragStateRef.current = dragState; }, [dragState]);

  // Swap chain: holds the map state from before the first swap so Escape can abort the entire chain.
  const swapChainSnapshotRef = useRef<{ positions: Map<number, { x: number; y: number }>; parkedIds: Set<number> } | null>(null);

  const playBonk = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
      osc.onended = () => ctx.close();
    } catch {
      // AudioContext unavailable — fail silently
    }
  }, []);

  // Returns the id of the single placed building that blocks a drop, or null if 0 or ≥2 blockers.
  // Also returns null if any target cell is outside the unlocked area.
  const findSingleBlockerForDrop = useCallback((drag: DragState, anchorX: number, anchorY: number): number | null => {
    const groupSet = new Set(drag.groupIds);
    const movedRects: Array<{ x: number; y: number; w: number; h: number }> = [];

    for (const id of drag.groupIds) {
      const b = buildingByIdRef.current.get(id);
      if (!b) return null;
      const off = drag.groupOffsets[id] ?? { dx: 0, dy: 0 };
      const x = anchorX + off.dx;
      const y = anchorY + off.dy;
      for (let dx = 0; dx < b.width; dx++) {
        for (let dy = 0; dy < b.length; dy++) {
          if (!unlockedCellsRef.current.has(`${x + dx},${y + dy}`)) return null;
        }
      }
      movedRects.push({ x, y, w: b.width, h: b.length });
    }

    let blocker: number | null = null;
    for (const other of allBuildingsRef.current) {
      if (groupSet.has(other.entry.id)) continue;
      if (parkedIdsRef.current.has(other.entry.id)) continue;
      const p = positionsRef.current.get(other.entry.id) ?? { x: other.x, y: other.y };
      for (const rect of movedRects) {
        const overlapX = rect.x < p.x + other.width && rect.x + rect.w > p.x;
        const overlapY = rect.y < p.y + other.length && rect.y + rect.h > p.y;
        if (overlapX && overlapY) {
          if (blocker !== null && blocker !== other.entry.id) return null; // ≥2 blockers
          blocker = other.entry.id;
          break;
        }
      }
    }
    return blocker;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const findSingleBlockerForDropRef = useRef(findSingleBlockerForDrop);
  useEffect(() => { findSingleBlockerForDropRef.current = findSingleBlockerForDrop; }, [findSingleBlockerForDrop]);

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

  const canPlaceGroupGeometry = useCallback((drag: DragState, anchorX: number, anchorY: number): boolean => {
    const groupSet = new Set(drag.groupIds);
    const moved: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];

    for (const id of drag.groupIds) {
      const b = buildingByIdRef.current.get(id);
      if (!b) return false;
      const off = drag.groupOffsets[id] ?? { dx: 0, dy: 0 };
      const x = anchorX + off.dx;
      const y = anchorY + off.dy;

      for (let dx = 0; dx < b.width; dx++) {
        for (let dy = 0; dy < b.length; dy++) {
          if (!unlockedCellsRef.current.has(`${x + dx},${y + dy}`)) return false;
        }
      }

      moved.push({ id, x, y, w: b.width, h: b.length });
    }

    for (const other of allBuildingsRef.current) {
      if (groupSet.has(other.entry.id)) continue;
      if (parkedIdsRef.current.has(other.entry.id)) continue;

      const p = positionsRef.current.get(other.entry.id) ?? { x: other.x, y: other.y };
      for (const m of moved) {
        const overlapX = m.x < p.x + other.width && m.x + m.w > p.x;
        const overlapY = m.y < p.y + other.length && m.y + m.h > p.y;
        if (overlapX && overlapY) return false;
      }
    }

    return true;
  }, []);

  const canPlaceGroup = useCallback((drag: DragState, anchorX: number, anchorY: number): boolean => {
    if (!canPlaceGroupGeometry(drag, anchorX, anchorY)) return false;

    const moved: Array<{ id: number; x: number; y: number }> = [];
    for (const id of drag.groupIds) {
      const off = drag.groupOffsets[id] ?? { dx: 0, dy: 0 };
      moved.push({ id, x: anchorX + off.dx, y: anchorY + off.dy });
    }

    const overrides = new Map<number, { x: number; y: number }>();
    for (const m of moved) {
      overrides.set(m.id, { x: m.x, y: m.y });
    }

    return validateRoadRulesRef.current(drag.groupIds, overrides, new Set(drag.groupIds));
  }, [canPlaceGroupGeometry]);

  const screenToGrid = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!svgRef.current) return null;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (!pointInRect(clientX, clientY, rect)) return null;

    // Convert from screen coordinates to SVG world coordinates, accounting for aspect-ratio fitting.
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const world = point.matrixTransform(ctm.inverse());

    const gx = Math.floor(world.x / CELL_SIZE);
    const gy = Math.floor(world.y / CELL_SIZE);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
    return { x: gx, y: gy };
  }, []);

  const screenToGridRef = useRef(screenToGrid);
  useEffect(() => { screenToGridRef.current = screenToGrid; }, [screenToGrid]);

  useEffect(() => {
    if (!dragState) return;
    const dragId = dragState.id;

    const onMouseMove = (e: MouseEvent) => {
      mousePositionRef.current = { x: e.clientX, y: e.clientY };
      const overPanel = panelRef.current ? pointInRect(e.clientX, e.clientY, panelRef.current.getBoundingClientRect()) : false;
      const rawCandidate = screenToGridRef.current(e.clientX, e.clientY);
      let candidate = rawCandidate ? { x: rawCandidate.x - dragState.gridAnchorOffset.dx, y: rawCandidate.y - dragState.gridAnchorOffset.dy } : null;
      let valid = candidate ? canPlaceRef.current(dragId, candidate.x, candidate.y) : false;
      let lineCells: LineCell[] | null = null;

      if (dragState.isStreet && dragState.originParked && candidate) {
        valid = canPlaceGeometryRef.current(dragId, candidate.x, candidate.y);
      }

      // Road line mode: only after a start cell is locked by click.
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
          const count = Math.min(stepsAway, dragState.lineIds.length);

          lineCells = [];
          const lineOverrides = new Map<number, { x: number; y: number }>();
          const forcedPlacedIds = new Set<number>();
          for (let i = 0; i < count; i++) {
            const offset = i + 1; // first line segment starts adjacent to start cell
            const cx = useH ? sg.x + dir * offset * step : sg.x;
            const cy = useH ? sg.y : sg.y + dir * offset * step;
            const lineId = dragState.lineIds[i];
            if (lineId == null) continue;
            lineOverrides.set(lineId, { x: cx, y: cy });
            forcedPlacedIds.add(lineId);
            const validLineSegment = canPlaceGeometryRef.current(lineId, cx, cy);
            lineCells.push({ x: cx, y: cy, valid: validLineSegment });
          }

          candidate = { x: sg.x, y: sg.y };
          valid = lineCells.length > 0 && lineCells.some(c => c.valid);
        }
      } else if (!dragState.originParked && candidate) {
        valid = canPlaceGroup(dragState, candidate.x, candidate.y);
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
      if (suppressDropOnMouseUpRef.current || isCtrlPanningRef.current) {
        suppressDropOnMouseUpRef.current = false;
        isCtrlPanningRef.current = false;
        setIsPanning(false);
        return;
      }

      // Treat tiny mouse movement as a click-cancel for map drags.
      if (!dragState.originParked && dragState.startPointer) {
        const dx = dragState.pointer.x - dragState.startPointer.x;
        const dy = dragState.pointer.y - dragState.startPointer.y;
        if (Math.hypot(dx, dy) <= 5) {
          setDragState(null);
          setIsPanning(false);
          return;
        }
      }

      // ── Street tool (staged roads): click-to-start, click-to-commit line ──
      if (dragState.isStreet && dragState.originParked) {
        if (dragState.overPanel) {
          setIsPanning(false);
          return;
        }

        // First click: place one road and lock start cell for line drawing.
        if (!dragState.startGrid) {
          if (dragState.candidate && dragState.valid) {
            const start = dragState.candidate;
            const remaining = dragState.lineIds.slice(1);

            recordHistory();
            setPositions(prev => {
              const next = new Map(prev);
              next.set(dragState.id, start);
              return next;
            });
            setParkedIds(prev => {
              const next = new Set(prev);
              next.delete(dragState.id);
              return next;
            });

            if (remaining.length > 0) {
              const mx = mousePositionRef.current.x;
              const my = mousePositionRef.current.y;
              const cg = screenToGridRef.current(mx, my);
              setDragState({
                id: remaining[0],
                origin: positionsRef.current.get(remaining[0]) ?? null,
                originParked: true,
                gridAnchorOffset: { dx: 0, dy: 0 },
                groupIds: [remaining[0]],
                groupOffsets: { [remaining[0]]: { dx: 0, dy: 0 } },
                pointer: { x: mx, y: my },
                overPanel: false,
                candidate: cg,
                valid: false,
                startGrid: start,
                cityentityId: dragState.cityentityId,
                isStreet: true,
                lineCells: null,
                lineIds: remaining,
              });
            } else {
              setDragState(null);
            }
          }
          setIsPanning(false);
          return;
        }

        // Second click: commit the previewed line (if any valid segments).
        const validCells = (dragState.lineCells ?? []).filter(c => c.valid);
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

          const remaining = dragState.lineIds.slice(validCells.length);
          if (remaining.length > 0) {
            const mx = mousePositionRef.current.x;
            const my = mousePositionRef.current.y;
            const cg = screenToGridRef.current(mx, my);
            setDragState({
              id: remaining[0],
              origin: positionsRef.current.get(remaining[0]) ?? null,
              originParked: true,
              gridAnchorOffset: { dx: 0, dy: 0 },
              groupIds: [remaining[0]],
              groupOffsets: { [remaining[0]]: { dx: 0, dy: 0 } },
              pointer: { x: mx, y: my },
              overPanel: false,
              candidate: cg,
              valid: !!cg && canPlaceGeometryRef.current(remaining[0], cg.x, cg.y),
              startGrid: null,
              cityentityId: dragState.cityentityId,
              isStreet: true,
              lineCells: null,
              lineIds: remaining,
            });
          } else {
            setDragState(null);
          }
        }
        setIsPanning(false);
        return;
      }

      // ── Single-tile drop ────────────────────────────────────────────
      const isOutside = dragState.candidate ? checkOutsideBounds(dragState.id, dragState.candidate.x, dragState.candidate.y) : true;
      const stagedGeometryValid = !!dragState.candidate && dragState.originParked
        ? canPlaceGeometryRef.current(dragState.id, dragState.candidate.x, dragState.candidate.y)
        : false;
      const mapMoveGeometryValid = !!dragState.candidate && !dragState.originParked
        ? canPlaceGroupGeometry(dragState, dragState.candidate.x, dragState.candidate.y)
        : false;
      const dropValid = !!dragState.candidate && (
        dragState.originParked
          ? (stagedGeometryValid && !isOutside)
          : mapMoveGeometryValid
      );
      const dropOnPanel = dragState.overPanel;

      // ── Swap check: if exactly one building blocks the drop target, swap them ──
      if (!dropValid && dragState.candidate && !dropOnPanel) {
        const anchor = dragState.candidate;
        const singleBlockerId = findSingleBlockerForDropRef.current(dragState, anchor.x, anchor.y);

        if (singleBlockerId !== null) {
          // On the first swap in a chain, record history once and save the pre-chain snapshot.
          // Subsequent swaps in the same chain do NOT push to history, so Ctrl+Z (and Escape)
          // both restore the entire chain atomically — preventing overlapping mid-chain states.
          if (!swapChainSnapshotRef.current) {
            recordHistory();
            swapChainSnapshotRef.current = {
              positions: new Map(positionsRef.current),
              parkedIds: new Set(parkedIdsRef.current),
            };
          }

          // Place the dragged building(s) at the target position.
          setPositions(prev => {
            const next = new Map(prev);
            for (const id of dragState.groupIds) {
              const off = dragState.groupOffsets[id] ?? { dx: 0, dy: 0 };
              next.set(id, { x: anchor.x + off.dx, y: anchor.y + off.dy });
            }
            return next;
          });
          if (dragState.originParked) {
            setParkedIds(prev => {
              const next = new Set(prev);
              for (const id of dragState.groupIds) next.delete(id);
              return next;
            });
          }

          // Begin dragging the displaced building so the user can place it elsewhere.
          const blockerB = buildingByIdRef.current.get(singleBlockerId);
          if (blockerB) {
            const blockerPos = positionsRef.current.get(singleBlockerId) ?? { x: blockerB.x, y: blockerB.y };
            const mx = mousePositionRef.current.x;
            const my = mousePositionRef.current.y;
            const cg = screenToGridRef.current(mx, my);
            setDragState({
              id: singleBlockerId,
              origin: blockerPos,
              originParked: false,
              gridAnchorOffset: { dx: 0, dy: 0 },
              groupIds: [singleBlockerId],
              groupOffsets: { [singleBlockerId]: { dx: 0, dy: 0 } },
              startPointer: { x: mx, y: my },
              pointer: { x: mx, y: my },
              overPanel: false,
              candidate: cg,
              valid: false, // recalculated on first mousemove
              startGrid: null,
              cityentityId: blockerB.entry.cityentity_id,
              isStreet: blockerB.entry.type === 'street',
              lineCells: null,
              lineIds: [],
            });
          } else {
            swapChainSnapshotRef.current = null;
            setDragState(null);
          }
          setIsPanning(false);
          return;
        }
      }

      // For staged placement mode, invalid clicks should keep the current drag active
      // so the user can keep searching for a valid spot. Exit with Esc.
      if (dragState.originParked && !dropValid) {
        setIsPanning(false);
        return;
      }

      if (dropValid) {
        // ── Valid drop on map ──
        // Don't push a new history entry if we're completing a swap chain — the chain
        // start already recorded one clean snapshot, and calling recordHistory() here
        // would capture both buildings at the same cell (an overlapping intermediate state).
        if (!swapChainSnapshotRef.current) recordHistory();
        setPositions(prev => {
          const next = new Map(prev);
          if (!dragState.originParked) {
            const anchor = dragState.candidate!;
            for (const id of dragState.groupIds) {
              const off = dragState.groupOffsets[id] ?? { dx: 0, dy: 0 };
              next.set(id, { x: anchor.x + off.dx, y: anchor.y + off.dy });
            }
          } else {
            next.set(dragState.id, dragState.candidate!);
          }
          return next;
        });
        setParkedIds(prev => {
          const next = new Set(prev);
          if (dragState.originParked) {
            next.delete(dragState.id);
          }
          return next;
        });

        swapChainSnapshotRef.current = null; // swap chain complete on successful drop

        // ── Continuous placement: auto-start next of same type ─────────
        if (dragState.originParked && !dragState.isStreet) {
          const nextB = allBuildingsRef.current.find(
            b => b.entry.cityentity_id === dragState.cityentityId &&
                 b.entry.id !== dragState.id &&
                 parkedIdsRef.current.has(b.entry.id) &&
                 !markedForDeletionIdsRef.current.has(b.entry.id)
          );
          if (nextB) {
            const mx = mousePositionRef.current.x;
            const my = mousePositionRef.current.y;
            const sg = screenToGridRef.current(mx, my);
            setDragState({
              id: nextB.entry.id,
              origin: positionsRef.current.get(nextB.entry.id) ?? null,
              originParked: true,
              gridAnchorOffset: { dx: 0, dy: 0 },
              groupIds: [nextB.entry.id],
              groupOffsets: { [nextB.entry.id]: { dx: 0, dy: 0 } },
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
        if (!swapChainSnapshotRef.current) recordHistory();
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
        swapChainSnapshotRef.current = null;
      } else if (isOutside) {
        // ── Drop outside city boundaries: move to staging ──
        if (!swapChainSnapshotRef.current) recordHistory();
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
        swapChainSnapshotRef.current = null;
      } else {
        // ── Invalid drop inside city ──
        if (swapChainSnapshotRef.current) {
          // Mid-chain invalid drop: bonk and keep the drag alive so the user can try elsewhere.
          playBonk();
          setIsPanning(false);
          return; // do NOT call setDragState(null)
        } else {
          // Normal invalid drop: restore to origin.
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
      if (mapSizeDropdownRef.current && !mapSizeDropdownRef.current.contains(e.target as Node)) setMapSizeDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayouts));
  }, [savedLayouts]);

  useEffect(() => {
    localStorage.setItem(PLACEHOLDER_STORAGE_KEY, JSON.stringify(placeholderTemplates));
  }, [placeholderTemplates]);

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

      // Cancel any active drag before applying undo — a building that is currently
      // "in hand" is not on the map, so restoring positions without first dropping it
      // would leave it able to land on an already-occupied cell after the undo.
      if (dragStateRef.current) {
        setDragState(null);
        setIsPanning(false);
      }
      // Clear a swap chain so Escape after an undo doesn't try to restore a stale snapshot.
      swapChainSnapshotRef.current = null;

      applyLayoutSnapshot(previous);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyLayoutSnapshot]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      // Abort an in-progress swap chain: restore the map to its pre-chain state.
      if (swapChainSnapshotRef.current) {
        e.preventDefault();
        applyLayoutSnapshot(swapChainSnapshotRef.current);
        swapChainSnapshotRef.current = null;
        setDragState(null);
        setIsPanning(false);
        return;
      }

      if (dragState?.originParked) {
        e.preventDefault();
        setDragState(null);
        setIsPanning(false);
        return;
      }

      if (selectedIds.size > 0 || selectionRegion) {
        e.preventDefault();
        setSelectedIds(new Set());
        setSelectionRegion(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dragState, selectedIds, selectionRegion]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (isEditableTarget(e.target)) return;
      if (selectedIds.size === 0 || dragState) return;

      e.preventDefault();
      recordHistory();
      setParkedIds(prev => {
        const next = new Set(prev);
        selectedIds.forEach(id => next.add(id));
        return next;
      });
      setSelectedIds(new Set());
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedIds, dragState, recordHistory]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    setViewBox(prev => {
      if (!prev || !svgRef.current) return prev;
      const rect = svgRef.current.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      const scale = e.deltaY > 0 ? 1.1 : 0.9;
      const newW = Math.min(Math.max(prev.w * scale, MIN_VIEW), MAX_VIEW);
      const actualScale = newW / prev.w;
      const newH = prev.h * actualScale;
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
    if (e.ctrlKey) return;
    
    const source = buildingById.get(buildingId);
    if (!source) return;
    
    const isParked = parkedIds.has(buildingId);
    if (isParked && markedForDeletionIds.has(buildingId)) return;
    
    // Allow switching between parked items, but not from placed to parked
    if (dragState && !(isParked && dragState.originParked)) return;
    
    e.preventDefault();
    e.stopPropagation();

    const isStreet = source.entry.type === 'street';
    const origin = positions.get(buildingId) ?? { x: source.x, y: source.y };
    const cursorGrid = screenToGridRef.current(e.clientX, e.clientY);
    const gridAnchorOffset = (!isParked && cursorGrid)
      ? { dx: cursorGrid.x - origin.x, dy: cursorGrid.y - origin.y }
      : { dx: 0, dy: 0 };
    const candidate = cursorGrid ? { x: cursorGrid.x - gridAnchorOffset.dx, y: cursorGrid.y - gridAnchorOffset.dy } : null;

    const groupIds = isParked
      ? [buildingId]
      : (selectedIds.has(buildingId)
        ? [...selectedIds].filter(id => !parkedIds.has(id))
        : [buildingId]);
    const uniqueGroupIds = Array.from(new Set(groupIds));
    const groupOffsets: Record<number, { dx: number; dy: number }> = {};
    for (const id of uniqueGroupIds) {
      const p = positions.get(id) ?? { x: buildingById.get(id)?.x ?? origin.x, y: buildingById.get(id)?.y ?? origin.y };
      groupOffsets[id] = { dx: p.x - origin.x, dy: p.y - origin.y };
    }

    if (!isParked && !selectedIds.has(buildingId)) {
      setSelectedIds(new Set([buildingId]));
    }

    // Build the pool of same-type parked IDs for road line mode
    const lineIds: number[] = [];
    if (isStreet && isParked) {
      for (const b of allBuildings) {
        if (
          b.entry.cityentity_id === source.entry.cityentity_id &&
          parkedIds.has(b.entry.id) &&
          !markedForDeletionIds.has(b.entry.id)
        ) {
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
      gridAnchorOffset,
      groupIds: uniqueGroupIds,
      groupOffsets,
      startPointer: { x: e.clientX, y: e.clientY },
      pointer: { x: e.clientX, y: e.clientY },
      overPanel: false,
      candidate,
      valid: !!candidate && (isParked
        ? (isStreet
          ? canPlaceGeometryRef.current(buildingId, candidate.x, candidate.y)
          : canPlaceRef.current(buildingId, candidate.x, candidate.y))
        : canPlaceGroup({
          id: buildingId,
          origin,
          originParked: isParked,
          gridAnchorOffset,
          groupIds: uniqueGroupIds,
          groupOffsets,
          pointer: { x: e.clientX, y: e.clientY },
          overPanel: false,
          candidate,
          valid: false,
          startGrid: null,
          cityentityId: source.entry.cityentity_id,
          isStreet,
          lineCells: null,
          lineIds: [],
        }, candidate.x, candidate.y)),
      startGrid: (isStreet && isParked) ? null : candidate,
      cityentityId: source.entry.cityentity_id,
      isStreet,
      lineCells: null,
      lineIds,
    });
  }, [buildingById, positions, parkedIds, markedForDeletionIds, allBuildings, dragState, selectedIds, canPlaceGroup]);

  const finishSelectionRegion = useCallback((region: SelectionRegion) => {
    const minX = Math.min(region.start.x, region.end.x);
    const minY = Math.min(region.start.y, region.end.y);
    const maxX = Math.max(region.start.x, region.end.x) + 1;
    const maxY = Math.max(region.start.y, region.end.y) + 1;

    const toAdd = new Set<number>();
    for (const b of allBuildings) {
      if (parkedIds.has(b.entry.id)) continue;
      const p = positions.get(b.entry.id) ?? { x: b.x, y: b.y };
      const overlapX = p.x < maxX && p.x + b.width > minX;
      const overlapY = p.y < maxY && p.y + b.length > minY;
      if (overlapX && overlapY) toAdd.add(b.entry.id);
    }

    if (toAdd.size === 0) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      toAdd.forEach(id => next.add(id));
      return next;
    });
  }, [allBuildings, parkedIds, positions]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 2) return;

    const isRightPan = e.button === 2;
    if (isRightPan) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!isRightPan && e.shiftKey && !dragState) {
      const start = screenToGridRef.current(e.clientX, e.clientY);
      if (!start) return;
      setSelectionRegion({ start, end: start });
      setIsPanning(false);
      return;
    }

    if (e.ctrlKey || isRightPan) {
      isCtrlPanningRef.current = true;
      suppressDropOnMouseUpRef.current = true;
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
      return;
    }

    if (dragState) return;
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
    if (selectionRegion) {
      const end = screenToGridRef.current(e.clientX, e.clientY);
      if (end) {
        setSelectionRegion(prev => prev ? { ...prev, end } : prev);
      }
      return;
    }

    if (!isPanning || !svgRef.current) return;
    if (dragState && !isCtrlPanningRef.current) return;
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
  }, [isPanning, dragState, selectionRegion]);

  const handleMouseUp = useCallback(() => {
    if (selectionRegion) {
      finishSelectionRegion(selectionRegion);
      setSelectionRegion(null);
      setIsPanning(false);
      return;
    }

    // Keep suppress flag until global drag mouseup runs, otherwise event ordering
    // can accidentally commit a drop after Ctrl-pan.
    if (!dragState) suppressDropOnMouseUpRef.current = false;
    isCtrlPanningRef.current = false;
    setIsPanning(false);
  }, [dragState, selectionRegion, finishSelectionRegion]);

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

  const toggleMapSize = (size: string) => {
    setMapHiddenSizes(prev => {
      const next = new Set(prev);
      if (next.has(size)) next.delete(size); else next.add(size);
      return next;
    });
  };

  const clearAllFilters = useCallback(() => {
    setHiddenTypes(new Set());
    setHiddenSizes(new Set());
    setHiddenRoadNeeds(new Set());
    setSearchText('');
    setTypeDropdownOpen(false);
    setSizeDropdownOpen(false);
    setRoadDropdownOpen(false);
  }, []);

  const hasActiveFilters =
    hiddenTypes.size > 0 ||
    hiddenSizes.size > 0 ||
    hiddenRoadNeeds.size > 0 ||
    searchText.trim().length > 0;

  const sortedPlaceholderTemplates = useMemo(() => {
    return [...placeholderTemplates].sort((a, b) => {
      const areaDiff = (a.width * a.length) - (b.width * b.length);
      if (areaDiff !== 0) return areaDiff;
      const firstNumberDiff = a.length - b.length;
      if (firstNumberDiff !== 0) return firstNumberDiff;
      const secondNumberDiff = a.width - b.width;
      if (secondNumberDiff !== 0) return secondNumberDiff;
      return a.name.localeCompare(b.name);
    });
  }, [placeholderTemplates]);

  const placeholderCountsByTemplate = useMemo(() => {
    const map = new Map<number, { total: number; parked: number }>();
    for (const instance of placeholderInstances) {
      const existing = map.get(instance.templateId) ?? { total: 0, parked: 0 };
      existing.total += 1;
      if (parkedIds.has(instance.id)) existing.parked += 1;
      map.set(instance.templateId, existing);
    }
    return map;
  }, [placeholderInstances, parkedIds]);

  const createPlaceholder = useCallback(() => {
    const name = placeholderName.trim();
    if (!name) return;

    const normalizedName = name.toLowerCase();
    const duplicate = placeholderTemplates.some(tpl => tpl.name.trim().toLowerCase() === normalizedName);
    if (duplicate) {
      window.alert('Placeholder name already exists. Please enter a new name to avoid duplicates.');
      return;
    }

    const width = Math.max(1, Math.floor(placeholderWidth));
    const length = Math.max(1, Math.floor(placeholderLength));
    const existingIds = new Set<number>([
      ...baseBuildings.map(b => b.entry.id),
      ...placeholderTemplates.map(t => t.id),
    ]);
    let nextId = Date.now();
    while (existingIds.has(nextId)) nextId += 1;
    const tpl: PlaceholderTemplate = {
      id: nextId,
      name,
      width,
      length,
      roadNeed: placeholderRoadNeed,
    };
    setPlaceholderTemplates(prev => [tpl, ...prev]);
    setPlaceholderNameEdited(false);
  }, [placeholderName, placeholderWidth, placeholderLength, placeholderRoadNeed, baseBuildings, placeholderTemplates]);

  const addPlaceholderToStaging = useCallback((templateId: number) => {
    const existingIds = new Set<number>([
      ...baseBuildings.map(b => b.entry.id),
      ...placeholderTemplates.map(t => t.id),
      ...placeholderInstances.map(instance => instance.id),
    ]);
    let nextInstanceId = Date.now();
    while (existingIds.has(nextInstanceId)) nextInstanceId += 1;

    setPlaceholderInstances(prev => [{ id: nextInstanceId, templateId }, ...prev]);
    setPositions(prev => {
      const next = new Map(prev);
      next.set(nextInstanceId, { x: 0, y: 0 });
      return next;
    });
    setParkedIds(prev => {
      const next = new Set(prev);
      next.add(nextInstanceId);
      return next;
    });
  }, [baseBuildings, placeholderTemplates, placeholderInstances]);

  const removePlaceholderFromCurrent = useCallback((templateId: number) => {
    const instances = placeholderInstances.filter(instance => instance.templateId === templateId);
    if (instances.length === 0) return;

    const parkedInstance = instances.find(instance => parkedIds.has(instance.id));
    const removeId = parkedInstance?.id ?? instances[0].id;

    setPlaceholderInstances(prev => prev.filter(instance => instance.id !== removeId));
    setPositions(prev => {
      const next = new Map(prev);
      next.delete(removeId);
      return next;
    });
    setParkedIds(prev => {
      const next = new Set(prev);
      next.delete(removeId);
      return next;
    });
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(removeId);
      return next;
    });
    setMarkedForDeletionIds(prev => {
      if (!prev.has(removeId)) return prev;
      const next = new Set(prev);
      next.delete(removeId);
      return next;
    });
    if (dragState?.id === removeId) setDragState(null);
  }, [placeholderInstances, parkedIds, dragState]);

  const deletePlaceholder = useCallback((templateId: number) => {
    const instances = placeholderInstances.filter(instance => instance.templateId === templateId);
    const removeIds = new Set(instances.map(instance => instance.id));
    const stagedCount = instances.filter(instance => parkedIds.has(instance.id)).length;
    const mapCount = instances.length - stagedCount;

    if (instances.length > 0) {
      const msg =
        `This placeholder is currently in use (${stagedCount} in staging, ${mapCount} on map).\n` +
        'Deleting it will remove all of those instances. Continue?';
      if (!window.confirm(msg)) return;
    }

    setPlaceholderTemplates(prev => prev.filter(p => p.id !== templateId));
    setPlaceholderInstances(prev => prev.filter(instance => instance.templateId !== templateId));
    setPositions(prev => {
      const next = new Map(prev);
      removeIds.forEach(id => next.delete(id));
      return next;
    });
    setParkedIds(prev => {
      const next = new Set(prev);
      removeIds.forEach(id => next.delete(id));
      return next;
    });
    setSelectedIds(prev => {
      const next = new Set(prev);
      removeIds.forEach(id => next.delete(id));
      return next;
    });
    setMarkedForDeletionIds(prev => {
      let changed = false;
      const next = new Set(prev);
      removeIds.forEach(id => {
        if (next.delete(id)) changed = true;
      });
      return changed ? next : prev;
    });
    if (dragState && removeIds.has(dragState.id)) setDragState(null);
  }, [placeholderInstances, parkedIds, dragState]);

  const parkBuilding = useCallback((buildingId: number) => {
    if (parkedIdsRef.current.has(buildingId)) return;
    recordHistory();
    setParkedIds(prev => {
      const next = new Set(prev);
      next.add(buildingId);
      return next;
    });
  }, [recordHistory]);

  const adjustMarkedForDeletionCount = useCallback((stack: ParkedStack, direction: 'mark' | 'unmark') => {
    const candidates = direction === 'mark'
      ? (stack.status === 'available' ? stack.ids : [])
      : (stack.status === 'deleted' ? stack.ids : []);
    if (candidates.length === 0) return;

    const targetId = direction === 'mark'
      ? Math.min(...candidates)
      : Math.max(...candidates);

    setMarkedForDeletionIds(prev => {
      const next = new Set(prev);
      if (direction === 'mark') {
        next.add(targetId);
      } else {
        next.delete(targetId);
      }
      return next;
    });
  }, []);

  const clearLayout = useCallback(() => {
    if (parkedIdsRef.current.size === allBuildings.length) return;
    recordHistory();
    setParkedIds(new Set(allBuildings.map(b => b.entry.id)));
  }, [allBuildings, recordHistory]);

  const runLayoutValidation = useCallback(() => {
    const connectivity = computeRoadConnectivity(mapBuildings);
    const invalid = new Set<number>();

    for (const b of mapBuildings) {
      const id = b.entry.id;
      if (b.entry.type === 'street') {
        if (!connectivity.connectedStreetIdsAny.has(id)) {
          invalid.add(id);
        }
        continue;
      }

      const requiredStreetLevel = getRequiredStreetLevelFor(b);
      const needsRoad = !INHERENT_NO_ROAD_TYPES.has(b.entry.type) && requiredStreetLevel > 0;
      if (needsRoad) {
        const ok = requiredStreetLevel >= 2
          ? connectivity.connectedBuildingIds2x2.has(id)
          : connectivity.connectedBuildingIdsAny.has(id);
        if (!ok) invalid.add(id);
      } else if (!INHERENT_NO_ROAD_TYPES.has(b.entry.type)) {
        if (connectivity.connectedBuildingIdsAny.has(id)) {
          invalid.add(id);
        }
      }
    }

    setValidationInvalidIds(invalid);
    setValidationRan(true);
    validatedPositionsRef.current = positions;
    validatedParkedIdsRef.current = parkedIds;
  }, [computeRoadConnectivity, mapBuildings, getRequiredStreetLevelFor, positions, parkedIds]);

  useEffect(() => {
    if (!validationRan) return;
    if (positions === validatedPositionsRef.current && parkedIds === validatedParkedIdsRef.current) return;
    setValidationRan(false);
    setValidationInvalidIds(new Set());
  }, [positions, parkedIds, validationRan]);

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

  const updateLayout = useCallback((layoutName: string) => {
    const existing = savedLayouts.find(l => l.name === layoutName);
    if (!existing) return;

    const nextLayout = captureCurrentLayout(layoutName);
    setSavedLayouts(prev => prev.map(l => (l.name === layoutName ? nextLayout : l)));
    showStagingNotice(`Version "${layoutName}" updated successfully`);
  }, [savedLayouts, captureCurrentLayout, showStagingNotice]);

  const loadLayout = useCallback((layoutName: string) => {
    const layout = savedLayouts.find(l => l.name === layoutName);
    if (!layout) return;

    const map = new Map<number, { x: number; y: number }>();
    const parked = new Set<number>();

    for (const b of allBuildings) {
      const match = layout.placements.find(p => p.id === b.entry.id);
      if (match) {
        if (Number.isFinite(match.x) && Number.isFinite(match.y)) {
          map.set(b.entry.id, { x: match.x, y: match.y });
        } else {
          map.set(b.entry.id, { x: b.x, y: b.y });
        }
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

  const exportMapImageJpg = useCallback(async () => {
    if (!svgRef.current || !data?.UnlockedAreas) return;

    const fullBounds = getGridBounds(data.UnlockedAreas, mapBuildings);
    const padCells = 2;
    const exportView = {
      x: (fullBounds.minX - padCells) * CELL_SIZE,
      y: (fullBounds.minY - padCells) * CELL_SIZE,
      w: (fullBounds.width + padCells * 2) * CELL_SIZE,
      h: (fullBounds.height + padCells * 2) * CELL_SIZE,
    };

    const exportWidth = Math.max(1, Math.round(exportView.w));
    const exportHeight = Math.max(1, Math.round(exportView.h));

    let renderScale = 4;
    const maxSide = Math.max(exportWidth, exportHeight);
    if (maxSide * renderScale > 10000) {
      renderScale = 10000 / maxSide;
    }
    renderScale = Math.max(1.5, renderScale);

    const makeSerializedSvg = (stripForeignObject: boolean): string => {
      const svgClone = svgRef.current!.cloneNode(true) as SVGSVGElement;
      svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svgClone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      svgClone.setAttribute('viewBox', `${exportView.x} ${exportView.y} ${exportView.w} ${exportView.h}`);
      svgClone.setAttribute('width', `${exportWidth}`);
      svgClone.setAttribute('height', `${exportHeight}`);

      if (stripForeignObject) {
        svgClone.querySelectorAll('foreignObject').forEach(node => node.remove());
      }

      return new XMLSerializer().serializeToString(svgClone);
    };

    const renderSerializedSvgToJpg = async (serializedSvg: string): Promise<Blob> => {
      const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serializedSvg)}`;
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load exported SVG image.'));
        img.src = svgDataUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(exportWidth * renderScale));
      canvas.height = Math.max(1, Math.round(exportHeight * renderScale));

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Unable to create image export context.');
      }

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.92);
      });

      if (!blob) {
        throw new Error('Failed to generate JPG data.');
      }

      return blob;
    };

    try {
      let jpgBlob: Blob;
      try {
        jpgBlob = await renderSerializedSvgToJpg(makeSerializedSvg(false));
      } catch {
        // Some browsers cannot rasterize SVG foreignObject content reliably.
        jpgBlob = await renderSerializedSvgToJpg(makeSerializedSvg(true));
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(jpgBlob);
      a.download = `city-designer-map-${timestamp}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch {
      window.alert('Failed to export the current map image as JPG.');
    }
  }, [data, mapBuildings]);

  const importLayoutsFromFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        const candidates = Array.isArray(raw)
          ? raw
          : [raw?.layout ?? raw];

        const parsed: SavedLayout[] = [];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object') continue;
          const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
          const placementsRaw = Array.isArray((candidate as { placements?: unknown[] }).placements)
            ? (candidate as { placements: unknown[] }).placements
            : null;
          if (!name || !placementsRaw) continue;

          const placements: SavedLayout['placements'] = [];
          for (const p of placementsRaw) {
            if (!p || typeof p !== 'object') continue;
            const rec = p as { id?: unknown; x?: unknown; y?: unknown; parked?: unknown };
            if (typeof rec.id !== 'number' || !Number.isFinite(rec.id)) continue;
            if (typeof rec.x !== 'number' || !Number.isFinite(rec.x)) continue;
            if (typeof rec.y !== 'number' || !Number.isFinite(rec.y)) continue;
            placements.push({
              id: rec.id,
              x: rec.x,
              y: rec.y,
              parked: !!rec.parked,
            });
          }

          if (placements.length === 0) continue;
          parsed.push({
            name,
            savedAt: typeof candidate.savedAt === 'number' && Number.isFinite(candidate.savedAt)
              ? candidate.savedAt
              : Date.now(),
            placements,
          });
        }

        if (parsed.length === 0) {
          window.alert('No valid saved layouts were found in this file.');
          return;
        }

        setSavedLayouts(prev => {
          const next = [...prev];
          for (const incoming of parsed) {
            const idx = next.findIndex(l => l.name.toLowerCase() === incoming.name.toLowerCase());
            if (idx === -1) {
              next.unshift(incoming);
              continue;
            }

            const overwrite = window.confirm(`A layout named "${incoming.name}" already exists. Overwrite it?`);
            if (overwrite) next[idx] = incoming;
          }
          return next.sort((a, b) => b.savedAt - a.savedAt);
        });
      } catch {
        window.alert('Could not import layout file. Please choose a valid City Designer export JSON.');
      }
    };
    reader.readAsText(file);
  }, []);

  const deleteLayout = useCallback((layoutName: string) => {
    if (!window.confirm(`Delete layout "${layoutName}"?`)) return;
    setSavedLayouts(prev => prev.filter(l => l.name !== layoutName));
  }, []);

  const parkedStacks = useMemo<ParkedStack[]>(() => {
    if (!data) return [];

    const grouped = new Map<string, {
      cityentityId: string;
      name: string;
      era: string;
      sizeKey: string;
      roadNeed: RoadNeed;
      type: string;
      isPlaceholder: boolean;
      placeholderTemplateId?: number;
      availableIds: number[];
      deletedIds: number[];
    }>();
    for (const building of allBuildings) {
      if (!parkedIds.has(building.entry.id)) continue;
      if (!matchesFilters(building)) continue;

      const name = getDesignerBuildingName(building);
      const era = getDesignerBuildingEra(building);
      const placeholderTemplate = getPlaceholderForBuildingId(building.entry.id);
      const key = `${building.entry.cityentity_id}::${era}`;
      const existing = grouped.get(key);
      const isMarked = markedForDeletionIds.has(building.entry.id);

      if (existing) {
        if (isMarked) {
          existing.deletedIds.push(building.entry.id);
        } else {
          existing.availableIds.push(building.entry.id);
        }
        continue;
      }

      grouped.set(key, {
        cityentityId: building.entry.cityentity_id,
        name,
        era,
        sizeKey: building.sizeKey,
        roadNeed: building.roadNeed,
        type: building.entry.type,
        availableIds: isMarked ? [] : [building.entry.id],
        deletedIds: isMarked ? [building.entry.id] : [],
        isPlaceholder: !!placeholderTemplate,
        placeholderTemplateId: placeholderTemplate?.id,
      });
    }

    const rows: ParkedStack[] = [];
    grouped.forEach((group, baseKey) => {
      if (group.availableIds.length > 0) {
        const availableIds = [...group.availableIds].sort((a, b) => a - b);
        rows.push({
          key: `${baseKey}::available`,
          cityentityId: group.cityentityId,
          status: 'available',
          dragId: availableIds[0] ?? null,
          ids: availableIds,
          name: group.name,
          era: group.era,
          sizeKey: group.sizeKey,
          roadNeed: group.roadNeed,
          type: group.type,
          count: availableIds.length,
          isPlaceholder: group.isPlaceholder,
          placeholderTemplateId: group.placeholderTemplateId,
        });
      }

      if (group.deletedIds.length > 0) {
        const deletedIds = [...group.deletedIds].sort((a, b) => a - b);
        rows.push({
          key: `${baseKey}::deleted`,
          cityentityId: group.cityentityId,
          status: 'deleted',
          dragId: null,
          ids: deletedIds,
          name: group.name,
          era: group.era,
          sizeKey: group.sizeKey,
          roadNeed: group.roadNeed,
          type: group.type,
          count: deletedIds.length,
          isPlaceholder: group.isPlaceholder,
          placeholderTemplateId: group.placeholderTemplateId,
        });
      }
    });

    return rows.sort((a, b) => {
      // Keep marked-for-deletion items at the bottom regardless of sort mode
      if (a.status === 'deleted' && b.status !== 'deleted') return 1;
      if (a.status !== 'deleted' && b.status === 'deleted') return -1;

      const direction = parkedSortDirection === 'asc' ? 1 : -1;

      if (parkedSortMode === 'era') {
        const eraDiff = (ERA_RANK[a.era] ?? 999) - (ERA_RANK[b.era] ?? 999);
        if (eraDiff !== 0) return eraDiff * direction;
      } else if (parkedSortMode === 'size') {
        const areaDiff = sizeArea(a.sizeKey) - sizeArea(b.sizeKey);
        if (areaDiff !== 0) return areaDiff * direction;
      }
      return (a.name.localeCompare(b.name) || a.era.localeCompare(b.era)) * direction;
    });
  }, [allBuildings, parkedIds, matchesFilters, data, parkedSortMode, parkedSortDirection, getDesignerBuildingName, getDesignerBuildingEra, getPlaceholderForBuildingId, markedForDeletionIds]);

  const movedOnMapIds = useMemo(() => {
    const ids = new Set<number>();
    for (const b of allBuildings) {
      if (parkedIds.has(b.entry.id)) continue;
      const current = positions.get(b.entry.id) ?? { x: b.x, y: b.y };
      if (current.x !== b.x || current.y !== b.y) ids.add(b.entry.id);
    }
    return ids;
  }, [allBuildings, parkedIds, positions]);

  const mapCursor = isPanning
    ? 'grabbing'
    : (dragState ? 'all-scroll' : 'default');

  const isLabelLikelyClipped = useCallback((name: string, width: number, length: number): boolean => {
    const cells = width * length;
    // Rough per-cell character capacity for the tiny in-tile label.
    const capacity = Math.max(6, cells * 4);
    return name.length > capacity;
  }, []);

  if (!data || !bounds || !viewBox) return null;

  return (
    <div className="city-designer-container">
      <div className="grid-header">
        <div className="designer-header-title">
          <h2>City Designer</h2>
          <button
            className="designer-title-help-btn"
            title="Show help for City Designer"
            onClick={() => setShowHelpModal(true)}
            aria-label="Show help"
          >
            ?
          </button>
        </div>
        <div className="grid-toolbar designer-actions">
          <button
            className="grid-dropdown-btn designer-icon-btn"
            title="Clear Layout: move all buildings and roads into Staging Area"
            onClick={clearLayout}
            aria-label="Clear Layout"
          >
            🧹
          </button>
          <button
            className="grid-dropdown-btn designer-icon-btn"
            title="Reset Layout: return all items to original city positions"
            onClick={() => {
              recordHistory();
              const next = new Map<number, { x: number; y: number }>();
              for (const b of allBuildings) next.set(b.entry.id, { x: b.x, y: b.y });
              setPositions(next);
              setParkedIds(new Set());
            }}
            aria-label="Reset Layout"
          >
            ↺
          </button>
          <button
            className="grid-dropdown-btn designer-icon-btn"
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
            onClick={() => onFullscreenChange(!isFullscreen)}
            aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            ⛶
          </button>
          <button
            className="grid-dropdown-btn designer-icon-btn"
            title="Validate Layout: check roads, connectivity, and road requirements"
            onClick={runLayoutValidation}
            aria-label="Validate Layout"
          >
            ✓
          </button>
          <button
            className={`grid-dropdown-btn designer-icon-btn ${showChangedHighlights ? 'active' : ''}`}
            title={showChangedHighlights ? 'Hide changed location highlights' : 'Identify moved buildings on the map'}
            onClick={() => setShowChangedHighlights(v => !v)}
            aria-label={showChangedHighlights ? 'Hide Changes' : 'Identify Changes'}
          >
            📍
          </button>
          <button
            className="grid-dropdown-btn designer-icon-btn"
            title="Fit map to available space"
            onClick={fitToScreen}
            aria-label="Fit map to available space"
          >
            ⤢
          </button>
          <button
            className="grid-dropdown-btn designer-icon-btn"
            title="Export full map as high-resolution JPG"
            onClick={() => {
              void exportMapImageJpg();
            }}
            aria-label="Export full map as JPG"
          >
            🖼
          </button>
          <div className="grid-search designer-map-search">
            <input
              type="text"
              placeholder="Search map buildings..."
              value={mapSearchText}
              onChange={e => setMapSearchText(e.target.value)}
              className="grid-search-input"
            />
            {mapSearchText.trim().length > 0 && (
              <button
                type="button"
                className="grid-search-clear"
                title="Clear map search"
                aria-label="Clear map search"
                onClick={() => setMapSearchText('')}
              >
                ×
              </button>
            )}
          </div>
          <div className="grid-dropdown" ref={mapSizeDropdownRef}>
            <button className="grid-dropdown-btn" onClick={() => setMapSizeDropdownOpen(v => !v)}>
              {(() => {
                if (mapPresentSizes.length === 0 || mapHiddenPresentCount === 0) return 'All Sizes';
                return `${mapPresentSizes.length - mapHiddenPresentCount} of ${mapPresentSizes.length} Sizes`;
              })()}
              <span className="grid-dropdown-arrow">{mapSizeDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {mapSizeDropdownOpen && (
              <div className="grid-dropdown-menu">
                <label className="grid-dropdown-item grid-dropdown-all">
                  <input
                    type="checkbox"
                    checked={mapHiddenPresentCount === 0}
                    onChange={() => {
                      setMapHiddenSizes(mapHiddenPresentCount === 0 ? new Set(mapPresentSizes) : new Set());
                    }}
                  />
                  All
                </label>
                {mapPresentSizes.map(size => (
                  <label key={`map-size-${size}`} className="grid-dropdown-item">
                    <input type="checkbox" checked={!mapHiddenSizes.has(size)} onChange={() => toggleMapSize(size)} />
                    {size}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="designer-summary-group">
            <div className="designer-summary-item">
              <span className="designer-summary-label">Total:</span>
              <span className="designer-summary-value">{allBuildings.length}</span>
            </div>
            <div className="designer-summary-item">
              <span className="designer-summary-label">On Map:</span>
              <span className="designer-summary-value">{allBuildings.length - parkedIds.size}</span>
            </div>
            <div className="designer-summary-item">
              <span className="designer-summary-label">Parked:</span>
              <span className="designer-summary-value">{parkedIds.size - markedForDeletionIds.size}</span>
            </div>
            <div className="designer-summary-item marked-for-deletion">
              <span className="designer-summary-label">Marked:</span>
              <span className="designer-summary-value">{markedForDeletionIds.size}</span>
            </div>
            {validationRan && (
              <div className={`designer-summary-item validation-status ${validationInvalidIds.size > 0 ? 'invalid' : 'valid'}`}>
                <span className="designer-summary-label">{validationInvalidIds.size > 0 ? 'Invalid:' : 'Valid:'}</span>
                <span className="designer-summary-value">{validationInvalidIds.size > 0 ? validationInvalidIds.size : '✓'}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`city-designer-body ${isStagingCollapsed ? 'staging-collapsed' : ''}`}>
        <aside className={`designer-panel ${dragState?.overPanel ? 'drop-ready' : ''} ${isStagingCollapsed ? 'collapsed' : ''}`} ref={panelRef}>
          <div className="designer-panel-header">
            {!isStagingCollapsed && <h3>Staging Area</h3>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="designer-sort-btn"
                onClick={() => setIsStagingCollapsed(prev => !prev)}
                title={isStagingCollapsed ? 'Expand Staging Area' : 'Collapse Staging Area'}
                aria-label={isStagingCollapsed ? 'Expand Staging Area' : 'Collapse Staging Area'}
              >
                {isStagingCollapsed ? '»' : '«'}
              </button>
              {!isStagingCollapsed && (
                <>
              <button
                className={`designer-sort-btn ${parkedSortMode !== 'name' ? 'active' : ''}`}
                onClick={() => setParkedSortMode(prev => prev === 'name' ? 'era' : prev === 'era' ? 'size' : 'name')}
                title={
                  parkedSortMode === 'name'
                    ? 'Currently sorting parked stacks by name'
                    : parkedSortMode === 'era'
                      ? 'Currently sorting parked stacks by era'
                      : 'Currently sorting parked stacks by total size area'
                }
              >
                Sort: {parkedSortMode === 'name' ? 'Name' : parkedSortMode === 'era' ? 'Era' : 'Size'}
              </button>
              <button
                className={`designer-sort-btn ${parkedSortDirection === 'desc' ? 'active' : ''}`}
                onClick={() => setParkedSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}
                title={parkedSortDirection === 'asc' ? 'Ascending order' : 'Descending order'}
              >
                Order: {parkedSortDirection === 'asc' ? 'Asc' : 'Desc'}
              </button>
                </>
              )}
            </div>
          </div>
          {!isStagingCollapsed && <div className="designer-panel-content">
          <div className="designer-staging-filters">
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
                placeholder="Search staged"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="grid-search-input"
              />
              {searchText.trim().length > 0 && (
                <button
                  type="button"
                  className="grid-search-clear"
                  title="Clear search text"
                  aria-label="Clear search text"
                  onClick={() => setSearchText('')}
                >
                  ×
                </button>
              )}
            </div>
            <button
              className="grid-dropdown-btn"
              title="Clear all staging filters and search text"
              onClick={clearAllFilters}
              disabled={!hasActiveFilters}
            >
              Clear Filters
            </button>
          </div>
          <div className="designer-list">
            {parkedStacks.map(stack => {
              return (
                <button
                  key={stack.key}
                  className={`designer-item parked${(dragState?.id != null && stack.ids.includes(dragState.id)) || (stack.status === 'available' && dragState?.originParked && dragState?.cityentityId === stack.cityentityId) ? ' active-drag' : ''}${stack.status === 'deleted' ? ' marked-for-deletion no-available' : ''}`}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('.designer-item-icon-btn')) {
                      setSelectedIds(new Set());
                      setDragState(null);
                      return;
                    }
                    if (dragState?.originParked && dragState.id != null && stack.ids.includes(dragState.id)) {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragState(null);
                      setIsPanning(false);
                      return;
                    }
                    if (stack.dragId == null) {
                      e.preventDefault();
                      e.stopPropagation();
                      showStagingNotice('This item is marked for deletion and cannot be selected or moved. Restore it first to use it.', 'negative');
                      return;
                    }
                    startDrag(e, stack.dragId);
                  }}
                  title={stack.status === 'available'
                    ? 'Click to pick up and place, click again to unselect, or click another item to switch'
                    : 'This copy is marked for deletion and cannot be dragged'}
                >
                  <span
                    className="designer-item-color"
                    style={stack.isPlaceholder
                      ? {
                        backgroundColor: PLACEHOLDER_BASE_COLOR,
                        backgroundImage: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.7) 0 3px, rgba(255,255,255,0.25) 3px 6px)',
                      }
                      : { background: getBuildingColor(stack.type) }}
                  />
                  <span className="designer-item-name">{stack.name}</span>
                  <span className="designer-item-actions">
                    <span className={`designer-item-count${stack.status === 'deleted' ? ' deleted' : ''}`}>
                      {stack.status === 'available' ? 'A' : 'D'} {stack.count}
                    </span>
                    {stack.status === 'available' && (
                      <span
                        className="designer-item-icon-btn delete-toggle"
                        role="button"
                        tabIndex={0}
                        title="Mark one staged copy for deletion"
                        aria-label="Mark one staged copy for deletion"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedIds(new Set());
                          setDragState(null);
                          adjustMarkedForDeletionCount(stack, 'mark');
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedIds(new Set());
                          setDragState(null);
                          adjustMarkedForDeletionCount(stack, 'mark');
                        }}
                      >
                        -
                      </span>
                    )}
                    {stack.status === 'deleted' && (
                      <span
                        className="designer-item-icon-btn restore-toggle"
                        role="button"
                        tabIndex={0}
                        title="Unmark one copy so it can be placed again"
                        aria-label="Unmark one copy so it can be placed again"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedIds(new Set());
                          setDragState(null);
                          adjustMarkedForDeletionCount(stack, 'unmark');
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedIds(new Set());
                          setDragState(null);
                          adjustMarkedForDeletionCount(stack, 'unmark');
                        }}
                      >
                        +
                      </span>
                    )}
                    {stack.isPlaceholder && stack.placeholderTemplateId != null && (
                      <span
                        className="designer-item-icon-btn"
                        role="button"
                        tabIndex={0}
                        title="Remove one from staging"
                        aria-label="Remove one from staging"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          removePlaceholderFromCurrent(stack.placeholderTemplateId!);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          e.stopPropagation();
                          removePlaceholderFromCurrent(stack.placeholderTemplateId!);
                        }}
                      >
                        −
                      </span>
                    )}
                  </span>
                  <span className="designer-item-meta">{stack.era} | {stack.sizeKey} | {ROAD_NEED_LABELS[stack.roadNeed]}</span>
                </button>
              );
            })}
            {parkedStacks.length === 0 && (
              <div className="designer-empty">
                No parked or no buildings match the selected filters.
                <br />
                Drag buildings here to get them out of the way, then drag them back onto the map.
              </div>
            )}
          </div>

          <div className="designer-versions designer-section">
            <div className="designer-versions-header">
              <h4>Saved Versions</h4>
              <div className="designer-version-actions">
                <button className="grid-dropdown-btn" onClick={saveLayout} title="Save the current version of the map">Save</button>
                <button className="grid-dropdown-btn" onClick={() => importLayoutInputRef.current?.click()}>Import</button>
                <input
                  ref={importLayoutInputRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) importLayoutsFromFile(file);
                    e.target.value = '';
                  }}
                />
              </div>
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
                    <button className="designer-mini-btn" onClick={() => updateLayout(layout.name)}>Update</button>
                    <button className="designer-mini-btn" onClick={() => loadLayout(layout.name)}>Load</button>
                    <button className="designer-mini-btn" onClick={() => exportLayout(layout.name)}>Export</button>
                    <button className="designer-mini-btn danger" onClick={() => deleteLayout(layout.name)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="designer-placeholder-box designer-section">
            <div className="designer-placeholder-title">Custom Placeholders</div>
            <div className="designer-placeholder-form">
              <input
                type="text"
                value={placeholderName}
                placeholder="Placeholder name"
                className="designer-placeholder-name"
                onChange={e => {
                  setPlaceholderName(e.target.value);
                  setPlaceholderNameEdited(true);
                }}
                title={`Auto-name default: ${placeholderNamePreview}`}
              />
              <div className="designer-placeholder-size">
                <input
                  type="number"
                  min={1}
                  value={placeholderLength}
                  className="designer-small-input"
                  onChange={e => setPlaceholderLength(Math.max(1, Number(e.target.value) || 1))}
                  title="Height"
                />
                <span className="designer-x-sep">x</span>
                <input
                  type="number"
                  min={1}
                  value={placeholderWidth}
                  className="designer-small-input"
                  onChange={e => setPlaceholderWidth(Math.max(1, Number(e.target.value) || 1))}
                  title="Width"
                />
              </div>
              <select
                className="designer-road-select"
                value={placeholderRoadNeed}
                onChange={e => setPlaceholderRoadNeed(e.target.value as RoadNeed)}
                title="Road Need"
              >
                <option value="none">No Road</option>
                <option value="road1">1x1 Road</option>
                <option value="road2">2x2 Road</option>
              </select>
              <button className="grid-dropdown-btn" onClick={createPlaceholder} disabled={!placeholderName.trim()}>
                Add Placeholder
              </button>
            </div>
            {placeholderTemplates.length > 0 && (
              <div className="designer-placeholder-list">
                {sortedPlaceholderTemplates.map(tpl => (
                  <div key={tpl.id} className="designer-placeholder-row">
                    <span title={`${tpl.name} (${tpl.length}x${tpl.width}, ${ROAD_NEED_LABELS[tpl.roadNeed]}) [${placeholderCountsByTemplate.get(tpl.id)?.parked ?? 0} staged / ${placeholderCountsByTemplate.get(tpl.id)?.total ?? 0} total]`}>
                      {tpl.name} ({tpl.length}x{tpl.width}, {ROAD_NEED_LABELS[tpl.roadNeed]})
                      {' '}
                      [{placeholderCountsByTemplate.get(tpl.id)?.parked ?? 0} staged / {placeholderCountsByTemplate.get(tpl.id)?.total ?? 0} total]
                    </span>
                    <div className="designer-placeholder-actions">
                      <button
                        className="designer-mini-icon-btn danger"
                        onClick={() => deletePlaceholder(tpl.id)}
                        title="Delete placeholder template"
                        aria-label="Delete placeholder template"
                      >
                        ×
                      </button>
                      <button
                        className="designer-mini-icon-btn"
                        onClick={() => addPlaceholderToStaging(tpl.id)}
                        title="Add one to staging"
                        aria-label="Add one to staging"
                      >
                        +
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {placeholderTemplates.length === 0 && (
              <div className="designer-empty">No custom placeholders yet.</div>
            )}
          </div>
          </div>}
        </aside>

        <div
          className="grid-wrapper"
          ref={wrapperCallbackRef}
          style={{ position: 'relative', cursor: mapCursor }}
          onWheelCapture={handleWrapperWheel}
          onMouseDown={handleMouseDown}
          onContextMenu={(e) => e.preventDefault()}
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
              <pattern id="designer-placeholder-pattern" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="8" height="8" fill={PLACEHOLDER_BASE_COLOR} />
                <rect width="3" height="8" fill="rgba(0,0,0,0.7)" />
              </pattern>
            </defs>

            {data.UnlockedAreas.map((area, i) => {
              const ax = area.x ?? 0;
              const ay = area.y ?? 0;
              const aw = area.width ?? 0;
              const al = area.length ?? 0;
              if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(aw) || !Number.isFinite(al)) return null;
              if (aw <= 0 || al <= 0) return null;

              return (
                <g key={`area-${i}`}>
                  <rect
                    x={ax * CELL_SIZE}
                    y={ay * CELL_SIZE}
                    width={aw * CELL_SIZE}
                    height={al * CELL_SIZE}
                    fill="#1a1a2e"
                  />
                  <rect
                    x={ax * CELL_SIZE}
                    y={ay * CELL_SIZE}
                    width={aw * CELL_SIZE}
                    height={al * CELL_SIZE}
                    fill="url(#designer-grid-1x1)"
                  />
                </g>
              );
            })}

            {mapBuildings.filter(b => !dragState?.groupIds.includes(b.entry.id)).map(b => {
              const fullName = getDesignerBuildingName(b);
              const matchesMapSearch = !mapSearchQuery || fullName.toLowerCase().includes(mapSearchQuery);
              const matchesMapSize = !mapSizeFilterActive || !mapHiddenSizes.has(b.sizeKey);
              const mapFilterActive = mapSearchActive || mapSizeFilterActive;
              const matchesMapFilters = matchesMapSearch && matchesMapSize;
              const showNameTooltip = b.entry.type !== 'street' && isLabelLikelyClipped(fullName, b.width, b.length);
              return (
              <g key={b.entry.id}>
                {showNameTooltip && <title>{fullName}</title>}
                {(() => {
                  const isSelected = selectedIds.has(b.entry.id);
                  const isInvalid = validationInvalidIds.has(b.entry.id);
                  const isPlaceholder = !!getPlaceholderForBuildingId(b.entry.id);
                  const isChangedLocation = showChangedHighlights && movedOnMapIds.has(b.entry.id);
                  const strokeColor = isInvalid
                    ? 'rgba(231, 76, 60, 0.98)'
                    : isChangedLocation
                      ? 'rgba(255, 159, 28, 0.98)'
                      : isSelected
                        ? 'rgba(241, 196, 15, 0.95)'
                      : (mapFilterActive && matchesMapFilters)
                        ? 'rgba(0, 234, 255, 0.98)'
                        : 'rgba(0,0,0,0.35)';
                  const strokeW = isInvalid ? 2 : (isChangedLocation ? 1.9 : (isSelected ? 1.6 : 0.6));
                  const baseOpacity = isPlaceholder ? 0.96 : 0.85;
                  const fillOpacity = mapFilterActive
                    ? (matchesMapFilters ? 1 : 0.22)
                    : baseOpacity;
                  return (
                <rect
                  x={b.x * CELL_SIZE + 0.5}
                  y={b.y * CELL_SIZE + 0.5}
                  width={b.width * CELL_SIZE - 1}
                  height={b.length * CELL_SIZE - 1}
                  fill={isPlaceholder ? 'url(#designer-placeholder-pattern)' : getBuildingColor(b.entry.type)}
                  opacity={fillOpacity}
                  stroke={strokeColor}
                  strokeWidth={strokeW}
                  rx={1}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    if (e.shiftKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedIds(prev => {
                        const next = new Set(prev);
                        next.add(b.entry.id);
                        return next;
                      });
                      return;
                    }
                    if (e.altKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      parkBuilding(b.entry.id);
                      return;
                    }
                    startDrag(e, b.entry.id);
                  }}
                  style={{
                    cursor: isPanning
                      ? 'grabbing'
                      : (dragState ? 'all-scroll' : 'default')
                  }}
                />
                  );
                })()}
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
                      {fullName}
                    </div>
                  </foreignObject>
                )}
              </g>
              );
            })}

            {selectionRegion && (() => {
              const minX = Math.min(selectionRegion.start.x, selectionRegion.end.x);
              const minY = Math.min(selectionRegion.start.y, selectionRegion.end.y);
              const maxX = Math.max(selectionRegion.start.x, selectionRegion.end.x) + 1;
              const maxY = Math.max(selectionRegion.start.y, selectionRegion.end.y) + 1;
              return (
                <rect
                  x={minX * CELL_SIZE + 0.5}
                  y={minY * CELL_SIZE + 0.5}
                  width={(maxX - minX) * CELL_SIZE - 1}
                  height={(maxY - minY) * CELL_SIZE - 1}
                  fill="rgba(52, 152, 219, 0.2)"
                  stroke="rgba(52, 152, 219, 0.95)"
                  strokeWidth={1.2}
                  strokeDasharray="2 2"
                  pointerEvents="none"
                />
              );
            })()}

            {dragState && buildingById.get(dragState.id) && (() => {
              const b = buildingById.get(dragState.id);
              if (!b) return null;

              // Road line preview
              if (dragState.lineCells && dragState.lineCells.length > 0) {
                return (
                  <g pointerEvents="none">
                    {dragState.lineCells
                      .filter(cell => Number.isFinite(cell.x) && Number.isFinite(cell.y))
                      .map((cell, i) => (
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
              if (!Number.isFinite(dragState.candidate.x) || !Number.isFinite(dragState.candidate.y)) return null;

              if (!dragState.originParked && dragState.groupIds.length > 1) {
                return (
                  <g pointerEvents="none">
                    {dragState.groupIds.map(id => {
                      const gb = buildingById.get(id);
                      if (!gb) return null;
                      const off = dragState.groupOffsets[id] ?? { dx: 0, dy: 0 };
                      const x = dragState.candidate!.x + off.dx;
                      const y = dragState.candidate!.y + off.dy;
                      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                      return (
                        <rect
                          key={id}
                          x={x * CELL_SIZE + 0.5}
                          y={y * CELL_SIZE + 0.5}
                          width={gb.width * CELL_SIZE - 1}
                          height={gb.length * CELL_SIZE - 1}
                          fill={dragState.valid ? 'rgba(88, 214, 141, 0.35)' : 'rgba(231, 76, 60, 0.3)'}
                          stroke={dragState.valid ? 'rgba(88, 214, 141, 0.95)' : 'rgba(231, 76, 60, 0.95)'}
                          strokeWidth={1.4}
                          rx={1}
                        />
                      );
                    })}
                  </g>
                );
              }

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

      <p className="grid-hint">Scroll to zoom · drag background to pan · Ctrl+drag to pan during placement · Shift+click add selection · Shift+drag marquee select · drag to move · Alt+Click to stage · Ctrl+Z to undo · click parked item to pick up, click map to place</p>

      {stagingNotice && (
        <div className={`designer-staging-notice ${noticeType}`} role="status" aria-live="polite">
          {stagingNotice}
        </div>
      )}

      {dragState?.originParked && (() => {
        const b = buildingById.get(dragState.id);
        if (!b) return null;
        const name = getDesignerBuildingName(b);
        const isPlaceholder = !!getPlaceholderForBuildingId(b.entry.id);
        const color = getBuildingColor(b.entry.type);
        return (
          <div
            className="designer-drag-ghost"
            style={{ left: dragState.pointer.x + 14, top: dragState.pointer.y + 24 }}
          >
            <span
              className="designer-drag-ghost-swatch"
              style={isPlaceholder
                ? {
                  backgroundColor: PLACEHOLDER_BASE_COLOR,
                  backgroundImage: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.7) 0 3px, rgba(255,255,255,0.25) 3px 6px)',
                }
                : { background: color }}
            />
            <span className="designer-drag-ghost-label">{name}</span>
            <span className="designer-drag-ghost-size">{b.length}×{b.width}</span>
          </div>
        );
      })()}

      {showHelpModal && (
        <div className="designer-help-modal-overlay" onClick={() => setShowHelpModal(false)}>
          <div className="designer-help-modal" onClick={e => e.stopPropagation()}>
            <div className="designer-help-header">
              <h2>City Designer — How to Use</h2>
              <button
                className="designer-help-close"
                onClick={() => setShowHelpModal(false)}
                title="Close help"
                aria-label="Close help"
              >
                ×
              </button>
            </div>
            <div className="designer-help-content">
              <h3>Basic Navigation</h3>
              <ul>
                <li><strong>Pan:</strong> Right-click and drag, or Ctrl+click and drag</li>
                <li><strong>Zoom:</strong> Scroll wheel (or pinch on trackpad)</li>
                <li><strong>Click a building:</strong> Select it (or deselect if already selected)</li>
                <li><strong>Drag from selection:</strong> Place selected building(s) on the map</li>
                <li><strong>Drag to staging area</strong> (right panel): Remove building(s) temporarily ("park" them)</li>
              </ul>

              <h3>Managing Buildings</h3>
              <ul>
                <li><strong>Parked Section</strong> (right panel): Drag buildings here to get them out of the way; drag them back to the map to place them again</li>
                <li><strong>Delete:</strong> Click the <strong>−</strong> button next to a parked building to mark it for deletion; click <strong>+</strong> to restore it</li>
                <li><strong>Filter:</strong> Use dropdown menus (Type, Size, Road) to show only buildings matching your criteria</li>
                <li><strong>Search:</strong> Type to find buildings by name in the staging area or map</li>
              </ul>

              <h3>Multi-Selection (Batch Placement)</h3>
              <ul>
                <li><strong>Shift+click</strong> multiple buildings to select a group</li>
                <li><strong>Drag any selected building</strong> to move the entire group together</li>
                <li><strong>Ctrl+A:</strong> Select all buildings</li>
                <li><strong>Escape:</strong> Deselect all</li>
              </ul>

              <h3>Working with Roads</h3>
              <ul>
                <li><strong>Road Classification</strong> appears in the staging area (No Road / 1x1 Road / 2x2 Road)</li>
                <li><strong>Validation</strong> (Run Validation button) checks that roads are connected properly to buildings that need them</li>
              </ul>

              <h3>Saving &amp; Loading Layouts</h3>
              <ol>
                <li><strong>Save:</strong> Click the <strong>Save</strong> button in the "Saved Versions" panel to create a snapshot</li>
                <li><strong>Load:</strong> Click <strong>Load</strong> to revert to any saved layout</li>
                <li><strong>Update:</strong> Modify a layout and click <strong>Update</strong> to save changes</li>
                <li><strong>Export:</strong> Download a layout as JSON to share or backup</li>
                <li><strong>Import:</strong> Load a previously exported layout from file</li>
              </ol>

              <h3>Custom Placeholders</h3>
              <p>Use placeholders to reserve space on your map for future buildings:</p>
              <ol>
                <li>Enter a name (e.g., "Future GB Plot")</li>
                <li>Set dimensions (height × width in cells)</li>
                <li>Select road requirement (None / 1x1 / 2x2)</li>
                <li>Click <strong>Add Placeholder</strong></li>
                <li>Click the <strong>+</strong> button next to your placeholder to stage copies</li>
                <li>Drag them onto the map like any other building</li>
              </ol>

              <h3>Tips</h3>
              <ul>
                <li><strong>Undo/Redo:</strong> Changes are tracked; use browser back/forward or edit again to navigate history</li>
                <li><strong>Validation:</strong> Run the validation check to catch buildings that need road connectivity</li>
                <li><strong>Full Screen:</strong> Toggle the fullscreen button for more canvas space</li>
                <li><strong>Changed Highlights:</strong> Enable this checkbox to visually highlight moved buildings</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

