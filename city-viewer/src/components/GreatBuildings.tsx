import { useMemo, useState } from 'react';
import { useCityData } from '../context/CityDataContext';
import { getGreatBuildings, formatResourceName, formatNumber, type GreatBuildingInfo } from '../utils/dataProcessing';

type SortKey = 'name' | 'level' | 'fpToNextLevel' | 'bonusValue';

export default function GreatBuildings() {
  const { data } = useCityData();
  const [sortBy, setSortBy] = useState<SortKey>('level');
  const [sortDesc, setSortDesc] = useState(true);

  const gbs = useMemo(() => {
    if (!data) return [];
    return getGreatBuildings(data);
  }, [data]);

  const sorted = useMemo(() => {
    const list = [...gbs];
    list.sort((a, b) => {
      const av = a[sortBy] ?? 0;
      const bv = b[sortBy] ?? 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
      }
      return sortDesc ? (bv as number) - (av as number) : (av as number) - (bv as number);
    });
    return list;
  }, [gbs, sortBy, sortDesc]);

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDesc(!sortDesc);
    } else {
      setSortBy(key);
      setSortDesc(true);
    }
  };

  if (!data) return null;

  const totalFP = gbs.reduce((sum, gb) => sum + (gb.dailyProduction.strategy_points || 0), 0);

  return (
    <div className="great-buildings-container">
      <div className="gb-header">
        <h2>Great Buildings ({gbs.length})</h2>
        {totalFP > 0 && <div className="gb-total-fp">Total daily FP from GBs: <strong>{totalFP}</strong></div>}
      </div>

      <div className="gb-sort-controls">
        Sort:
        {([
          ['level', 'Level'],
          ['fpToNextLevel', 'FP Cost'],
          ['bonusValue', 'Bonus'],
          ['name', 'Name'],
        ] as [SortKey, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`sort-btn ${sortBy === key ? 'active' : ''}`}
            onClick={() => handleSort(key)}
          >
            {label} {sortBy === key ? (sortDesc ? '▼' : '▲') : ''}
          </button>
        ))}
      </div>

      <div className="gb-grid">
        {sorted.map(gb => (
          <GBCard key={gb.entry.id} gb={gb} />
        ))}
      </div>
    </div>
  );
}

function GBCard({ gb }: { gb: GreatBuildingInfo }) {
  return (
    <div className="gb-card">
      <div className="gb-card-header">
        <h3>{gb.name}</h3>
        <span className="gb-level">Lv. {gb.level}</span>
      </div>

      {gb.bonusType !== 'none' && (
        <div className="gb-bonus">
          <span className="bonus-label">{formatResourceName(gb.bonusType)}</span>
          <span className="bonus-value">{gb.bonusValue}{gb.bonusType.includes('boost') ? '%' : ''}</span>
        </div>
      )}

      <div className="gb-fp">
        <span>FP to next level:</span>
        <strong>{formatNumber(gb.fpToNextLevel)}</strong>
      </div>

      {Object.keys(gb.dailyProduction).length > 0 && (
        <div className="gb-production">
          <span className="section-label">Daily Production</span>
          {Object.entries(gb.dailyProduction).map(([k, v]) => (
            <div key={k} className="gb-prod-item">
              {formatNumber(v)} {formatResourceName(k)}
            </div>
          ))}
        </div>
      )}

      {gb.clanGoods.length > 0 && (
        <div className="gb-production">
          <span className="section-label">Clan Goods</span>
          {gb.clanGoods.map(g => (
            <div key={g.good_id} className="gb-prod-item">
              {g.value} {formatResourceName(g.good_id)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
