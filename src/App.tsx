import { MainLayout } from './components/layout/MainLayout';
import { UpdateNotification } from './components/UpdateNotification';
import { ToastContainer } from './components/ui/Toast';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { WelcomeScreen } from './components/dashboard/WelcomeScreen';
import { useTransferEvents } from './hooks/useTransferEvents';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PluginProvider } from './context/PluginContext';
import { GlobalConfirmDialog } from './components/ui/GlobalConfirmDialog';

function AppContent() {
    const loadConnections = useAppStore((state) => state.loadConnections);
    const loadSettings = useAppStore((state) => state.loadSettings);
    const fetchSystemInfo = useAppStore((state) => state.fetchSystemInfo);

    useTransferEvents();

    useEffect(() => {
        // Initialize State
        loadConnections();
        loadSettings();
        fetchSystemInfo();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- store actions are stable
    }, []);

    return (
        <>
            <MainLayout>
                <WelcomeScreen />
            </MainLayout>
            <UpdateNotification />

            <ToastContainer />
        </>
    );
}



function App() {
    return (
        <ErrorBoundary>
            <PluginProvider>
                <AppContent />
                <GlobalConfirmDialog />
            </PluginProvider>
        </ErrorBoundary>
    );
}

export default App;
