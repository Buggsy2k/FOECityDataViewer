import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CityData } from '../types/citydata';

const PERSISTED_CITY_STATE_MARKER_KEY = 'foe-city-viewer.persisted-city-state.v1';
const DESIGNER_SESSION_STORAGE_KEY = 'foe-city-designer-session-state.v1';
const DESIGNER_SESSION_DB_NAME = 'foe-city-designer';
const DESIGNER_SESSION_STORE_NAME = 'session';
const DESIGNER_SESSION_RECORD_KEY = 'latest';
const PERSISTED_CITY_DB_NAME = 'foe-city-viewer';
const PERSISTED_CITY_STORE_NAME = 'session';
const PERSISTED_CITY_STATE_RECORD_KEY = 'latest';

interface PersistedCityState {
  version: 1;
  savedAt: number;
  data: CityData;
}

function isCityData(value: unknown): value is CityData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CityData>;
  return Boolean(candidate.CityMapData && candidate.UnlockedAreas && candidate.CityEntities);
}

function readPersistedMarker(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(PERSISTED_CITY_STATE_MARKER_KEY) === '1';
}

function setPersistedMarker(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  if (enabled) {
    window.localStorage.setItem(PERSISTED_CITY_STATE_MARKER_KEY, '1');
    return;
  }
  window.localStorage.removeItem(PERSISTED_CITY_STATE_MARKER_KEY);
}

function openPersistedStateDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(PERSISTED_CITY_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PERSISTED_CITY_STORE_NAME)) {
        db.createObjectStore(PERSISTED_CITY_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

async function readPersistedCityState(): Promise<PersistedCityState | null> {
  try {
    const db = await openPersistedStateDb();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(PERSISTED_CITY_STORE_NAME, 'readonly');
      const store = tx.objectStore(PERSISTED_CITY_STORE_NAME);
      const request = store.get(PERSISTED_CITY_STATE_RECORD_KEY);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to read persisted state'));
      tx.oncomplete = () => db.close();
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Persisted state read transaction failed'));
      };
    });

    if (!result || typeof result !== 'object') return null;

    const parsed = result as Partial<PersistedCityState>;
    if (parsed.version !== 1 || !isCityData(parsed.data)) {
      await clearPersistedCityState();
      return null;
    }

    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

async function persistCityState(data: CityData | null): Promise<boolean> {
  if (!data) {
    await clearPersistedCityState();
    return false;
  }

  try {
    const db = await openPersistedStateDb();
    const payload: PersistedCityState = { version: 1, savedAt: Date.now(), data };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PERSISTED_CITY_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PERSISTED_CITY_STORE_NAME);
      const request = store.put(payload, PERSISTED_CITY_STATE_RECORD_KEY);

      request.onsuccess = () => {
        // wait for transaction completion
      };
      request.onerror = () => reject(request.error ?? new Error('Failed to write persisted state'));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Persisted state write transaction failed'));
      };
    });

    setPersistedMarker(true);
    return true;
  } catch {
    setPersistedMarker(false);
    return false;
  }
}

async function clearPersistedCityState(): Promise<void> {
  setPersistedMarker(false);
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(DESIGNER_SESSION_STORAGE_KEY);
  }

  if (typeof window !== 'undefined' && window.indexedDB) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = window.indexedDB.open(DESIGNER_SESSION_DB_NAME, 1);
        request.onupgradeneeded = () => {
          const nextDb = request.result;
          if (!nextDb.objectStoreNames.contains(DESIGNER_SESSION_STORE_NAME)) {
            nextDb.createObjectStore(DESIGNER_SESSION_STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open designer session DB'));
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DESIGNER_SESSION_STORE_NAME, 'readwrite');
        const store = tx.objectStore(DESIGNER_SESSION_STORE_NAME);
        const request = store.delete(DESIGNER_SESSION_RECORD_KEY);
        request.onsuccess = () => {
          // wait for transaction completion
        };
        request.onerror = () => reject(request.error ?? new Error('Failed to clear designer session state'));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('Designer session clear transaction failed'));
        };
      });
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }

  try {
    const db = await openPersistedStateDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PERSISTED_CITY_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PERSISTED_CITY_STORE_NAME);
      const request = store.delete(PERSISTED_CITY_STATE_RECORD_KEY);

      request.onsuccess = () => {
        // wait for transaction completion
      };
      request.onerror = () => reject(request.error ?? new Error('Failed to clear persisted state'));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Persisted state clear transaction failed'));
      };
    });
  } catch {
    // Ignore cleanup failures.
  }
}

interface CityDataContextValue {
  data: CityData | null;
  dataVersion: number;
  isLoading: boolean;
  hasRestorableState: boolean;
  setIsLoading: (loading: boolean) => void;
  setData: (data: CityData | null) => void;
  restorePersistedState: () => Promise<boolean>;
  clearPersistedState: () => Promise<void>;
}

const CityDataContext = createContext<CityDataContextValue | undefined>(undefined);

export function CityDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<CityData | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [hasRestorableState, setHasRestorableState] = useState(() => readPersistedMarker());

  useEffect(() => {
    void (async () => {
      const persisted = await readPersistedCityState();
      setHasRestorableState(persisted !== null);
    })();
  }, []);

  const handleSetData = (nextData: CityData | null) => {
    setData(nextData);
    setDataVersion(prev => prev + 1);
    if (!nextData) {
      void clearPersistedCityState();
      setHasRestorableState(false);
      return;
    }

    setHasRestorableState(true);
    void persistCityState(nextData).then(saved => {
      if (!saved) {
        setHasRestorableState(false);
      }
    });
  };

  const restorePersistedState = async (): Promise<boolean> => {
    const persisted = await readPersistedCityState();
    if (!persisted) {
      setHasRestorableState(false);
      return false;
    }

    setData(persisted.data);
    setDataVersion(prev => prev + 1);
    setHasRestorableState(true);
    return true;
  };

  const clearPersistedState = async (): Promise<void> => {
    await clearPersistedCityState();
    setHasRestorableState(false);
  };

  return (
    <CityDataContext.Provider
      value={{
        data,
        dataVersion,
        isLoading,
        hasRestorableState,
        setIsLoading,
        setData: handleSetData,
        restorePersistedState,
        clearPersistedState,
      }}
    >
      {children}
    </CityDataContext.Provider>
  );
}

export function useCityData(): CityDataContextValue {
  const ctx = useContext(CityDataContext);
  if (!ctx) throw new Error('useCityData must be used within CityDataProvider');
  return ctx;
}
