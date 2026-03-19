import { useMemo, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import { useCityData } from '../context/CityDataContext';
import type { CityMapEntry, CityEntity, GenericReward, Product } from '../types/citydata';
import {
  resolveBuildingName,
  formatNumber,
  formatResourceName,
  ERA_RANK,
  ERA_ORDER,
  getCurrentEraKey,
  extractEra,
} from '../utils/dataProcessing';

/* ── helpers ────────────────────────────────────────────── */

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function formatUnitClass(cls: string): string {
  return cls.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function eraDisplayName(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function eraKeyFromEntityId(id: string): string {
  const m = id.match(/^[A-Z]_([A-Za-z]+)_/);
  return m ? m[1] : 'Unknown';
}

function getBuildingSize(entity: CityEntity): string {
  if (entity.width && entity.length) return `${entity.width}×${entity.length}`;
  const allAge = entity.components?.AllAge as Record<string, unknown> | undefined;
  const placement = allAge?.placement as { size?: { x?: number; y?: number } } | undefined;
  if (placement?.size?.x && placement?.size?.y) return `${placement.size.x}×${placement.size.y}`;
  return '—';
}

/** Get the component era key (e.g. 'ProgressiveEra') for a building at its current level */
function getBuildingEraComponentKey(entity: CityEntity, level?: number): string | null {
  if (!entity.components) return null;
  const componentEras = ERA_ORDER.filter(e => e in entity.components!);
  if (componentEras.length === 0) return null;
  if (level != null && level > 0) {
    const idx = Math.min(level - 1, componentEras.length - 1);
    return componentEras[idx];
  }
  return componentEras[componentEras.length - 1];
}

/* ── unit class constants ───────────────────────────────── */

const UNIT_CLASSES = ['light_melee', 'heavy_melee', 'short_ranged', 'long_ranged', 'fast'] as const;
type UnitClassKey = typeof UNIT_CLASSES[number];

const CLASS_LABELS: Record<UnitClassKey, string> = {
  light_melee: 'Light',
  heavy_melee: 'Heavy',
  short_ranged: 'Ranged',
  long_ranged: 'Artillery',
  fast: 'Fast',
};

/** Map arbitrary unit class strings to the 5 standard classes, or null for "other" */
function classifyUnit(cls: string): UnitClassKey | null {
  if (UNIT_CLASSES.includes(cls as UnitClassKey)) return cls as UnitClassKey;
  return null;
}

/* ── unit reward extraction ─────────────────────────────── */

type UnitSource = 'barracks' | 'greatbuilding' | 'reward';

interface UnitRewardInfo {
  unitName: string;
  unitClass: string;
  amount: number;
  motivated: boolean;
  random: boolean;
  dropChance: number;
}

function parseEraUnitId(id: string): { unitClass: string; era: string; amount: number } | null {
  const m = id.match(/^era_unit#([^#]+)#([^#]+)#(\d+)$/);
  if (m) return { unitClass: m[1], era: m[2], amount: parseInt(m[3]) };
  const r = id.match(/^unit#(\w+)#(\d+)$/);
  if (r) return { unitClass: r[1], era: 'special', amount: parseInt(r[2]) };
  return null;
}

/** Extract the standard class from a reward's id field if possible */
function classFromRewardId(id?: string): string | null {
  if (!id) return null;
  const parsed = parseEraUnitId(id);
  return parsed?.unitClass ?? null;
}

function resolveReward(rewardId: string, lookup: Record<string, GenericReward> | undefined): UnitRewardInfo[] {
  const units: UnitRewardInfo[] = [];
  const parsed = parseEraUnitId(rewardId);
  if (parsed) {
    const resolved = lookup?.[rewardId];
    units.push({
      unitName: resolved?.name ?? `${parsed.amount}× ${formatUnitClass(parsed.unitClass)}`,
      unitClass: parsed.unitClass,
      amount: parsed.amount,
      motivated: false,
      random: false,
      dropChance: 1,
    });
    return units;
  }
  const chest = lookup?.[rewardId];
  if (chest?.possible_rewards) {
    for (const pr of chest.possible_rewards) {
      if (pr.reward?.type === 'unit') {
        units.push({
          unitName: pr.reward.name ?? pr.reward.subType,
          unitClass: classFromRewardId(pr.reward.id) ?? pr.reward.subType ?? pr.reward.unit?.unitTypeId ?? 'unknown',
          amount: pr.reward.amount ?? 0,
          motivated: false,
          random: true,
          dropChance: pr.drop_chance / 100,
        });
      }
    }
  }
  return units;
}

function extractUnitsFromProducts(
  products: Product[],
  lookup: Record<string, GenericReward> | undefined,
): UnitRewardInfo[] {
  const units: UnitRewardInfo[] = [];
  for (const p of products) {
    if (p.type === 'genericReward' && p.reward?.id) {
      if (p.reward.type === 'unit') {
        units.push({
          unitName: p.reward.name ?? p.reward.subType,
          unitClass: classFromRewardId(p.reward.id) ?? p.reward.unit?.unitTypeId ?? p.reward.subType ?? 'unknown',
          amount: p.reward.amount ?? 0,
          motivated: !!p.onlyWhenMotivated,
          random: false,
          dropChance: 1,
        });
      } else {
        const resolved = resolveReward(p.reward.id, lookup);
        for (const u of resolved) u.motivated = u.motivated || !!p.onlyWhenMotivated;
        units.push(...resolved);
      }
    } else if (p.type === 'random' && p.products) {
      for (const drop of p.products) {
        if (drop.product?.type === 'genericReward' && drop.product.reward?.id) {
          if (drop.product.reward.type === 'unit') {
            units.push({
              unitName: drop.product.reward.name ?? drop.product.reward.subType,
              unitClass: classFromRewardId(drop.product.reward.id) ?? drop.product.reward.unit?.unitTypeId ?? drop.product.reward.subType ?? 'unknown',
              amount: drop.product.reward.amount ?? 0,
              motivated: !!p.onlyWhenMotivated,
              random: true,
              dropChance: drop.dropChance,
            });
          } else {
            const resolved = resolveReward(drop.product.reward.id, lookup);
            for (const u of resolved) {
              u.motivated = u.motivated || !!p.onlyWhenMotivated;
              u.random = true;
              u.dropChance = Math.min(u.dropChance, drop.dropChance);
            }
            units.push(...resolved);
          }
        }
      }
    } else if (p.type === 'unit' && p.unitTypeId) {
      units.push({
        unitName: p.unitTypeId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        unitClass: p.unitTypeId,
        amount: p.amount ?? 1,
        motivated: !!p.onlyWhenMotivated,
        random: false,
        dropChance: 1,
      });
    }
  }
  return units;
}

/* ── per-class cell info ────────────────────────────────── */

interface ClassCell {
  amount: number;
  names: string[];
  random: boolean;
  dropChance: number;
  motivated: boolean;
}

function emptyClassCell(): ClassCell {
  return { amount: 0, names: [], random: false, dropChance: 1, motivated: false };
}

/* ── row interface ──────────────────────────────────────── */

interface MilitaryRow {
  id: string;
  mapId: number;
  name: string;
  entityId: string;
  era: string;
  eraRank: number;
  source: UnitSource;
  count: number;
  prodTime: number;
  trainTime: number;
  healTime: number;
  trainCostMoney: number;
  trainCostSupplies: number;
  totalSlots: number;
  unlockedSlots: number;
  slotsInUse: number;
  size: string;
  isSpecial: boolean;
  motivated: boolean;
  random: boolean;
  // per-class columns
  light_melee: number;
  heavy_melee: number;
  short_ranged: number;
  long_ranged: number;
  fast: number;
  other: number;
  totalUnits: number;
  classDetails: Record<UnitClassKey, ClassCell>;
  otherDetail: ClassCell;
  upgradeable: boolean;
  upgClassDetails: Record<UnitClassKey, ClassCell> | null;
  upgOtherDetail: ClassCell | null;
  upgTotalUnits: number;
  entries: CityMapEntry[];
  entity: CityEntity;
}

const columnHelper = createColumnHelper<MilitaryRow>();

/* ── component ──────────────────────────────────────────── */

export default function MilitaryTable() {
  const { data } = useCityData();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedSources, setSelectedSources] = useState<Set<UnitSource>>(new Set());
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [selectedEras, setSelectedEras] = useState<Set<string>>(new Set());
  const [eraDropdownOpen, setEraDropdownOpen] = useState(false);

  const rows = useMemo<MilitaryRow[]>(() => {
    if (!data) return [];
    const result: MilitaryRow[] = [];
    const currentEraKey = getCurrentEraKey(data) ?? 'OceanicFuture';
    const currentEraRank = ERA_RANK[extractEra(`H_${currentEraKey}_Townhall`, data)] ?? 999;

    for (const entry of Object.values(data.CityMapData)) {
      if (entry.id >= 2_000_000_000) continue;
      const entity = data.CityEntities?.[entry.cityentity_id];
      if (!entity) continue;

      const era = extractEra(entry.cityentity_id, data, entry.level);
      const eraKey = eraKeyFromEntityId(entry.cityentity_id);
      const eraRank = ERA_RANK[era] ?? 999;
      const size = getBuildingSize(entity);
      const buildingName = entity.name || resolveBuildingName(entry.cityentity_id, data);

      // Collect all unit infos for this building
      let unitInfos: UnitRewardInfo[] = [];
      let source: UnitSource = 'reward';
      let prodTime = 0;
      let trainTime = 0;
      let healTime = 0;
      let trainCostMoney = 0;
      let trainCostSupplies = 0;
      let totalSlots = 0;
      let unlockedSlots = 0;
      let slotsInUse = 0;

      // Source A: Military barracks
      if (entry.type === 'military' && entity.available_products?.length) {
        const product = entity.available_products[0];
        if (!product.unit_type_id) continue;
        source = 'barracks';
        const cost = product.requirements?.cost?.resources;
        const costMap = cost && !Array.isArray(cost) ? cost : {};
        totalSlots = entity.usable_slots ?? entry.unitSlots?.length ?? 0;
        unlockedSlots = entry.unitSlots
          ? entry.unitSlots.filter(s => s.unlocked).length
          : totalSlots;
        slotsInUse = entry.unitSlots
          ? entry.unitSlots.filter(s => s.unit_id !== undefined && s.unit_id >= 0).length
          : 0;
        trainTime = product.time_to_train ?? 0;
        healTime = product.time_to_heal ?? 0;
        prodTime = product.time_to_train ?? product.production_time ?? 0;
        trainCostMoney = (costMap as Record<string, number>).money ?? 0;
        trainCostSupplies = (costMap as Record<string, number>).supplies ?? 0;

        unitInfos = [{
          unitName: product.name,
          unitClass: product.unit_class ?? '',
          amount: product.amount ?? 1,
          motivated: false,
          random: false,
          dropChance: 1,
        }];
      }
      // Source B: Great Building penal_unit
      else if (entity.available_products?.some(p => p.name === 'penal_unit')) {
        source = 'greatbuilding';
        const p = entity.available_products!.find(p => p.name === 'penal_unit')!;
        const amt = (entry.state?.current_product as { amount?: number } | undefined)?.amount ?? p.amount ?? 0;
        prodTime = p.production_time ?? 86400;
        unitInfos = [{
          unitName: 'Unattached Units',
          unitClass: 'unattached',
          amount: amt,
          motivated: false,
          random: false,
          dropChance: 1,
        }];
      }
      // Source C: Production rewards
      // Prefer entity components at the building's actual era (has era-correct unit names)
      // Fall back to resolved map state only if components don't have units
      else {
        if (entity.components) {
          const buildingEraKey = getBuildingEraComponentKey(entity, entry.level);
          const eraKeys = buildingEraKey
            ? [buildingEraKey]
            : (eraKey === 'MultiAge' ? [currentEraKey] : [eraKey]);
          for (const ek of eraKeys) {
            const comp = entity.components[ek] as Record<string, unknown> | undefined;
            const prod = comp?.production as { options?: Array<{ time: number; products: Product[] }> } | undefined;
            const lookupObj = comp?.lookup as { rewards?: Record<string, GenericReward> } | undefined;
            if (prod?.options) {
              for (const opt of prod.options) {
                const optUnits = extractUnitsFromProducts(opt.products ?? [], lookupObj?.rewards);
                if (optUnits.length > 0) {
                  unitInfos = optUnits;
                  prodTime = opt.time ?? 0;
                  break;
                }
              }
            }
            if (unitInfos.length > 0) break;
          }
        }
        // Fallback: use resolved data from map state
        if (unitInfos.length === 0) {
          const stateProducts = entry.state?.productionOption?.products;
          if (stateProducts) {
            unitInfos = extractUnitsFromProducts(stateProducts as Product[], undefined);
            prodTime = entry.state.productionOption?.time ?? 0;
          }
        }
      }

      if (unitInfos.length === 0) continue;

      // Distribute into per-class buckets
      const classDetails = Object.fromEntries(
        UNIT_CLASSES.map(c => [c, emptyClassCell()])
      ) as Record<UnitClassKey, ClassCell>;
      const otherDetail = emptyClassCell();
      let anyMotivated = false;
      let anyRandom = false;

      for (const u of unitInfos) {
        const ck = classifyUnit(u.unitClass);
        const cell = ck ? classDetails[ck] : otherDetail;
        cell.amount += u.amount;
        if (u.unitName && !cell.names.includes(u.unitName)) cell.names.push(u.unitName);
        if (u.random) { cell.random = true; cell.dropChance = Math.min(cell.dropChance, u.dropChance); }
        if (u.motivated) cell.motivated = true;
        if (u.motivated) anyMotivated = true;
        if (u.random) anyRandom = true;
      }

      const totalUnits = UNIT_CLASSES.reduce((s, c) => s + classDetails[c].amount, 0) + otherDetail.amount;

      // Check if building can be upgraded to current era (only production reward buildings)
      const upgradeable = source === 'reward' && eraRank >= 0 && eraRank < currentEraRank;
      let upgClassDetails: Record<UnitClassKey, ClassCell> | null = null;
      let upgOtherDetail: ClassCell | null = null;
      let upgTotalUnits = 0;

      if (upgradeable && entity.components && currentEraKey in entity.components) {
        const comp = entity.components[currentEraKey] as Record<string, unknown> | undefined;
        const prod = comp?.production as { options?: Array<{ time: number; products: Product[] }> } | undefined;
        const lookupObj = comp?.lookup as { rewards?: Record<string, GenericReward> } | undefined;
        let upgUnits: UnitRewardInfo[] = [];
        if (prod?.options) {
          for (const opt of prod.options) {
            upgUnits = extractUnitsFromProducts(opt.products ?? [], lookupObj?.rewards);
            if (upgUnits.length > 0) break;
          }
        }
        if (upgUnits.length > 0) {
          upgClassDetails = Object.fromEntries(
            UNIT_CLASSES.map(c => [c, emptyClassCell()])
          ) as Record<UnitClassKey, ClassCell>;
          upgOtherDetail = emptyClassCell();
          for (const u of upgUnits) {
            const ck = classifyUnit(u.unitClass);
            const cell = ck ? upgClassDetails[ck] : upgOtherDetail;
            cell.amount += u.amount;
            if (u.unitName && !cell.names.includes(u.unitName)) cell.names.push(u.unitName);
            if (u.random) { cell.random = true; cell.dropChance = Math.min(cell.dropChance, u.dropChance); }
            if (u.motivated) cell.motivated = true;
          }
          upgTotalUnits = UNIT_CLASSES.reduce((s, c) => s + upgClassDetails![c].amount, 0) + upgOtherDetail!.amount;
        }
      }

      result.push({
        id: `${entry.id}`,
        mapId: entry.id,
        name: buildingName,
        entityId: entry.cityentity_id,
        era, eraRank, source,
        count: 1,
        prodTime, trainTime, healTime,
        trainCostMoney, trainCostSupplies,
        totalSlots, unlockedSlots, slotsInUse,
        size,
        isSpecial: !!entity.is_special,
        motivated: anyMotivated,
        random: anyRandom,
        light_melee: classDetails.light_melee.amount,
        heavy_melee: classDetails.heavy_melee.amount,
        short_ranged: classDetails.short_ranged.amount,
        long_ranged: classDetails.long_ranged.amount,
        fast: classDetails.fast.amount,
        other: otherDetail.amount,
        totalUnits,
        classDetails,
        otherDetail,
        upgradeable,
        upgClassDetails,
        upgOtherDetail,
        upgTotalUnits,
        entries: [entry], entity,
      });
    }

    // Group by entityId — merge duplicate buildings
    const grouped = new Map<string, MilitaryRow>();
    for (const row of result) {
      const existing = grouped.get(row.entityId);
      if (!existing) {
        grouped.set(row.entityId, row);
      } else {
        existing.count += 1;
        existing.entries.push(...row.entries);
        // Sum per-class amounts
        for (const cls of UNIT_CLASSES) {
          existing[cls] += row[cls];
          existing.classDetails[cls].amount += row.classDetails[cls].amount;
          for (const n of row.classDetails[cls].names) {
            if (!existing.classDetails[cls].names.includes(n)) existing.classDetails[cls].names.push(n);
          }
          if (row.classDetails[cls].random) existing.classDetails[cls].random = true;
          if (row.classDetails[cls].motivated) existing.classDetails[cls].motivated = true;
        }
        existing.other += row.other;
        existing.otherDetail.amount += row.otherDetail.amount;
        for (const n of row.otherDetail.names) {
          if (!existing.otherDetail.names.includes(n)) existing.otherDetail.names.push(n);
        }
        if (row.otherDetail.random) existing.otherDetail.random = true;
        if (row.otherDetail.motivated) existing.otherDetail.motivated = true;
        existing.totalUnits += row.totalUnits;
        existing.totalSlots += row.totalSlots;
        existing.unlockedSlots += row.unlockedSlots;
        existing.slotsInUse += row.slotsInUse;
        if (row.motivated) existing.motivated = true;
        if (row.random) existing.random = true;
        // Merge upgrade details (use first instance's upgrade — same entity)
        if (!existing.upgClassDetails && row.upgClassDetails) {
          existing.upgradeable = row.upgradeable;
          existing.upgClassDetails = row.upgClassDetails;
          existing.upgOtherDetail = row.upgOtherDetail;
          existing.upgTotalUnits = row.upgTotalUnits;
        } else if (existing.upgClassDetails && row.upgClassDetails) {
          // Scale upgrade by count (multiply single-building upgrade amounts)
          for (const cls of UNIT_CLASSES) {
            existing.upgClassDetails[cls].amount += row.upgClassDetails[cls].amount;
          }
          if (existing.upgOtherDetail && row.upgOtherDetail) {
            existing.upgOtherDetail.amount += row.upgOtherDetail.amount;
          }
          existing.upgTotalUnits += row.upgTotalUnits;
        }
      }
    }
    return Array.from(grouped.values());
  }, [data]);

  /* ── filter state ───────────────── */

  const allSources: UnitSource[] = ['barracks', 'greatbuilding', 'reward'];
  const sourceLabels: Record<UnitSource, string> = {
    barracks: 'Barracks',
    greatbuilding: 'Great Building',
    reward: 'Production Reward',
  };

  const allEras = useMemo(() =>
    Array.from(new Set(rows.map(r => r.era)))
      .sort((a, b) => (ERA_RANK[a] ?? 999) - (ERA_RANK[b] ?? 999)),
  [rows]);

  const toggleSet = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const filteredRows = useMemo(() => {
    let result = rows;
    if (selectedSources.size > 0) result = result.filter(r => selectedSources.has(r.source));
    if (selectedEras.size > 0) result = result.filter(r => selectedEras.has(r.era));
    return result;
  }, [rows, selectedSources, selectedEras]);

  /* ── class cell renderer ────────── */

  function renderClassCell(cell: ClassCell, upgCell?: ClassCell) {
    if (cell.amount === 0 && (!upgCell || upgCell.amount === 0)) return <span className="text-muted">—</span>;
    const delta = upgCell ? upgCell.amount - cell.amount : 0;
    return (
      <span>
        {cell.amount || '—'}
        {cell.random && <span className="badge badge-random" title={`${Math.round(cell.dropChance * 100)}% chance`}> 🎲</span>}
        {cell.motivated && <span className="badge badge-motivated" title="Requires motivation"> ⭐</span>}
        {delta > 0 && <span className="upgrade-delta"> +{delta}</span>}
      </span>
    );
  }

  /* ── column defs ────────────────── */

  const columns = useMemo(() => [
    columnHelper.accessor('name', {
      header: 'Building',
      cell: info => {
        const r = info.row.original;
        return (
          <>
            {r.isSpecial && <span className="type-badge type-special">★</span>}
            {r.count > 1 && <span className="count-badge">{r.count}×</span>}
            {' '}{info.getValue()}
          </>
        );
      },
    }),
    columnHelper.accessor('source', {
      header: 'Source',
      cell: info => {
        const r = info.row.original;
        const s = info.getValue();
        return (
          <span>
            <span className={`type-badge type-${s}`}>{sourceLabels[s]}</span>
            {s === 'reward' && r.upgradeable && r.upgClassDetails && <span className="upgrade-indicator" title="Upgradeable — units improve at current era"> ⬆</span>}
          </span>
        );
      },
    }),
    columnHelper.accessor('era', {
      header: 'Era',
      cell: info => {
        const r = info.row.original;
        return r.upgradeable
          ? <span className="era-text upgradeable" title="Below current era — can be upgraded">⬆ {info.getValue()}</span>
          : <span className="era-text">{info.getValue()}</span>;
      },
      sortingFn: (rowA, rowB) => rowA.original.eraRank - rowB.original.eraRank,
    }),
    ...UNIT_CLASSES.map(cls =>
      columnHelper.accessor(cls, {
        header: CLASS_LABELS[cls],
        cell: info => {
          const r = info.row.original;
          return renderClassCell(r.classDetails[cls], r.upgClassDetails?.[cls]);
        },
      })
    ),
    columnHelper.accessor('other', {
      header: 'Other',
      cell: info => {
        const r = info.row.original;
        // Don't show upgrade delta for Other (rogues don't change with era)
        return renderClassCell(r.otherDetail);
      },
    }),
    columnHelper.accessor('totalUnits', {
      header: 'Total',
      cell: info => {
        const r = info.row.original;
        // Exclude other from upgrade total delta (rogues)
        const currentStandard = UNIT_CLASSES.reduce((s, c) => s + r.classDetails[c].amount, 0);
        const upgStandard = r.upgClassDetails ? UNIT_CLASSES.reduce((s, c) => s + r.upgClassDetails![c].amount, 0) : 0;
        const delta = upgStandard - currentStandard;
        return <><strong>{info.getValue()}</strong>{delta > 0 && <span className="upgrade-delta"> +{delta}</span>}</>;
      },
    }),
    columnHelper.accessor('prodTime', {
      header: 'Cycle',
      cell: info => info.getValue() > 0 ? formatTime(info.getValue()) : '—',
    }),
    columnHelper.accessor('size', { header: 'Size' }),
  ], []);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (!data) return null;

  /* ── summary counts ─────────────── */
  const barracksCount = rows.filter(r => r.source === 'barracks').length;
  const gbCount = rows.filter(r => r.source === 'greatbuilding').length;
  const rewardCount = rows.filter(r => r.source === 'reward').length;

  return (
    <div className="building-table-container">
      <div className="table-controls">
        <h2>⚔ Unit Producers — {filteredRows.length} buildings</h2>
        <div className="unit-summary-badges">
          <span className="type-badge type-barracks">{barracksCount} Barracks</span>
          <span className="type-badge type-greatbuilding">{gbCount} Great Building</span>
          <span className="type-badge type-reward">{rewardCount} Reward</span>
        </div>
        <div className="filters">
          <div className="filter-dropdown">
            <button className="filter-btn" onClick={() => { setSourceDropdownOpen(!sourceDropdownOpen); setEraDropdownOpen(false); }}>
              Source{selectedSources.size > 0 ? ` (${selectedSources.size})` : ''} ▾
            </button>
            {sourceDropdownOpen && (
              <div className="filter-panel">
                <button className="filter-clear" onClick={() => setSelectedSources(new Set())}>Clear all</button>
                {allSources.map(s => (
                  <label key={s} className="filter-option">
                    <input type="checkbox" checked={selectedSources.has(s)} onChange={() => setSelectedSources(toggleSet(selectedSources, s) as Set<UnitSource>)} />
                    {sourceLabels[s]}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="filter-dropdown">
            <button className="filter-btn" onClick={() => { setEraDropdownOpen(!eraDropdownOpen); setSourceDropdownOpen(false); }}>
              Era{selectedEras.size > 0 ? ` (${selectedEras.size})` : ''} ▾
            </button>
            {eraDropdownOpen && (
              <div className="filter-panel">
                <button className="filter-clear" onClick={() => setSelectedEras(new Set())}>Clear all</button>
                {allEras.map(era => (
                  <label key={era} className="filter-option">
                    <input type="checkbox" checked={selectedEras.has(era)} onChange={() => setSelectedEras(toggleSet(selectedEras, era))} />
                    {era}
                  </label>
                ))}
              </div>
            )}
          </div>
          <label>
            Search:
            <input type="text" placeholder="Filter by name..." onChange={e => setColumnFilters([{ id: 'name', value: e.target.value }])} />
          </label>
        </div>
      </div>

      <div className="table-scroll">
        <table className="building-table">
          <thead>
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>
                {hg.headers.map(header => (
                  <th key={header.id} onClick={header.column.getToggleSortingHandler()} className={header.column.getCanSort() ? 'sortable' : ''}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: ' ▲', desc: ' ▼' }[header.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(row => (
              <>
                <tr key={row.id} onClick={() => setExpandedId(expandedId === row.original.id ? null : row.original.id)} className={expandedId === row.original.id ? 'expanded' : ''}>
                  {row.getVisibleCells().map(cell => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
                {expandedId === row.original.id && (
                  <tr key={`${row.id}-detail`} className="detail-row">
                    <td colSpan={columns.length}>
                      <MilitaryDetail row={row.original} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Detail ─────────────────────────────────────────────── */

function MilitaryDetail({ row }: { row: MilitaryRow }) {
  const { entity, entries } = row;
  const entry = entries[0];
  const req = entity.requirements;

  return (
    <div className="building-detail">
      <div className="detail-grid">
        <div className="detail-section">
          <h4>Building Info</h4>
          <p><strong>Entity ID:</strong> {row.entityId}</p>
          <p><strong>Source:</strong> {row.source === 'barracks' ? 'Military Barracks' : row.source === 'greatbuilding' ? 'Great Building' : 'Production Reward'}</p>
          <p><strong>Size:</strong> {row.size}</p>
          {row.count > 1 && <p><strong>Count:</strong> {row.count}</p>}
          {entry.level !== undefined && <p><strong>Level:</strong> {entry.level}</p>}
          {req?.min_era && <p><strong>Min Era:</strong> {eraDisplayName(req.min_era)}</p>}
          {req?.cost?.resources && (
            <div>
              <strong>Build Cost:</strong>
              <ul>
                {Object.entries(req.cost.resources).filter(([, v]) => v > 0).map(([k, v]) => (
                  <li key={k}>{formatNumber(v)} {formatResourceName(k)}</li>
                ))}
              </ul>
            </div>
          )}
          {row.source === 'barracks' && (
            <>
              <p><strong>Train Time:</strong> {formatTime(row.trainTime)}</p>
              <p><strong>Heal Time:</strong> {formatTime(row.healTime)}</p>
              {(row.trainCostMoney > 0 || row.trainCostSupplies > 0) && (
                <div>
                  <strong>Training Cost:</strong>
                  <ul>
                    {row.trainCostMoney > 0 && <li>{formatNumber(row.trainCostMoney)} Coins</li>}
                    {row.trainCostSupplies > 0 && <li>{formatNumber(row.trainCostSupplies)} Supplies</li>}
                  </ul>
                </div>
              )}
            </>
          )}
          {row.prodTime > 0 && row.source !== 'barracks' && (
            <p><strong>Cycle:</strong> {formatTime(row.prodTime)}</p>
          )}
        </div>

        <div className="detail-section">
          <h4>Units Produced</h4>
          <table className="detail-unit-table">
            <thead>
              <tr><th>Class</th><th>Unit</th><th>Qty</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {UNIT_CLASSES.map(cls => {
                const cell = row.classDetails[cls];
                const upgCell = row.upgClassDetails?.[cls];
                if (cell.amount === 0 && (!upgCell || upgCell.amount === 0)) return null;
                return (
                  <tr key={cls}>
                    <td><span className={`unit-class unit-class-${cls}`}>{CLASS_LABELS[cls]}</span></td>
                    <td>{cell.names.join(', ') || '—'}</td>
                    <td>{cell.amount}{upgCell && upgCell.amount > cell.amount && <span className="upgrade-delta"> +{upgCell.amount - cell.amount}</span>}</td>
                    <td>
                      {cell.random && <span>🎲 {Math.round(cell.dropChance * 100)}%</span>}
                      {cell.motivated && <span> ⭐ Motivated</span>}
                    </td>
                  </tr>
                );
              })}
              {row.otherDetail.amount > 0 && (
                <tr>
                  <td><span className="text-muted">Other</span></td>
                  <td>{row.otherDetail.names.join(', ') || '—'}</td>
                  <td>{row.otherDetail.amount}</td>
                  <td>
                    {row.otherDetail.random && <span>🎲 {Math.round(row.otherDetail.dropChance * 100)}%</span>}
                    {row.otherDetail.motivated && <span> ⭐ Motivated</span>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {row.source === 'reward' && row.upgradeable && row.upgClassDetails &&
            UNIT_CLASSES.some(cls => row.upgClassDetails![cls].amount > 0) && (
            <div style={{ marginTop: '1rem' }}>
              <h4 className="upgrade-heading">⬆ Units at Current Era</h4>
              <table className="detail-unit-table">
                <thead>
                  <tr><th>Class</th><th>Unit</th><th>Qty</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {UNIT_CLASSES.map(cls => {
                    const cell = row.upgClassDetails![cls];
                    if (cell.amount === 0) return null;
                    return (
                      <tr key={cls}>
                        <td><span className={`unit-class unit-class-${cls}`}>{CLASS_LABELS[cls]}</span></td>
                        <td>{cell.names.join(', ') || '—'}</td>
                        <td>{cell.amount}</td>
                        <td>
                          {cell.random && <span>🎲 {Math.round(cell.dropChance * 100)}%</span>}
                          {cell.motivated && <span> ⭐ Motivated</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
