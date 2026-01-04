import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MainLayout } from './components/layout/MainLayout';
import { ConnectionProvider } from './context/ConnectionContext';
import { SettingsProvider } from './context/SettingsContext';
import { ToastProvider } from './context/ToastContext';
import './index.css';

import { TransferManager } from './components/file-manager/TransferManager';
import { TransferProvider } from './context/TransferContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <SettingsProvider>
        <ConnectionProvider>
          <TransferProvider>
            <MainLayout />
            <TransferManager />
          </TransferProvider>
        </ConnectionProvider>
      </SettingsProvider>
    </ToastProvider>
  </StrictMode>,
);
