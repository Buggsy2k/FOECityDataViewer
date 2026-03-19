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
import type { CityMapEntry, CityEntity } from '../types/citydata';
import {
  resolveBuildingName,
  getBuildingProduction,
  getBuildingEraStats,
  getBuildingStatsAtEra,
  getCurrentEraKey,
  formatResourceName,
  formatNumber,
  extractEra,
  ERA_RANK,
  ERA_ORDER,
  type BuildingEraStats,
} from '../utils/dataProcessing';
import type { CityData, ResourceMap } from '../types/citydata';

function getBuildingSize(entity: CityEntity): string {
  if (entity.width && entity.length) return `${entity.width}×${entity.length}`;
  const allAge = entity.components?.AllAge as Record<string, unknown> | undefined;
  const placement = allAge?.placement as { size?: { x?: number; y?: number } } | undefined;
  if (placement?.size?.x && placement?.size?.y) return `${placement.size.x}×${placement.size.y}`;
  return '—';
}

interface BuildingRow {
  id: number;
  name: string;
  entityId: string;
  type: string;
  era: string;
  eraRank: number;
  level: number;
  count: number;
  connected: boolean;
  population: number;
  happiness: number;
  forgePoints: number;
  goods: number;
  atkArmy: number;
  defArmy: number;
  productionSummary: string;
  entries: CityMapEntry[];
  upgradeable: boolean;
  upgStats: BuildingEraStats | null;
}

const columnHelper = createColumnHelper<BuildingRow>();

function addResources(target: ResourceMap, source: ResourceMap) {
  for (const [key, val] of Object.entries(source)) {
    target[key] = (target[key] || 0) + val;
  }
}

