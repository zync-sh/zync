import { AlertCircle, FolderOpen, KeyRound, PlugZap, RefreshCw, Terminal } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { connectionUsesVaultAuth } from '../../features/connections/domain/connectionConfig';
import { useConnectionDisplayLabels } from '../../features/connections/presentation/useConnectionDisplayLabels';
import { formatLastConnectedLabel } from '../../lib/relativeTime';
import { type Connection, useAppStore } from '../../store/useAppStore';
import {
    ConnectionStateCard,
    type ConnectionStateCardTone,
} from '../connections/ConnectionStateCard';
import { Button } from '../ui/Button';

export type DisconnectSurface = 'terminal' | 'files' | 'plugin';

export interface TerminalDisconnectedViewProps {
    connection: Connection | null | undefined;
    isPendingRestore: boolean;
    activeConnectionId: string;
    onReconnect: () => void;
    onEditHost?: () => void;
    /** Switch to Files/SFTP for this host (terminal surface). */
    onOpenFiles?: () => void;
    /** Switch back to the terminal view (files surface). */
    onOpenTerminal?: () => void;
    /** Open local vault workspace (vault-backed hosts). */
    onOpenVault?: () => void;
    /** Copy + action affordances for terminal vs SFTP. Default: terminal. */
    surface?: DisconnectSurface;
    /**
     * When false, skip autofocus and the window Enter listener so a hidden
     * sibling surface (e.g. Files mounted under `hidden`) cannot steal input.
     */
    isSurfaceActive?: boolean;
}

type DisconnectKind = 'restored' | 'error' | 'offline';

function resolveKind(isPendingRestore: boolean, hasError: boolean): DisconnectKind {
    if (hasError) {
        return 'error';
    }
    if (isPendingRestore) {
        return 'restored';
    }
    return 'offline';
}

const KIND_META: Record<
    DisconnectKind,
    {
        chip: string;
        title: string;
        Icon: typeof Terminal;
        tone: ConnectionStateCardTone;
    }
> = {
    restored: {
        chip: 'Restored',
        title: 'Resume session',
        Icon: PlugZap,
        tone: 'accent',
    },
    error: {
        chip: 'Error',
        title: "Couldn't connect",
        Icon: AlertCircle,
        tone: 'error',
    },
    offline: {
        chip: 'Offline',
        title: 'Connection closed',
        Icon: Terminal,
        tone: 'neutral',
    },
};

const FALLBACK_CONNECTION: Connection = {
    id: '',
    name: 'SSH host',
    host: '',
    username: '',
    port: 22,
    status: 'disconnected',
};

