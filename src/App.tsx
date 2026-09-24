import { MainLayout } from './components/layout/MainLayout';
import { ToastContainer } from './components/ui/Toast';
import { NotificationCenter } from './components/notifications/NotificationCenter';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { useVaultStore } from './vault/useVaultStore';
import { WelcomeScreen } from './components/dashboard/WelcomeScreen';
import { useTransferEvents } from './hooks/useTransferEvents';
import { useAutoUpdater } from './features/updater';
import { setUsageEnabled, startUsageLifecycle } from './features/usage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PluginProvider } from './context/PluginContext';
import { GlobalConfirmDialog } from './components/ui/GlobalConfirmDialog';
import { GlobalVaultUnlockModal } from './components/vault/GlobalVaultUnlockModal';
import { GlobalKeyPassphraseModal } from './components/connections/GlobalKeyPassphraseModal';
import { GlobalAgentSignatureDialog } from './components/connections/GlobalAgentSignatureDialog';
import { GlobalConnectionsRestorePreviewModal } from './components/vault/GlobalConnectionsRestorePreviewModal';
import * as RadixTooltip from '@radix-ui/react-tooltip';

type ConnectionMetadataPayload = {
    connectionId?: string;
    detectedOs?: string | null;
    detectedShell?: string | null;
};

function AppContent() {
    const loadConnections = useAppStore((state) => state.loadConnections);
    const loadSettings = useAppStore((state) => state.loadSettings);
    const loadNotificationHistory = useAppStore((state) => state.loadNotificationHistory);
    const loadSession = useAppStore((state) => state.loadSession);
    const fetchSystemInfo = useAppStore((state) => state.fetchSystemInfo);
    const refreshVault = useVaultStore((state) => state.refresh);

    useTransferEvents();
    useAutoUpdater();

    useEffect(() => window.ipcRenderer.on(
        'connection:metadata',
        (_event, payload: ConnectionMetadataPayload) => {
            if (!payload?.connectionId) return;
            useAppStore.getState().applyConnectionMetadata(payload.connectionId, payload.detectedOs);
        },
    ), []);

    useEffect(() => {
        // Initialize State — order matters: connections must load before session
        // so that restored terminal tabs can reference valid connection IDs.
        const init = async () => {
            try {
                await Promise.all([loadConnections(), loadSettings()]);
                loadNotificationHistory();
            } finally {
                // loadSession must always run — it sets sessionLoaded which gates the UI.
                await loadSession();
            }
            try {
                await fetchSystemInfo();
            } catch (e) {
                console.warn('[App] fetchSystemInfo failed:', e);
            }
            refreshVault().catch(e => console.warn('[App] refreshVault failed:', e));
            const shareUsage = useAppStore.getState().settings.privacy.shareAnonymousUsage !== false;
            setUsageEnabled(shareUsage);
            if (shareUsage) startUsageLifecycle();
        };
        init().catch(e => console.warn('[App] Initialisation error:', e));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- store actions are stable
    }, []);

    return (
        <>
            <MainLayout>
                <WelcomeScreen />
            </MainLayout>

            <ToastContainer />
            <NotificationCenter />
        </>
    );
}



function App() {
    return (
        <ErrorBoundary>
            <PluginProvider>
                <RadixTooltip.Provider delayDuration={120}>
                    <AppContent />
                    <GlobalConfirmDialog />
                    <GlobalVaultUnlockModal />
                    <GlobalKeyPassphraseModal />
                    <GlobalAgentSignatureDialog />
                    <GlobalConnectionsRestorePreviewModal />
                </RadixTooltip.Provider>
            </PluginProvider>
        </ErrorBoundary>
    );
}

export default App;