export default function BuildingTable() {
  const { data } = useCityData();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const [selectedEras, setSelectedEras] = useState<Set<string>>(new Set());
  const [eraDropdownOpen, setEraDropdownOpen] = useState(false);
  const [upgradeFilterOn, setUpgradeFilterOn] = useState(false);
  const [upgradeFilterCols, setUpgradeFilterCols] = useState<Set<string>>(new Set());
  const [upgradeDropdownOpen, setUpgradeDropdownOpen] = useState(false);

  const currentEraKey = useMemo(() => data ? getCurrentEraKey(data) : null, [data]);
  const currentEraRank = useMemo(() => {
    if (!currentEraKey) return -1;
    return ERA_ORDER.indexOf(currentEraKey);
  }, [currentEraKey]);

  const rows = useMemo<BuildingRow[]>(() => {
    if (!data) return [];
    // Group by entityId + level
    const groups = new Map<string, CityMapEntry[]>();
    for (const entry of Object.values(data.CityMapData)) {
      if (entry.id >= 2_000_000_000) continue;
      const key = `${entry.cityentity_id}::${entry.level ?? 0}`;
      const arr = groups.get(key);
      if (arr) arr.push(entry);
      else groups.set(key, [entry]);
    }

    return Array.from(groups.values()).map(entries => {
      const entry = entries[0];
      // Aggregate production across all identical buildings
      const allRes: ResourceMap = {};
      for (const e of entries) {
        const prod = getBuildingProduction(e);
        addResources(allRes, prod.base);
        addResources(allRes, prod.motivated);
      }
      const summary = Object.entries(allRes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${formatNumber(v)} ${formatResourceName(k)}`)
        .join(', ');

      const eraStats = getBuildingEraStats(entry.cityentity_id, data, entry.level);
      const era = extractEra(entry.cityentity_id, data, entry.level);
      const eraRank = ERA_RANK[era] ?? 999;
      const atkArmy = eraStats.atkArmyAtk + eraStats.atkArmyDef;
      const defArmy = eraStats.defArmyAtk + eraStats.defArmyDef;

      // Check if building is below current era and can be upgraded
      const upgradeable = currentEraKey != null && eraRank >= 0 && eraRank < currentEraRank;
      const upgStats = upgradeable
        ? getBuildingStatsAtEra(entry.cityentity_id, data, currentEraKey!)
        : null;

      return {
        id: entry.id,
        name: resolveBuildingName(entry.cityentity_id, data),
        entityId: entry.cityentity_id,
        type: entry.type,
        era,
        eraRank,
        level: entry.level ?? 0,
        count: entries.length,
        connected: entries.some(e => (e.connected ?? 0) > 0),
        population: eraStats.population,
        happiness: eraStats.happiness,
        forgePoints: eraStats.forgePoints,
        goods: eraStats.goods,
        atkArmy,
        defArmy,
        productionSummary: summary || '—',
        entries,
        upgradeable,
        upgStats,
      };
    });
  }, [data, currentEraKey, currentEraRank]);

  const buildingTypes = useMemo(() => {
    return Array.from(new Set(rows.map(r => r.type))).sort();
  }, [rows]);

  const allEras = useMemo(() => {
    return Array.from(new Set(rows.map(r => r.era)))
      .sort((a, b) => (ERA_RANK[a] ?? 999) - (ERA_RANK[b] ?? 999));
  }, [rows]);

  const toggleSet = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const UPGRADE_STAT_COLS: { key: string; label: string; delta: (r: BuildingRow) => number }[] = useMemo(() => [
    { key: 'population', label: 'Pop', delta: r => r.upgStats ? r.upgStats.population - r.population : 0 },
    { key: 'happiness', label: 'Happy', delta: r => r.upgStats ? r.upgStats.happiness - r.happiness : 0 },
    { key: 'forgePoints', label: 'FP', delta: r => r.upgStats ? r.upgStats.forgePoints - r.forgePoints : 0 },
    { key: 'goods', label: 'Goods', delta: r => r.upgStats ? r.upgStats.goods - r.goods : 0 },
    { key: 'atkArmy', label: 'Atk Army', delta: r => { const us = r.upgStats; return us ? (us.atkArmyAtk + us.atkArmyDef) - r.atkArmy : 0; } },
    { key: 'defArmy', label: 'Def Army', delta: r => { const us = r.upgStats; return us ? (us.defArmyAtk + us.defArmyDef) - r.defArmy : 0; } },
  ], []);

  const filteredRows = useMemo(() => {
    let result = rows;
    if (selectedTypes.size > 0) result = result.filter(r => selectedTypes.has(r.type));
    if (selectedEras.size > 0) result = result.filter(r => selectedEras.has(r.era));
    if (upgradeFilterOn) {
      const activeCols = upgradeFilterCols.size > 0
        ? UPGRADE_STAT_COLS.filter(c => upgradeFilterCols.has(c.key))
        : UPGRADE_STAT_COLS;
      result = result.filter(r => r.upgradeable && activeCols.some(c => c.delta(r) > 0));
    }
    return result;
  }, [rows, selectedTypes, selectedEras, upgradeFilterOn, upgradeFilterCols, UPGRADE_STAT_COLS]);

  const totalBuildings = useMemo(() => filteredRows.reduce((s, r) => s + r.count, 0), [filteredRows]);

  const columns = useMemo(() => [
    columnHelper.accessor('name', {
      header: 'Name',
      cell: info => {
        const row = info.row.original;
        return row.count > 1
          ? <><span className="count-badge">{row.count}×</span> {info.getValue()}</>
          : info.getValue();
      },
    }),
    columnHelper.accessor('type', {
      header: 'Type',
      cell: info => <span className={`type-badge type-${info.getValue()}`}>{info.getValue().replace(/_/g, ' ')}</span>,
    }),
    columnHelper.accessor('era', {
      header: 'Era',
      cell: info => {
        const row = info.row.original;
        return row.upgradeable
          ? <span className="era-text upgradeable" title="Below current era — can be upgraded">⬆ {info.getValue()}</span>
          : <span className="era-text">{info.getValue()}</span>;
      },
      sortingFn: (rowA, rowB) => {
        const a = ERA_RANK[rowA.original.era] ?? 999;
        const b = ERA_RANK[rowB.original.era] ?? 999;
        return a - b;
      },
    }),
    columnHelper.accessor('connected', {
      header: 'Road',
      cell: info => info.getValue() ? '✓' : '✗',
    }),
    columnHelper.accessor('population', {
      header: 'Pop',
      cell: info => {
        const row = info.row.original;
        const v = info.getValue();
        if (!v && !row.upgStats?.population) return '';
        const delta = row.upgStats ? row.upgStats.population - v : 0;
        return <>{v ? formatNumber(v) : ''}{delta > 0 && <span className="upgrade-delta"> +{formatNumber(delta)}</span>}</>;
      },
      sortingFn: upgradeFilterOn
        ? (a, b) => { const da = a.original.upgStats ? a.original.upgStats.population - a.original.population : 0; const db = b.original.upgStats ? b.original.upgStats.population - b.original.population : 0; return da - db; }
        : 'basic',
    }),
    columnHelper.accessor('happiness', {
      header: 'Happy',
      cell: info => {
        const row = info.row.original;
        const v = info.getValue();
        if (!v && !row.upgStats?.happiness) return '';
        const delta = row.upgStats ? row.upgStats.happiness - v : 0;
        return <>{v ? formatNumber(v) : ''}{delta > 0 && <span className="upgrade-delta"> +{formatNumber(delta)}</span>}</>;
      },
      sortingFn: upgradeFilterOn
        ? (a, b) => { const da = a.original.upgStats ? a.original.upgStats.happiness - a.original.happiness : 0; const db = b.original.upgStats ? b.original.upgStats.happiness - b.original.happiness : 0; return da - db; }
        : 'basic',
    }),
    columnHelper.accessor('forgePoints', {
      header: 'FP',
      cell: info => {
        const row = info.row.original;
        const v = info.getValue();
        if (!v && !row.upgStats?.forgePoints) return '';
        const delta = row.upgStats ? row.upgStats.forgePoints - v : 0;
        return <>{v || ''}{delta > 0 && <span className="upgrade-delta"> +{delta}</span>}</>;
      },
      sortingFn: upgradeFilterOn
        ? (a, b) => { const da = a.original.upgStats ? a.original.upgStats.forgePoints - a.original.forgePoints : 0; const db = b.original.upgStats ? b.original.upgStats.forgePoints - b.original.forgePoints : 0; return da - db; }
        : 'basic',
    }),
    columnHelper.accessor('goods', {
      header: 'Goods',
      cell: info => {
        const row = info.row.original;
        const v = info.getValue();
        if (!v && !row.upgStats?.goods) return '';
        const delta = row.upgStats ? row.upgStats.goods - v : 0;
        return <>{v || ''}{delta > 0 && <span className="upgrade-delta"> +{delta}</span>}</>;
      },
      sortingFn: upgradeFilterOn
        ? (a, b) => { const da = a.original.upgStats ? a.original.upgStats.goods - a.original.goods : 0; const db = b.original.upgStats ? b.original.upgStats.goods - b.original.goods : 0; return da - db; }
        : 'basic',
    }),
    columnHelper.accessor('atkArmy', {
      header: 'Atk Army',
      cell: info => {
        const row = info.row.original;
        const v = info.getValue();
        const us = row.upgStats;
        const upgTotal = us ? us.atkArmyAtk + us.atkArmyDef : 0;
        if (!v && !upgTotal) return '';
        const delta = upgTotal - v;
        return <span title="Attack + Defense % for attacking army">
          {v ? <>⚔ {v}%</> : ''}
          {delta > 0 && <span className="upgrade-delta"> +{delta}%</span>}
        </span>;
      },
      sortingFn: upgradeFilterOn
        ? (a, b) => { const ao = a.original; const bo = b.original; const da = ao.upgStats ? (ao.upgStats.atkArmyAtk + ao.upgStats.atkArmyDef) - ao.atkArmy : 0; const db = bo.upgStats ? (bo.upgStats.atkArmyAtk + bo.upgStats.atkArmyDef) - bo.atkArmy : 0; return da - db; }
        : 'basic',
    }),
    columnHelper.accessor('defArmy', {
      header: 'Def Army',
      cell: info => {
        const row = info.row.original;
        const v = info.getValue();
        const us = row.upgStats;
        const upgTotal = us ? us.defArmyAtk + us.defArmyDef : 0;
        if (!v && !upgTotal) return '';
        const delta = upgTotal - v;
        return <span title="Attack + Defense % for defending army">
          {v ? <>🛡 {v}%</> : ''}
          {delta > 0 && <span className="upgrade-delta"> +{delta}%</span>}
        </span>;
      },
      sortingFn: upgradeFilterOn
        ? (a, b) => { const ao = a.original; const bo = b.original; const da = ao.upgStats ? (ao.upgStats.defArmyAtk + ao.upgStats.defArmyDef) - ao.defArmy : 0; const db = bo.upgStats ? (bo.upgStats.defArmyAtk + bo.upgStats.defArmyDef) - bo.defArmy : 0; return da - db; }
        : 'basic',
    }),
    columnHelper.accessor('productionSummary', {
      header: 'Daily Production (total)',
      cell: info => <span className="production-text">{info.getValue()}</span>,
      enableSorting: false,
    }),
  ], [upgradeFilterOn]);

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

  return (
    <div className="building-table-container">
      <div className="table-controls">
        <h2>{filteredRows.length} groups ({totalBuildings} buildings)</h2>
        <div className="filters">
          <div className="filter-dropdown">
            <button
              className={`filter-btn${upgradeFilterOn ? ' filter-btn-active' : ''}`}
              onClick={() => { setUpgradeDropdownOpen(!upgradeDropdownOpen); setTypeDropdownOpen(false); setEraDropdownOpen(false); }}
            >
              Upgradeable{upgradeFilterCols.size > 0 ? ` (${upgradeFilterCols.size})` : ''} ▾
            </button>
            {upgradeDropdownOpen && (
              <div className="filter-panel">
                <label className="filter-option">
                  <input
                    type="checkbox"
                    checked={upgradeFilterOn}
                    onChange={() => setUpgradeFilterOn(!upgradeFilterOn)}
                  />
                  <strong>Show only upgradeable</strong>
                </label>
                <div className="filter-divider" />
                <span className="filter-section-label">Improvement columns:</span>
                <button className="filter-clear" onClick={() => setUpgradeFilterCols(new Set())}>All columns (default)</button>
                {UPGRADE_STAT_COLS.map(c => (
                  <label key={c.key} className="filter-option">
                    <input
                      type="checkbox"
                      checked={upgradeFilterCols.has(c.key)}
                      onChange={() => setUpgradeFilterCols(toggleSet(upgradeFilterCols, c.key))}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="filter-dropdown">
            <button
              className="filter-btn"
              onClick={() => { setTypeDropdownOpen(!typeDropdownOpen); setEraDropdownOpen(false); setUpgradeDropdownOpen(false); }}
            >
              Type{selectedTypes.size > 0 ? ` (${selectedTypes.size})` : ''} ▾
            </button>
            {typeDropdownOpen && (
              <div className="filter-panel">
                <button className="filter-clear" onClick={() => setSelectedTypes(new Set())}>Clear all</button>
                {buildingTypes.map(t => (
                  <label key={t} className="filter-option">
                    <input
                      type="checkbox"
                      checked={selectedTypes.has(t)}
                      onChange={() => setSelectedTypes(toggleSet(selectedTypes, t))}
                    />
                    {t.replace(/_/g, ' ')}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="filter-dropdown">
            <button
              className="filter-btn"
              onClick={() => { setEraDropdownOpen(!eraDropdownOpen); setTypeDropdownOpen(false); setUpgradeDropdownOpen(false); }}
            >
              Era{selectedEras.size > 0 ? ` (${selectedEras.size})` : ''} ▾
            </button>
            {eraDropdownOpen && (
              <div className="filter-panel">
                <button className="filter-clear" onClick={() => setSelectedEras(new Set())}>Clear all</button>
                {allEras.map(era => (
                  <label key={era} className="filter-option">
                    <input
                      type="checkbox"
                      checked={selectedEras.has(era)}
                      onChange={() => setSelectedEras(toggleSet(selectedEras, era))}
                    />
                    {era}
                  </label>
                ))}
              </div>
            )}
          </div>
          <label>
            Search:
            <input
              type="text"
              placeholder="Filter by name..."
              onChange={e => {
                setColumnFilters([{ id: 'name', value: e.target.value }]);
              }}
            />
          </label>
        </div>
      </div>

      <div className="table-scroll">
        <table className="building-table">
          <thead>
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>
                {hg.headers.map(header => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className={header.column.getCanSort() ? 'sortable' : ''}
                  >
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
                <tr
                  key={row.id}
                  onClick={() => setExpandedId(expandedId === row.original.id ? null : row.original.id)}
                  className={expandedId === row.original.id ? 'expanded' : ''}
                >
                  {row.getVisibleCells().map(cell => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
                {expandedId === row.original.id && (
                  <tr key={`${row.id}-detail`} className="detail-row">
                    <td colSpan={columns.length}>
                      <BuildingDetail entries={row.original.entries} data={data} />
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

function BuildingDetail({ entries, data }: { entries: CityMapEntry[]; data: CityData }) {
  const entry = entries[0];
  const totalProd: { base: ResourceMap; motivated: ResourceMap; guildBase: ResourceMap; guildMotivated: ResourceMap } = { base: {}, motivated: {}, guildBase: {}, guildMotivated: {} };
  for (const e of entries) {
    const p = getBuildingProduction(e);
    addResources(totalProd.base, p.base);
    addResources(totalProd.motivated, p.motivated);
    addResources(totalProd.guildBase, p.guildBase);
    addResources(totalProd.guildMotivated, p.guildMotivated);
  }
  const entity = data.CityEntities?.[entry.cityentity_id];

  return (
    <div className="building-detail">
      <div className="detail-grid">
        <div className="detail-section">
          <h4>Building Info</h4>
          <p><strong>Entity ID:</strong> {entry.cityentity_id}</p>
          {entries.length > 1 && <p><strong>Count:</strong> {entries.length} identical buildings</p>}
          <p><strong>Size:</strong> {entity ? getBuildingSize(entity) : 'Unknown'}</p>
          {entry.level !== undefined && <p><strong>Level:</strong> {entry.level}{entry.max_level ? ` / ${entry.max_level}` : ''}</p>}
          {entry.bonus && <p><strong>Bonus:</strong> {entry.bonus.value} {formatResourceName(entry.bonus.type)}</p>}
          {entry.state.forge_points_for_level_up !== undefined && (
            <p><strong>FP to next level:</strong> {formatNumber(entry.state.forge_points_for_level_up)}</p>
          )}
          {entries.length > 1 && (
            <div style={{ marginTop: '0.5rem' }}>
              <strong>Positions:</strong>
              <div className="positions-list">{entries.map(e => <span key={e.id} className="pos-tag">({e.x},{e.y})</span>)}</div>
            </div>
          )}
        </div>

        <div className="detail-section">
          <h4>Base Production{entries.length > 1 ? ' (all combined)' : ''}</h4>
          {Object.keys(totalProd.base).length > 0 ? (
            <ul>
              {Object.entries(totalProd.base).map(([k, v]) => (
                <li key={k}>{formatNumber(v)} {formatResourceName(k)}</li>
              ))}
            </ul>
          ) : <p className="muted">None</p>}
        </div>

        {Object.keys(totalProd.motivated).length > 0 && (
          <div className="detail-section">
            <h4>Motivated Bonus{entries.length > 1 ? ' (all combined)' : ''}</h4>
            <ul>
              {Object.entries(totalProd.motivated).map(([k, v]) => (
                <li key={k}>+{formatNumber(v)} {formatResourceName(k)}</li>
              ))}
            </ul>
          </div>
        )}

        {(Object.keys(totalProd.guildBase).length > 0 || Object.keys(totalProd.guildMotivated).length > 0) && (
          <div className="detail-section">
            <h4>Guild Resources{entries.length > 1 ? ' (all combined)' : ''}</h4>
            <ul>
              {Object.entries({ ...totalProd.guildBase, ...totalProd.guildMotivated }).map(([k, v]) => (
                <li key={k}>{formatNumber(v)} {formatResourceName(k)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
