import { useCallback, useState } from 'react';
import {
  syncIpc,
  type SyncCollectionStatus,
  type SyncConnectionsRestoreArgs,
  type SyncConnectionsRestorePreviewResult,
  type SyncProviderStatus,
} from '../../../../../vault/syncIpc';
import {
  formatConnectionsRestoreSuccessMessage,
  normalizeConnectionsRestoreArgs,
  reportConnectionsRestoreWarnings,
} from '../../../../../vault/connectionsRestore';
import {
  getProviderActionBlockedMessage,
  getProviderReadiness,
} from '../../../../../vault/syncProviderGate';
import { parseSyncInvokeError } from '../../../../../vault/syncError';
import type { ToastType } from '../../../../../store/toastSlice';

interface UseConnectionsRestoreOptions {
  hostsSyncEnabled: boolean;
  googleSync: SyncProviderStatus | null;
  googleCollection: SyncCollectionStatus | null;
  showToast: (type: ToastType, message: string) => void;
  /** Shared readiness store patch (lastSync / clear lastError). */
  patchGoogleSync: (patch: Partial<SyncProviderStatus>) => void;
  onLoadConnections: () => Promise<void>;
  loadGoogleSync: () => Promise<void>;
  onReloadTunnels?: () => Promise<void>;
  onReloadSnippets?: () => Promise<void>;
}

export function useConnectionsRestore({
  hostsSyncEnabled,
  googleSync,
  googleCollection,
  showToast,
  patchGoogleSync,
  onLoadConnections,
  loadGoogleSync,
  onReloadTunnels,
  onReloadSnippets,
}: UseConnectionsRestoreOptions) {
  const [isPreviewingConnections, setIsPreviewingConnections] = useState(false);
  const [isRestoringConnections, setIsRestoringConnections] = useState(false);
  const [isConnectionsRestorePreviewOpen, setIsConnectionsRestorePreviewOpen] = useState(false);
  const [connectionsRestorePreview, setConnectionsRestorePreview] =
    useState<SyncConnectionsRestorePreviewResult | null>(null);
  const [pendingConnectionsRestoreArgs, setPendingConnectionsRestoreArgs] =
    useState<SyncConnectionsRestoreArgs | null>(null);

  const ensureConnectionsRestoreReady = useCallback((): boolean => {
    if (!hostsSyncEnabled) {
      showToast('error', 'Hosts sync is disabled. Enable hosts domain sync first.');
      return false;
    }
    const blockedMessage = getProviderActionBlockedMessage(
      getProviderReadiness(googleSync, googleCollection),
      'restore',
      'connections',
    );
    if (blockedMessage) {
      showToast('error', blockedMessage);
      return false;
    }
    return true;
  }, [googleCollection, googleSync, hostsSyncEnabled, showToast]);

  const runConnectionsRestore = useCallback(async (args: SyncConnectionsRestoreArgs) => {
    const normalizedArgs = normalizeConnectionsRestoreArgs(args);
    setIsRestoringConnections(true);
    try {
      const result = await syncIpc.connectionsRestore('google', normalizedArgs);
      patchGoogleSync({
        lastSync: result.syncedAt,
        lastError: undefined,
        lastErrorCode: undefined,
      });
      await onLoadConnections();
      await loadGoogleSync();
      await onReloadTunnels?.();
      await onReloadSnippets?.();

      const hostChanged = result.hosts.restored + result.hosts.updated;
      const tunnelChanged = (result.tunnels?.restored ?? 0) + (result.tunnels?.updated ?? 0);
      const snippetChanged =
        (result.hostSnippets?.restored ?? 0) + (result.hostSnippets?.updated ?? 0);

      showToast(
        hostChanged + tunnelChanged + snippetChanged > 0 ? 'success' : 'info',
        formatConnectionsRestoreSuccessMessage(result),
      );
      reportConnectionsRestoreWarnings(result, showToast);
      return true;
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Connection restore failed: ${msg}`);
      return false;
    } finally {
      setIsRestoringConnections(false);
    }
  }, [
    loadGoogleSync,
    onLoadConnections,
    onReloadSnippets,
    onReloadTunnels,
    patchGoogleSync,
    showToast,
  ]);

  const closeConnectionsRestorePreviewModal = useCallback(() => {
    if (isRestoringConnections || isPreviewingConnections) return;
    setIsConnectionsRestorePreviewOpen(false);
    setConnectionsRestorePreview(null);
    setPendingConnectionsRestoreArgs(null);
  }, [isPreviewingConnections, isRestoringConnections]);

  const confirmConnectionsRestore = useCallback(async () => {
    if (!pendingConnectionsRestoreArgs) return;
    const ok = await runConnectionsRestore(pendingConnectionsRestoreArgs);
    if (ok) {
      setIsConnectionsRestorePreviewOpen(false);
      setConnectionsRestorePreview(null);
      setPendingConnectionsRestoreArgs(null);
    }
  }, [pendingConnectionsRestoreArgs, runConnectionsRestore]);

  const handleRestoreConnections = useCallback(async (args: SyncConnectionsRestoreArgs = {}) => {
    if (!ensureConnectionsRestoreReady()) return;

    const normalizedArgs = normalizeConnectionsRestoreArgs(args);
    setIsPreviewingConnections(true);
    try {
      const preview = await syncIpc.connectionsRestorePreview('google', normalizedArgs);
      setConnectionsRestorePreview(preview);
      setPendingConnectionsRestoreArgs(normalizedArgs);
      setIsConnectionsRestorePreviewOpen(true);
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Connection restore preview failed: ${msg}`);
    } finally {
      setIsPreviewingConnections(false);
    }
  }, [ensureConnectionsRestoreReady, showToast]);

  return {
    isPreviewingConnections,
    isRestoringConnections,
    isConnectionsRestorePreviewOpen,
    connectionsRestorePreview,
    pendingConnectionsRestoreArgs,
    handleRestoreConnections,
    closeConnectionsRestorePreviewModal,
    confirmConnectionsRestore,
  };
}