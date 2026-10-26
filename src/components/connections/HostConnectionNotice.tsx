import { useEffect, useRef, useState } from 'react';
import { AlertCircle, PlugZap } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { connectionFailureReason } from '../../features/connections/domain/formPresentation';
import type { BeginConnectionFocus, FinishConnectionFocus } from '../../features/connections/presentation/useConnectionFocus';

/** A content-owned connection action leaves local records and draft settings usable offline. */
export function HostConnectionNotice({ connectionId, description, className, onConnectStart }: {
    connectionId: string; description: string; className?: string; onConnectStart?: BeginConnectionFocus;
}) {
    const connection = useAppStore(state => state.connections.find(item => item.id === connectionId));
    const connect = useAppStore(state => state.connect);
    const cancelConnect = useAppStore(state => state.cancelConnect);
    const openConnectionModal = useAppStore(state => state.openConnectionModal);
    const showToast = useAppStore(state => state.showToast);
    const source = useRef<HTMLElement>(null);
    const pending = useRef<{ connectionId: string; cancelled: boolean; finishFocus?: FinishConnectionFocus } | null>(null);
    const cancelOperation = useRef<object | null>(null);
    const [cancelling, setCancelling] = useState(false);
    useEffect(() => {
        setCancelling(false);
        return () => { cancelOperation.current = null; pending.current = null; };
    }, [connectionId]);
    if (connectionId === 'local' || connection?.status === 'connected') return null;

    const connecting = connection?.status === 'connecting' || cancelling;
    const failed = connection?.status === 'error';
    const title = !connection ? 'Host is unavailable' : cancelling ? 'Cancelling connection…' : connecting ? 'Connecting to host…' : failed ? 'Could not connect' : 'Host is offline';
    const label = failed ? 'Retry connection' : connection?.lastConnected ? 'Reconnect' : 'Connect';
    const Icon = failed ? AlertCircle : PlugZap;

    /** Use the existing host flow so trust, Vault and network-interface prompts retain their owners. */
    const handleConnect = async () => {
        const current = useAppStore.getState().connections.find(item => item.id === connectionId);
        if (!current || current.status === 'connected' || current.status === 'connecting' || pending.current?.connectionId === connectionId || cancelOperation.current) return;
        const attempt = { connectionId, cancelled: false, finishFocus: source.current ? onConnectStart?.(source.current) : undefined };
        pending.current = attempt;
        try { await connect(connectionId, { preserveWorkspace: true }); }
        catch { if (pending.current === attempt && !attempt.cancelled) showToast('error', 'Could not connect to this host. Try again.'); }
        finally {
            attempt.finishFocus?.(!attempt.cancelled && useAppStore.getState().connections.find(item => item.id === connectionId)?.status === 'connected');
            if (pending.current === attempt) pending.current = null;
        }
    };

    /** Cancel the existing attempt without disconnecting a connection that already finished elsewhere. */
    const handleCancel = async () => {
        if (cancelOperation.current || useAppStore.getState().connections.find(item => item.id === connectionId)?.status !== 'connecting') return;
        const operation = {}; cancelOperation.current = operation; setCancelling(true);
        const attempt = pending.current;
        if (attempt?.connectionId === connectionId) { attempt.cancelled = true; attempt.finishFocus?.(false); }
        try { await cancelConnect(connectionId); }
        catch { if (cancelOperation.current === operation) showToast('error', 'Could not cancel the connection. Try again.'); }
        finally {
            if (cancelOperation.current === operation) {
                cancelOperation.current = null; setCancelling(false);
                if (pending.current === attempt) pending.current = null;
            }
        }
    };

    return <section ref={source} aria-label="Host connection" className={cn('rounded-lg border border-app-border bg-app-surface/50 p-4', className)}>
        <div className="flex flex-wrap items-center gap-3">
            <Icon size={18} aria-hidden="true" className={cn('shrink-0', failed ? 'text-app-danger' : 'text-app-muted')} />
            <div className="min-w-0 flex-1 basis-40">
                <p role="status" className="text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs leading-relaxed text-app-muted">{connection ? failed ? connectionFailureReason(connection.lastError) : description : 'Choose a saved SSH host to continue.'}</p>
            </div>
            {connection && <Button size="sm" isLoading={connecting} onClick={() => void handleConnect()}>{cancelling ? 'Cancelling…' : connecting ? 'Connecting…' : label}</Button>}
            {connecting && connection && <Button variant="ghost" size="sm" disabled={cancelling} onClick={() => void handleCancel()}>Cancel</Button>}
            {failed && connection && <Button variant="ghost" size="sm" onClick={() => openConnectionModal(connectionId)}>Edit host</Button>}
        </div>
        {failed && connection?.lastError && <details className="mt-3 text-xs text-app-muted">
            <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-control-focus">Connection details</summary>
            <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{connection.lastError}</p>
        </details>}
    </section>;
}
