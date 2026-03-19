import { useState, useMemo, useCallback, useRef } from 'react';

interface JsonNodeProps {
  label: string;
  value: unknown;
  depth: number;
  defaultOpen: boolean;
  searchTerm: string;
}

function matchesSearch(value: unknown, term: string): boolean {
  if (!term) return true;
  const lower = term.toLowerCase();
  if (value === null || value === undefined) return 'null'.includes(lower);
  if (typeof value === 'string') return value.toLowerCase().includes(lower);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase().includes(lower);
  if (Array.isArray(value)) return value.some(v => matchesSearch(v, term));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => k.toLowerCase().includes(lower) || matchesSearch(v, term)
    );
  }
  return false;
}

function JsonNode({ label, value, depth, defaultOpen, searchTerm }: JsonNodeProps) {
  const [open, setOpen] = useState(defaultOpen);

  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);

  const labelMatches = searchTerm && label.toLowerCase().includes(searchTerm.toLowerCase());

  if (!isObject) {
    // Leaf value
    const valueStr = value === null ? 'null'
      : typeof value === 'string' ? `"${value}"`
      : String(value);

    const valueMatches = searchTerm && valueStr.toLowerCase().includes(searchTerm.toLowerCase());

    return (
      <div className="json-leaf" style={{ paddingLeft: depth * 16 }}>
        <span className={`json-key ${labelMatches ? 'json-highlight' : ''}`}>{label}</span>
        <span className="json-colon">: </span>
        <span className={`json-value json-${typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'null'} ${valueMatches ? 'json-highlight' : ''}`}>
          {valueStr}
        </span>
      </div>
    );
  }

  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  const filteredEntries = searchTerm
    ? entries.filter(([k, v]) => k.toLowerCase().includes(searchTerm.toLowerCase()) || matchesSearch(v, searchTerm))
    : entries;

  const bracket = isArray ? ['[', ']'] : ['{', '}'];
  const count = entries.length;

  return (
    <div className="json-node">
      <div
        className="json-branch"
        style={{ paddingLeft: depth * 16 }}
        onClick={() => setOpen(!open)}
      >
        <span className="json-toggle">{open ? '▼' : '▶'}</span>
        <span className={`json-key ${labelMatches ? 'json-highlight' : ''}`}>{label}</span>
        <span className="json-colon">: </span>
        <span className="json-bracket">{bracket[0]}</span>
        {!open && (
          <span className="json-preview">
            {' '}{count} {count === 1 ? 'item' : 'items'}{' '}
          </span>
        )}
        {!open && <span className="json-bracket">{bracket[1]}</span>}
      </div>
      {open && (
        <>
          {filteredEntries.map(([k, v]) => (
            <JsonNode
              key={k}
              label={k}
              value={v}
              depth={depth + 1}
              defaultOpen={depth < 0}
              searchTerm={searchTerm}
            />
          ))}
          {filteredEntries.length < entries.length && (
            <div className="json-leaf json-filtered-count" style={{ paddingLeft: (depth + 1) * 16 }}>
              ... {entries.length - filteredEntries.length} hidden by search filter
            </div>
          )}
          <div style={{ paddingLeft: depth * 16 }}>
            <span className="json-bracket">{bracket[1]}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function JsonViewer() {
  const [json, setJson] = useState<Record<string, unknown> | unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [inputMode, setInputMode] = useState<'paste' | 'file'>('file');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadJson = useCallback((text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        setJson(parsed);
        setError(null);
      } else {
        setError('JSON must be an object or array');
        setJson(null);
      }
    } catch {
      setError('Invalid JSON');
      setJson(null);
    }
  }, []);

  const handleFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => loadJson(reader.result as string);
    reader.onerror = () => setError('Failed to read file');
    reader.readAsText(file);
  }, [loadJson]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const topKeys = useMemo(() => {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    return Object.keys(json as Record<string, unknown>);
  }, [json]);

  return (
    <div className="json-viewer-container">
      <h2>JSON Viewer</h2>

      {!json && (
        <div className="json-input-area">
          <div className="json-input-tabs">
            <button
              className={`json-input-tab ${inputMode === 'file' ? 'active' : ''}`}
              onClick={() => setInputMode('file')}
            >
              Open File
            </button>
            <button
              className={`json-input-tab ${inputMode === 'paste' ? 'active' : ''}`}
              onClick={() => setInputMode('paste')}
            >
              Paste JSON
            </button>
          </div>

          {inputMode === 'file' && (
            <div
              className="json-drop-zone"
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
            >
              <p>Drag & drop a JSON file here</p>
              <p className="or">or</p>
              <label className="file-button">
                Browse Files
                <input type="file" accept=".json" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} hidden />
              </label>
            </div>
          )}

          {inputMode === 'paste' && (
            <div className="json-paste-area">
              <textarea
                ref={textareaRef}
                placeholder="Paste JSON here..."
                rows={12}
                className="json-textarea"
              />
              <button className="json-parse-btn" onClick={() => {
                if (textareaRef.current) loadJson(textareaRef.current.value);
              }}>
                Parse JSON
              </button>
            </div>
          )}

          {error && <div className="error-message">{error}</div>}
        </div>
      )}

      {json && (
        <>
          <div className="json-toolbar">
            <input
              type="text"
              placeholder="Search keys & values..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="json-search"
            />
            {topKeys && <span className="json-info">{topKeys.length} top-level keys</span>}
            <button className="json-clear-btn" onClick={() => { setJson(null); setSearchTerm(''); setError(null); }}>
              Close
            </button>
          </div>

          <div className="json-tree">
            {typeof json === 'object' && !Array.isArray(json) ? (
              Object.entries(json as Record<string, unknown>).map(([k, v]) => (
                <JsonNode
                  key={k}
                  label={k}
                  value={v}
                  depth={0}
                  defaultOpen={false}
                  searchTerm={searchTerm}
                />
              ))
            ) : (
              <JsonNode label="root" value={json} depth={0} defaultOpen={true} searchTerm={searchTerm} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
