import { useCallback, useState } from 'react';
import { useCityData } from '../context/CityDataContext';
import type { CityData } from '../types/citydata';

export default function DataLoader() {
  const { isLoading, setIsLoading, setData } = useCityData();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const parseAndLoad = useCallback((text: string) => {
    try {
      const json = JSON.parse(text) as CityData;
      if (!json.CityMapData) {
        setError('Invalid file: missing CityMapData');
        return;
      }
      setError(null);
      setData(json);
    } catch {
      setError('Failed to parse JSON. Make sure the file is valid.');
    }
  }, [setData]);

  const handleFile = useCallback((file: File) => {
    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      parseAndLoad(reader.result as string);
      setIsLoading(false);
    };
    reader.onerror = () => {
      setError('Failed to read file');
      setIsLoading(false);
    };
    reader.readAsText(file);
  }, [parseAndLoad, setIsLoading]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile, isLoading]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (isLoading) return;
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile, isLoading]);

  const handlePasteData = useCallback(async () => {
    if (isLoading) return;
    if (!navigator.clipboard?.readText) {
      setError('Clipboard paste is not supported in this browser context.');
      return;
    }

    setIsLoading(true);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setError('Clipboard is empty. Copy citydata.json content and try again.');
        return;
      }
      parseAndLoad(text);
    } catch {
      setError('Unable to read clipboard. Allow clipboard access and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, parseAndLoad, setIsLoading]);

  return (
    <div className="data-loader">
      <div className="loader-content">
        <h1>FOE City Data Viewer</h1>
        <p className="subtitle">Forge of Empires City Analysis Tool</p>

        <div
          className={`drop-zone ${dragging ? 'dragging' : ''}${isLoading ? ' loading' : ''}`}
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); if (!isLoading) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
        >
          <div className="drop-icon">📁</div>
          <p>{isLoading ? 'Loading city JSON...' : <>Drag & drop your <strong>citydata.json</strong> here</>}</p>
          {!isLoading && <p className="or">or</p>}
          {isLoading && <div className="loader-inline-spinner" aria-hidden="true" />}
          <div className="loader-actions">
            <label className="file-button">
              Browse Files
              <input
                type="file"
                accept=".json"
                onChange={handleInputChange}
                disabled={isLoading}
                hidden
              />
            </label>
            <button type="button" className="paste-button" onClick={handlePasteData} disabled={isLoading}>
              Paste Data
            </button>
          </div>
        </div>

        {error && <div className="error-message">{error}</div>}
      </div>
    </div>
  );
}
