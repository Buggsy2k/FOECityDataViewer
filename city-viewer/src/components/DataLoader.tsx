import { useCallback, useState } from 'react';
import { useCityData } from '../context/CityDataContext';
import type { CityData } from '../types/citydata';

export default function DataLoader() {
  const { setData } = useCityData();
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
    const reader = new FileReader();
    reader.onload = () => parseAndLoad(reader.result as string);
    reader.onerror = () => setError('Failed to read file');
    reader.readAsText(file);
  }, [parseAndLoad]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="data-loader">
      <div className="loader-content">
        <h1>FOE City Data Viewer</h1>
        <p className="subtitle">Forge of Empires City Analysis Tool</p>

        <div
          className={`drop-zone ${dragging ? 'dragging' : ''}`}
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
        >
          <div className="drop-icon">📁</div>
          <p>Drag & drop your <strong>citydata.json</strong> here</p>
          <p className="or">or</p>
          <label className="file-button">
            Browse Files
            <input
              type="file"
              accept=".json"
              onChange={handleInputChange}
              hidden
            />
          </label>
        </div>

        {error && <div className="error-message">{error}</div>}
      </div>
    </div>
  );
}
