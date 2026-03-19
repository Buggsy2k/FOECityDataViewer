import { useMemo } from 'react';
import { useCityData } from '../context/CityDataContext';
import {
  aggregateProduction,
  formatResourceName,
  formatNumber,
  getResourceCategory,
  type AggregatedResources,
} from '../utils/dataProcessing';

function ResourceCard({ name, base, motivated }: { name: string; base: number; motivated: number }) {
  const total = base + motivated;
  return (
    <div className="resource-card">
      <div className="resource-name">{formatResourceName(name)}</div>
      <div className="resource-total">{formatNumber(total)}</div>
      {motivated > 0 && (
        <div className="resource-breakdown">
          <span className="base">{formatNumber(base)} base</span>
          <span className="motivated">+{formatNumber(motivated)} mot.</span>
        </div>
      )}
    </div>
  );
}

function ResourceSection({ title, resources, agg }: {
  title: string;
  resources: string[];
  agg: AggregatedResources;
}) {
  if (resources.length === 0) return null;
  return (
    <div className="resource-section">
      <h3>{title}</h3>
      <div className="resource-grid">
        {resources.map(r => (
          <ResourceCard
            key={r}
            name={r}
            base={agg.base[r] || 0}
            motivated={agg.motivated[r] || 0}
          />
        ))}
      </div>
    </div>
  );
}

export default function ProductionSummary() {
  const { data } = useCityData();

  const agg = useMemo(() => data ? aggregateProduction(data) : null, [data]);

  const grouped = useMemo(() => {
    if (!agg) return {};
    const allResources = Object.keys(agg.total);
    const groups: Record<string, string[]> = {};
    for (const r of allResources) {
      const cat = getResourceCategory(r);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(r);
    }
    // Sort each group by total production descending
    for (const resources of Object.values(groups)) {
      resources.sort((a, b) => (agg.total[b] || 0) - (agg.total[a] || 0));
    }
    return groups;
  }, [agg]);

  const guildGrouped = useMemo(() => {
    if (!agg) return {};
    const allResources = Object.keys(agg.guildTotal);
    if (allResources.length === 0) return {};
    const result: Record<string, string[]> = { 'Guild Resources': allResources };
    allResources.sort((a, b) => (agg.guildTotal[b] || 0) - (agg.guildTotal[a] || 0));
    return result;
  }, [agg]);

  if (!agg) return null;

  // Order categories: Core first, then alphabetical
  const categoryOrder = ['Core', ...Object.keys(grouped).filter(c => c !== 'Core').sort()];

  return (
    <div className="production-summary">
      <h2>Daily Production Summary</h2>

      {categoryOrder.map(cat => (
        grouped[cat] ? (
          <ResourceSection key={cat} title={cat} resources={grouped[cat]} agg={agg} />
        ) : null
      ))}

      {Object.keys(guildGrouped).length > 0 && (
        <div className="resource-section">
          <h3>Guild Resources</h3>
          <div className="resource-grid">
            {Object.keys(agg.guildTotal)
              .sort((a, b) => (agg.guildTotal[b] || 0) - (agg.guildTotal[a] || 0))
              .map(r => (
                <ResourceCard
                  key={`guild-${r}`}
                  name={r}
                  base={agg.guildBase[r] || 0}
                  motivated={agg.guildMotivated[r] || 0}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
