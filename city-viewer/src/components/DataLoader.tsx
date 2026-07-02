import { useCallback, useRef, useState } from 'react';
import { useCityData } from '../context/CityDataContext';
import type { CityData } from '../types/citydata';

export default function DataLoader() {
  const { isLoading, setIsLoading, setData, hasRestorableState, restorePersistedState, clearPersistedState } = useCityData();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteArmed, setPasteArmed] = useState(false);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleQuickPaste = useCallback((e: React.ClipboardEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (isLoading) return;

    const text = e.clipboardData?.getData('text') ?? '';
    if (!text.trim()) {
      setError('Clipboard paste was empty.');
      return;
    }

    setIsLoading(true);
    // Let the loading UI paint before parsing very large JSON text.
    window.setTimeout(() => {
      try {
        parseAndLoad(text);
        setPasteArmed(false);
        pasteButtonRef.current?.blur();
      } finally {
        setIsLoading(false);
      }
    }, 0);
  }, [isLoading, parseAndLoad, setIsLoading]);

  const handleRestore = useCallback(() => {
    if (isLoading) return;

    setIsLoading(true);
    // Let the loading UI paint before restoring potentially large state.
    window.setTimeout(() => {
      void (async () => {
        try {
          const restored = await restorePersistedState();
          if (!restored) {
            setError('Saved session could not be restored. Please load city data manually.');
            return;
          }
          setError(null);
        } finally {
          setIsLoading(false);
        }
      })();
    }, 0);
  }, [isLoading, restorePersistedState, setIsLoading]);

  return (
    <div className="data-loader">
      <div className="loader-content">
        <h1>FOE City Data Viewer</h1>
        <p className="subtitle">Forge of Empires City Analysis Tool</p>

        <div className="loader-actions">
          {hasRestorableState && (
            <button
              type="button"
              autoFocus
              className="paste-button restore-button"
              onClick={handleRestore}
              disabled={isLoading}
              title="Restore your last successfully loaded city state"
            >
              Restore Previous Session
            </button>
          )}
          <button
            ref={pasteButtonRef}
            type="button"
            autoFocus={!hasRestorableState}
            className={`paste-button${pasteArmed ? ' paste-armed' : ''}`}
            title={pasteArmed ? 'Press Ctrl+V (or your system paste shortcut) to load city data now' : undefined}
            onClick={() => {
              setError(null);
              setPasteArmed(true);
              pasteButtonRef.current?.focus();
            }}
            onBlur={() => setPasteArmed(false)}
            onPaste={handleQuickPaste}
            disabled={isLoading}
          >
            {pasteArmed ? 'Paste Now' : 'Manual Paste'}
          </button>
          <button
            className="paste-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            title="Browse for a citydata.json file"
          >
            Browse Files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleInputChange}
            disabled={isLoading}
            hidden
          />
        </div>

        {hasRestorableState && (
          <div className="loader-secondary-actions">
            <button
              type="button"
              className="clear-session-btn"
              onClick={() => {
                void clearPersistedState();
              }}
              disabled={isLoading}
              title="Remove the locally saved session"
            >
              Clear saved session
            </button>
          </div>
        )}

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
        </div>

        {error && <div className="error-message">{error}</div>}
      </div>
    </div>
  );
}
