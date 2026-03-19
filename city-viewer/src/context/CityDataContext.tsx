import { createContext, useContext, useState, type ReactNode } from 'react';
import type { CityData } from '../types/citydata';

interface CityDataContextValue {
  data: CityData | null;
  setData: (data: CityData | null) => void;
}

const CityDataContext = createContext<CityDataContextValue | undefined>(undefined);

export function CityDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<CityData | null>(null);

  return (
    <CityDataContext.Provider value={{ data, setData }}>
      {children}
    </CityDataContext.Provider>
  );
}

export function useCityData(): CityDataContextValue {
  const ctx = useContext(CityDataContext);
  if (!ctx) throw new Error('useCityData must be used within CityDataProvider');
  return ctx;
}
