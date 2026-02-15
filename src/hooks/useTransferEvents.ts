import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store/useAppStore';

interface TransferProgressPayload {
    id: string;
    transferred: number;
    total: number;
}

interface TransferSuccessPayload {
    id: string;
    destination_connection_id: string;
}

interface TransferErrorPayload {
    id: string;
    error: string;
}

export function useTransferEvents() {
    const updateProgress = useAppStore(state => state.updateTransferProgress);
    const completeTransfer = useAppStore(state => state.completeTransfer);
    const failTransfer = useAppStore(state => state.failTransfer);
    const refreshFiles = useAppStore(state => state.refreshFiles);

    useEffect(() => {
        const unlistenProgress = listen<TransferProgressPayload>('transfer-progress', (event) => {
            console.log('[Frontend] Transfer Progress Event:', event.payload);
            const { id, transferred, total } = event.payload;
            updateProgress(id, {
                transferred,
                total,
                percentage: total > 0 ? (transferred / total) * 100 : 0
            });
        });

        const unlistenSuccess = listen<TransferSuccessPayload>('transfer-success', (event) => {
            const { id, destination_connection_id } = event.payload;
            completeTransfer(id);
            // Auto-refresh the destination to show new files immediately
            // Silent refresh is handled by refreshFiles logic now
            if (destination_connection_id) {
                refreshFiles(destination_connection_id);
            }
        });

        const unlistenError = listen<TransferErrorPayload>('transfer-error', (event) => {
            failTransfer(event.payload.id, event.payload.error);
        });

        return () => {
            unlistenProgress.then(f => f());
            unlistenSuccess.then(f => f());
            unlistenError.then(f => f());
        };
    }, [updateProgress, completeTransfer, failTransfer, refreshFiles]);
}
