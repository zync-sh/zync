import { MainLayout } from './components/layout/MainLayout';
import { ConnectionProvider } from './context/ConnectionContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { TransferProvider } from './context/TransferContext';
import { FileManager } from './components/FileManager';
import { TransferManager } from './components/file-manager/TransferManager';
import { useEffect } from 'react';

function AppContent() {
    const { showToast } = useToast();

    useEffect(() => {
        showToast('info', 'Welcome to SSH UI');
    }, []);

    return (
        <ConnectionProvider>
            <TransferProvider>
                <MainLayout>
                    <FileManager />
                </MainLayout>
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
