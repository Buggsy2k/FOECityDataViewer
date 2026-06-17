import { useMemo } from 'react';
import { useCityData } from '../context/CityDataContext';
import { aggregateProduction, formatNumber, formatResourceName } from '../utils/dataProcessing';

interface MetricCardProps {
  label: string;
  value: string;
}

function MetricCard({ label, value }: MetricCardProps) {
  return (
    <div className="dashboard-metric-card">
      <div className="dashboard-metric-label">{label}</div>
      <div className="dashboard-metric-value">{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const { data } = useCityData();

  const summary = useMemo(() => {
    if (!data) return null;

    const entries = Object.values(data.CityMapData).filter(e => e.id < 2_000_000_000);
    const agg = aggregateProduction(data);

    const totalBuildings = entries.filter(e => e.type !== 'street').length;
    const streets = entries.filter(e => e.type === 'street').length;
    const greatBuildings = entries.filter(e => e.type === 'greatbuilding').length;

    const topDaily = Object.entries(agg.total)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    const topGuildDaily = Object.entries(agg.guildTotal)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    return {
      totalBuildings,
      streets,
      greatBuildings,
      dailyFP: agg.total.strategy_points || 0,
      dailyCoins: agg.total.money || 0,
      dailySupplies: agg.total.supplies || 0,
      topDaily,
      topGuildDaily,
    };
  }, [data]);

  if (!summary) return null;

  return (
    <div className="dashboard-summary">
      <h2>City Dashboard</h2>

      <div className="dashboard-metric-grid">
        <MetricCard label="Total Buildings" value={formatNumber(summary.totalBuildings)} />
        <MetricCard label="Streets" value={formatNumber(summary.streets)} />
        <MetricCard label="Great Buildings" value={formatNumber(summary.greatBuildings)} />
        <MetricCard label="Daily FP" value={formatNumber(summary.dailyFP)} />
        <MetricCard label="Daily Coins" value={formatNumber(summary.dailyCoins)} />
        <MetricCard label="Daily Supplies" value={formatNumber(summary.dailySupplies)} />
      </div>

      <div className="dashboard-sections">
        <section className="dashboard-section-card">
          <h3>Top Daily Production</h3>
          {summary.topDaily.length === 0 ? (
            <p className="dashboard-muted">No daily production detected.</p>
          ) : (
            <ul className="dashboard-list">
              {summary.topDaily.map(([resource, value]) => (
                <li key={resource}>
                  <span>{formatResourceName(resource)}</span>
                  <strong>{formatNumber(value)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dashboard-section-card">
          <h3>Top Guild Production</h3>
          {summary.topGuildDaily.length === 0 ? (
            <p className="dashboard-muted">No guild production detected.</p>
          ) : (
            <ul className="dashboard-list">
              {summary.topGuildDaily.map(([resource, value]) => (
                <li key={resource}>
                  <span>{formatResourceName(resource)}</span>
                  <strong>{formatNumber(value)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
