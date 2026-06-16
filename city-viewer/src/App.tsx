import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useCityData } from './context/CityDataContext';
import DataLoader from './components/DataLoader';
import ProductionSummary from './components/ProductionSummary';
import BuildingTable from './components/BuildingTable';
import CityGrid from './components/CityGrid';
import CityDesigner from './components/CityDesigner';
import GreatBuildings from './components/GreatBuildings';
import MilitaryTable from './components/MilitaryTable';
import LayoutOptimizer from './components/LayoutOptimizer';
import { aggregateProduction, formatNumber } from './utils/dataProcessing';
import type { CityData } from './types/citydata';
import './App.css';

type Tab = 'production' | 'buildings' | 'military' | 'grid' | 'designer' | 'greatbuildings' | 'optimizer';

function AppContent() {
  const { data, dataVersion, isLoading, setIsLoading, setData } = useCityData();
  const [activeTab, setActiveTab] = useState<Tab>('production');
  const [dragOver, setDragOver] = useState(false);
  const [designerFullscreen, setDesignerFullscreen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    setActiveTab('production');
    setDragOver(false);
    setDesignerFullscreen(false);
  }, [dataVersion, data]);

  const loadFile = useCallback((file: File) => {
    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string) as CityData;
        if (json.CityMapData) setData(json);
      } catch { /* ignore bad file */ }
      finally { setIsLoading(false); }
    };
    reader.onerror = () => { setIsLoading(false); };
    reader.readAsText(file);
  }, [setData, setIsLoading]);

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
    <div className={`app${designerFullscreen ? ' designer-fullscreen' : ''}${isLoading ? ' app-loading' : ''}`}>
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
        <div
          className={`reset-drop-zone ${dragOver ? 'drag-over' : ''}`}
          onDrop={e => {
            e.preventDefault();
            if (isLoading) return;
            setDragOver(false);
            const f = e.dataTransfer.files[0];
            if (f) loadFile(f);
          }}
          onDragOver={e => {
            e.preventDefault();
            if (isLoading) return;
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
        >
          <button className="reset-btn" disabled={isLoading} onClick={() => fileInputRef.current?.click()}>
            📂 Load New File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            hidden
            disabled={isLoading}
            onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; }}
          />
        </div>
      </header>

      <nav className="tab-nav">
        {([
          ['production', '📊 Production'],
          ['buildings', '🏠 Buildings'],
          ['military', '⚔️ Military Units'],
          ['grid', '🗺️ Grid Map'],
          ['designer', '🧩 City Designer'],
          ['greatbuildings', '🏛️ Great Buildings'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`tab-btn ${activeTab === key ? 'active' : ''}`}
            onClick={() => { if (!isLoading) setActiveTab(key); }}
            disabled={isLoading}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="main-content" key={dataVersion}>
        {activeTab === 'production' && <ProductionSummary />}
        {activeTab === 'buildings' && <BuildingTable />}
        {activeTab === 'military' && <MilitaryTable />}
        {activeTab === 'grid' && <CityGrid />}
        <div style={{ display: activeTab === 'designer' ? 'block' : 'none' }}>
          <CityDesigner isFullscreen={designerFullscreen} onFullscreenChange={setDesignerFullscreen} />
        </div>
        {activeTab === 'greatbuildings' && <GreatBuildings />}
        {activeTab === 'optimizer' && <LayoutOptimizer />}
      </main>

      {isLoading && (
        <div className="app-loading-overlay" role="status" aria-live="polite" aria-label="Loading city data">
          <div className="app-loading-card">
            <div className="app-loading-spinner" aria-hidden="true" />
            <div>Loading city JSON...</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
