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
    const loadSession = useAppStore((state) => state.loadSession);
    const fetchSystemInfo = useAppStore((state) => state.fetchSystemInfo);

    useTransferEvents();

    useEffect(() => {
        // Initialize State — order matters: connections must load before session
        // so that restored terminal tabs can reference valid connection IDs.
        const init = async () => {
            try {
                await Promise.all([loadConnections(), loadSettings()]);
            } finally {
                // loadSession must always run — it sets sessionLoaded which gates the UI.
                await loadSession();
            }
            fetchSystemInfo();
        };
        init().catch(e => console.warn('[App] Initialisation error:', e));
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
