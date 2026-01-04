import { useEffect } from 'react';
import { TransferManager } from './components/file-manager/TransferManager';
import { MainLayout } from './components/layout/MainLayout';
import { ConnectionProvider } from './context/ConnectionContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { TransferProvider } from './context/TransferContext';

function AppContent() {
  const { showToast } = useToast();

  useEffect(() => {
    showToast('info', 'Welcome to SSH UI');
  }, [showToast]);

  return (
    <ConnectionProvider>
      <TransferProvider>
        <MainLayout />
        <TransferManager />
      </TransferProvider>
    </ConnectionProvider>
  );
}

import { ErrorBoundary } from './components/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App;