export const TerminalDisconnectedView = memo(function TerminalDisconnectedView({
    connection,
    isPendingRestore,
    activeConnectionId,
    onReconnect,
    onEditHost,
    onOpenFiles,
    onOpenTerminal,
    onOpenVault,
    surface = 'terminal',
    isSurfaceActive = true,
}: TerminalDisconnectedViewProps) {
    const reconnectRef = useRef<HTMLButtonElement>(null);
    const isConnecting = connection?.status === 'connecting';
    const hasError = connection?.status === 'error';
    const kind = resolveKind(isPendingRestore, hasError);
    const meta = KIND_META[kind];
    const Icon = meta.Icon;
    const isFiles = surface === 'files';

    const labels = useConnectionDisplayLabels(
        connection ?? { ...FALLBACK_CONNECTION, id: activeConnectionId },
    );

    const terminalCount = useAppStore((state) => state.terminals[activeConnectionId]?.length ?? 0);
    const connections = useAppStore((state) => state.connections);
    const usesVault = useMemo(
        () => Boolean(connection && connectionUsesVaultAuth(connections, connection.id)),
        [connection, connections],
    );

    const lastConnectedLabel = formatLastConnectedLabel(connection?.lastConnected);
    const errorDetail = kind === 'error' ? connection?.lastError?.trim() : undefined;

    const bodyCopy = useMemo(() => {
        if (kind === 'error') {
            return errorDetail
                ? isFiles
                    ? 'SFTP could not start. Review the error below, then retry or edit the host.'
                    : 'The SSH session could not be established. Review the error below, then retry or edit the host.'
                : isFiles
                  ? 'Failed to open an SFTP session. Check credentials and network, then try again.'
                  : 'Failed to establish the SSH session. Check credentials and network, then try again.';
        }
        if (kind === 'restored') {
            if (surface === 'plugin') {
                return 'This host was restored from your last session. Connect to use this plugin.';
            }
            if (isFiles) {
                return 'This host was restored from your last session. Connect to browse files over SFTP.';
            }
            if (terminalCount > 1) {
                return `This host was restored from your last session with ${terminalCount} terminals. Connect when you are ready.`;
            }
            return 'This terminal was restored from your last session. Connect when you are ready.';
        }
        if (surface === 'plugin') {
            return 'This host is disconnected. Reconnect to use this plugin.';
        }
        return isFiles
            ? 'This host is disconnected. Reconnect to browse files over SFTP.'
            : 'The SSH session for this terminal ended. Reconnect to open a new shell.';
    }, [kind, errorDetail, terminalCount, isFiles, surface]);

    const primaryLabel = kind === 'error' ? 'Retry connection' : 'Reconnect';
    const connectingLabel = isFiles
        ? `Connecting SFTP to ${labels.primary}…`
        : `Opening SSH session to ${labels.primary}…`;

    const handleReconnect = useCallback(() => {
        if (!activeConnectionId || isConnecting) {
            return;
        }
        onReconnect();
    }, [activeConnectionId, isConnecting, onReconnect]);

    useEffect(() => {
        if (!isSurfaceActive || isConnecting) {
            return;
        }
        const id = window.requestAnimationFrame(() => {
            reconnectRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(id);
    }, [isSurfaceActive, isConnecting, kind, activeConnectionId]);

    // Enter reconnects when focus is not inside another interactive control.
    useEffect(() => {
        if (!isSurfaceActive || isConnecting) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Enter' || event.defaultPrevented) {
                return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            const target = event.target as HTMLElement | null;
            if (target) {
                const tag = target.tagName;
                if (tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
                    return;
                }
                if (tag === 'BUTTON' || tag === 'A' || target.getAttribute('role') === 'button') {
                    return;
                }
                if (tag === 'INPUT') {
                    return;
                }
            }
            event.preventDefault();
            handleReconnect();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isSurfaceActive, handleReconnect, isConnecting]);

    const showSecondary = Boolean(
        !isConnecting &&
            connection &&
            (onEditHost || onOpenFiles || onOpenTerminal || (usesVault && onOpenVault)),
    );

    return (
        <ConnectionStateCard
            key="disconnected"
            statusLabel={`${meta.title}: ${labels.primary}`}
            title={isConnecting ? 'Connecting…' : meta.title}
            tone={meta.tone}
            badge={isConnecting ? undefined : meta.chip}
            icon={
                isConnecting ? (
                    <RefreshCw
                        size={20}
                        className="motion-safe:animate-spin text-app-accent [@media(max-height:560px)]:h-4 [@media(max-height:560px)]:w-4"
                    />
                ) : (
                    <Icon
                        size={20}
                        className="[@media(max-height:560px)]:h-4 [@media(max-height:560px)]:w-4"
                    />
                )
            }
            identity={
                <>
                    <p className="truncate text-sm font-medium text-app-text">{labels.primary}</p>
                    {labels.secondary ? (
                        <p className="mt-0.5 truncate font-mono text-xs text-app-muted">
                            {labels.secondary}
                        </p>
                    ) : null}
                    {!isConnecting && lastConnectedLabel ? (
                        <p className="mt-1 text-[11px] text-app-muted/75 [@media(max-height:560px)]:mt-0.5">
                            {lastConnectedLabel}
                        </p>
                    ) : null}
                </>
            }
        >
            <p className="mt-3 text-xs leading-relaxed text-app-muted sm:mt-4 [@media(max-height:560px)]:mt-2.5">
                {isConnecting ? connectingLabel : bodyCopy}
            </p>

            {!isConnecting && errorDetail ? (
                <pre className="mt-2.5 max-h-24 overflow-auto rounded-lg border border-app-danger/25 bg-app-danger/5 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-app-danger/90 sm:mt-3 sm:max-h-28 [@media(max-height:560px)]:max-h-16">
                    {errorDetail}
                </pre>
            ) : null}

            {!isConnecting && usesVault && kind !== 'error' ? (
                <p className="mt-2 text-[11px] leading-relaxed text-app-muted/80 [@media(max-height:560px)]:mt-1.5">
                    This host uses vault credentials. Unlock may be required on reconnect.
                </p>
            ) : null}

            {!isConnecting && usesVault && kind === 'error' ? (
                <p className="mt-2 text-[11px] leading-relaxed text-app-muted/80 [@media(max-height:560px)]:mt-1.5">
                    Vault credentials may need unlock or rotation before retrying.
                </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2 sm:mt-5 [@media(max-height:560px)]:mt-3">
                <Button
                    ref={reconnectRef}
                    size="md"
                    variant="primary"
                    isLoading={isConnecting}
                    disabled={isConnecting || !activeConnectionId}
                    onClick={handleReconnect}
                    className="min-w-[8.5rem] [@media(max-height:560px)]:h-9 [@media(max-height:560px)]:min-w-[7.5rem]"
                >
                    {primaryLabel}
                </Button>

                {!isConnecting && isSurfaceActive ? (
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-app-muted/70">
                        <kbd className="rounded border border-app-border/80 bg-app-surface/80 px-1.5 py-0.5 font-mono text-[10px] text-app-muted">
                            Enter
                        </kbd>
                        <span>to {kind === 'error' ? 'retry' : 'reconnect'}</span>
                    </span>
                ) : null}
            </div>

            {showSecondary ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-app-border/40 pt-3 [@media(max-height:560px)]:mt-2.5 [@media(max-height:560px)]:pt-2.5">
                    {onOpenFiles ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={onOpenFiles}
                            className="gap-1.5"
                        >
                            <FolderOpen size={14} />
                            Files / SFTP
                        </Button>
                    ) : null}
                    {onOpenTerminal ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={onOpenTerminal}
                            className="gap-1.5"
                        >
                            <Terminal size={14} />
                            Open terminal
                        </Button>
                    ) : null}
                    {onEditHost ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={onEditHost}
                        >
                            Edit host
                        </Button>
                    ) : null}
                    {usesVault && onOpenVault ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={onOpenVault}
                            className="gap-1.5"
                        >
                            <KeyRound size={14} />
                            Open vault
                        </Button>
                    ) : null}
                </div>
            ) : null}
        </ConnectionStateCard>
    );
});
