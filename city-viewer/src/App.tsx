import { useState, useMemo } from 'react';
import { useCityData } from './context/CityDataContext';
import DataLoader from './components/DataLoader';
import ProductionSummary from './components/ProductionSummary';
import BuildingTable from './components/BuildingTable';
import CityGrid from './components/CityGrid';
import GreatBuildings from './components/GreatBuildings';
import MilitaryTable from './components/MilitaryTable';
import JsonViewer from './components/JsonViewer';
import { aggregateProduction, formatNumber } from './utils/dataProcessing';
import './App.css';

type Tab = 'production' | 'buildings' | 'military' | 'grid' | 'greatbuildings' | 'json';

function AppContent() {
  const { data, setData } = useCityData();
  const [activeTab, setActiveTab] = useState<Tab>('production');

  const stats = useMemo(() => {
    if (!data) return null;
    const entries = Object.values(data.CityMapData).filter(e => e.id < 2_000_000_000);
    const agg = aggregateProduction(data);
    const gbCount = entries.filter(e => e.type === 'greatbuilding').length;
    return {
      totalBuildings: entries.filter(e => e.type !== 'street').length,
      streets: entries.filter(e => e.type === 'street').length,
      greatBuildings: gbCount,
      dailyFP: agg.total.strategy_points || 0,
      dailyCoins: agg.total.money || 0,
      dailySupplies: agg.total.supplies || 0,
    };
  }, [data]);

  if (!data) return <DataLoader />;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>FOE City Viewer</h1>
        </div>
        <div className="header-stats">
          {stats && (
            <>
              <span className="stat"><strong>{stats.totalBuildings}</strong> buildings</span>
              <span className="stat"><strong>{stats.greatBuildings}</strong> GBs</span>
              <span className="stat fp-stat">⚡ <strong>{formatNumber(stats.dailyFP)}</strong> FP/day</span>
              <span className="stat">💰 <strong>{formatNumber(stats.dailyCoins)}</strong>/day</span>
              <span className="stat">📦 <strong>{formatNumber(stats.dailySupplies)}</strong>/day</span>
            </>
          )}
        </div>
        <button className="reset-btn" onClick={() => setData(null)}>Load New File</button>
      </header>

      <nav className="tab-nav">
        {([
          ['production', '📊 Production'],
          ['buildings', '🏠 Buildings'],
          ['military', '⚔️ Military Units'],
          ['grid', '🗺️ Grid Map'],
          ['greatbuildings', '🏛️ Great Buildings'],
          ['json', '{ } JSON'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`tab-btn ${activeTab === key ? 'active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {activeTab === 'production' && <ProductionSummary />}
        {activeTab === 'buildings' && <BuildingTable />}
        {activeTab === 'military' && <MilitaryTable />}
        {activeTab === 'grid' && <CityGrid />}
        {activeTab === 'greatbuildings' && <GreatBuildings />}
        {activeTab === 'json' && <JsonViewer />}
      </main>
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
