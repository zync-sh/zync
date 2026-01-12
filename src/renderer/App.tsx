import { MainLayout } from './components/layout/MainLayout';
import { UpdateNotification } from './components/UpdateNotification';
import { ToastContainer } from './components/ToastContainer';
import { TransferManager } from './components/file-manager/TransferManager';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';

import { WelcomeScreen } from './components/dashboard/WelcomeScreen';

function AppContent() {
    const showToast = useAppStore((state) => state.showToast);
    const loadConnections = useAppStore(state => state.loadConnections);
    const loadSettings = useAppStore(state => state.loadSettings);

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

function App() {
    return (
        <ErrorBoundary>
            <AppContent />
        </ErrorBoundary>
    );
}

export default App;
