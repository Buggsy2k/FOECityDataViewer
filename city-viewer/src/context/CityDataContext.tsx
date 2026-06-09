import { createContext, useContext, useState, type ReactNode } from 'react';
import type { CityData } from '../types/citydata';

interface CityDataContextValue {
  data: CityData | null;
  dataVersion: number;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setData: (data: CityData | null) => void;
}

const CityDataContext = createContext<CityDataContextValue | undefined>(undefined);

export function CityDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<CityData | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const handleSetData = (nextData: CityData | null) => {
    setData(nextData);
    setDataVersion(prev => prev + 1);
  };

  return (
    <CityDataContext.Provider value={{ data, dataVersion, isLoading, setIsLoading, setData: handleSetData }}>
      {children}
    </CityDataContext.Provider>
  );
}

export function useCityData(): CityDataContextValue {
  const ctx = useContext(CityDataContext);
  if (!ctx) throw new Error('useCityData must be used within CityDataProvider');
  return ctx;
}
