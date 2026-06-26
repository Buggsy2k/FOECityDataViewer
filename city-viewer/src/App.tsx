import { useState, useCallback, useRef, useEffect } from 'react';
import { useCityData } from './context/CityDataContext';
import DataLoader from './components/DataLoader';
import Dashboard from './components/Dashboard';
import ProductionSummary from './components/ProductionSummary';
import BuildingTable from './components/BuildingTable';
import CityGrid from './components/CityGrid';
import CityDesigner from './components/CityDesigner';
import GreatBuildings from './components/GreatBuildings';
import MilitaryTable from './components/MilitaryTable';
import LayoutOptimizer from './components/LayoutOptimizer';
import type { CityData } from './types/citydata';
import './App.css';

type Tab = 'dashboard' | 'production' | 'buildings' | 'military' | 'grid' | 'designer' | 'greatbuildings' | 'optimizer';

function AppContent() {
  const { data, dataVersion, isLoading, setIsLoading, setData } = useCityData();
  const [activeTab, setActiveTab] = useState<Tab>('designer');
  const [dragOver, setDragOver] = useState(false);
  const [designerFullscreen, setDesignerFullscreen] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteArmed, setPasteArmed] = useState(false);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const preserveTabOnNextDataLoadRef = useRef(false);

  useEffect(() => {
    if (!data) return;
    const preserveActiveTab = preserveTabOnNextDataLoadRef.current;
    preserveTabOnNextDataLoadRef.current = false;
    if (!preserveActiveTab) {
      setActiveTab('designer');
    }
    setDragOver(false);
    setDesignerFullscreen(false);
    setPasteArmed(false);
    setPasteError(null);
  }, [dataVersion, data]);

  const loadFile = useCallback((file: File) => {
    setIsLoading(true);
    setPasteError(null);
    preserveTabOnNextDataLoadRef.current = false;
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

  const loadFromText = useCallback((text: string): boolean => {
    try {
      const json = JSON.parse(text) as CityData;
      if (!json.CityMapData) {
        setPasteError('Invalid JSON: missing CityMapData.');
        return false;
      }
      setPasteError(null);
      preserveTabOnNextDataLoadRef.current = true;
      setData(json);
      return true;
    } catch {
      setPasteError('Failed to parse JSON from clipboard.');
      return false;
    }
  }, [setData]);

  const handleQuickPaste = useCallback((e: React.ClipboardEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (isLoading) return;

    const text = e.clipboardData?.getData('text') ?? '';
    if (!text.trim()) {
      setPasteError('Clipboard paste was empty.');
      return;
    }

    setIsLoading(true);
    // Let the loading UI paint before parsing very large JSON text.
    window.setTimeout(() => {
      try {
        loadFromText(text);
        setPasteArmed(false);
        pasteButtonRef.current?.blur();
      } finally {
        setIsLoading(false);
      }
    }, 0);
  }, [isLoading, loadFromText, setIsLoading]);

  if (!data) return <DataLoader />;

  return (
    <div className={`app${designerFullscreen ? ' designer-fullscreen' : ''}${isLoading ? ' app-loading' : ''}`}>
      <header className="app-header">
        <div className="header-left">
          <h1>FOE City Viewer</h1>
        </div>

        <nav className="tab-nav">
          {([
            ['dashboard', '📈 Dashboard'],
            ['designer', '🧩 City Designer'],
            ['grid', '🗺️ Grid Map'],
            ['buildings', '🏠 Buildings'],
            ['greatbuildings', '🏛️ Great Buildings'],
            ['military', '⚔️ Military Units'],
            ['production', '📊 Production'],
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

        <div
          className={`reset-drop-zone ${dragOver ? 'drag-over' : ''}`}
          onDrop={e => {
            e.preventDefault();
            if (isLoading) return;
            setDragOver(false);
            setPasteError(null);
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
          <div className="header-actions">
            <button
              ref={pasteButtonRef}
              className={`reset-btn${pasteArmed ? ' paste-armed' : ''}`}
              title={pasteArmed ? 'Press Ctrl+V (or your system paste shortcut) to load city data now' : undefined}
              disabled={isLoading}
              onClick={() => {
                setPasteError(null);
                setPasteArmed(true);
                pasteButtonRef.current?.focus();
              }}
              onFocus={() => setPasteArmed(true)}
              onBlur={() => setPasteArmed(false)}
              onPaste={handleQuickPaste}
            >
              📝 {pasteArmed ? 'Paste Now' : 'Manual Paste'}
            </button>
            <button className="reset-btn" disabled={isLoading} onClick={() => fileInputRef.current?.click()}>
              📂 Load New File
            </button>
          </div>
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

      {pasteError && <div className="paste-error-banner">{pasteError}</div>}

      <main className="main-content" key={dataVersion}>
        {activeTab === 'dashboard' && <Dashboard />}
        {activeTab === 'production' && <ProductionSummary />}
        {activeTab === 'buildings' && <BuildingTable />}
        {activeTab === 'military' && <MilitaryTable />}
        {activeTab === 'grid' && <CityGrid />}
        <div className="designer-tab-pane" style={{ display: activeTab === 'designer' ? 'flex' : 'none' }}>
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
