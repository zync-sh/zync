import { MainLayout } from './components/layout/MainLayout';
// v2 Trigger
import { UpdateNotification } from './components/UpdateNotification';
import { ToastContainer } from './components/ToastContainer';
import { TransferManager } from './components/file-manager/TransferManager';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';

import { WelcomeScreen } from './components/dashboard/WelcomeScreen';

import { useTransferEvents } from './hooks/useTransferEvents';

function AppContent() {
    const showToast = useAppStore((state) => state.showToast);
    const loadConnections = useAppStore(state => state.loadConnections);
    const loadSettings = useAppStore(state => state.loadSettings);

    useTransferEvents();

    useEffect(() => {
        showToast('info', 'Welcome to SSH UI');
        // Initialize State
        loadConnections();
        loadSettings();
    }, []);

    return (
        <>
            <MainLayout>
                <WelcomeScreen />
            </MainLayout>
            <UpdateNotification />
            <TransferManager />
            <ToastContainer />
        </>
    );
}

import { ErrorBoundary } from './components/ErrorBoundary';

import { PluginProvider } from './context/PluginContext';

function App() {
    return (
        <ErrorBoundary>
            <PluginProvider>
                <AppContent />
            </PluginProvider>
        </ErrorBoundary>
    );
}

export default App;
