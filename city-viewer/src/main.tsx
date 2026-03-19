import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CityDataProvider } from './context/CityDataContext';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CityDataProvider>
      <App />
    </CityDataProvider>
  </StrictMode>,
);
