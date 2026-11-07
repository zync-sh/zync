import type RFB from '@novnc/novnc';
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';

import { HostConnectionNotice } from '../../../components/connections/HostConnectionNotice';
import {
    useWorkspaceContextActions,
    type WorkspaceActions,
} from '../../../components/workspace/workspaceActionsContext';
import { useAppStore } from '../../../store/useAppStore';
import { useVaultStore } from '../../../vault/useVaultStore';
import {
    DEFAULT_VNC_PORT,
    DEFAULT_VNC_SCALE,
    formatVncEndpoint,
    type VncProfile,
    type VncResolution,
} from '../domain/profile';
import { closeVncBridge, openDirectVncBridge, openVncBridge } from '../infrastructure/bridge';
import { VncDisconnectedView } from './VncDisconnectedView';
import { VncPasswordDialog } from './VncPasswordDialog';

interface ViewerAttempt {
    readonly id: string;
    viewer?: RFB;
    socket?: WebSocket;
    readonly detachListeners: (() => void)[];
    fixedResizeStarted?: boolean;
    timer?: number;
}

type Phase = 'idle' | 'starting' | 'credentials' | 'connected';
type ResizeFailure = 'rejected' | 'unavailable';
const NEGOTIATION_TIMEOUT_MS = 15_000;
const PASSWORD_TIMEOUT_MS = 90_000;
const SSH_VNC_RESOLUTION: VncResolution = { mode: 'auto' };
const RESIZE_NOTICES: Record<ResizeFailure, string> = {
    rejected:
        'The VNC server rejected the requested resolution. Fitting the current desktop to the pane.',
    unavailable:
        'The VNC server could not apply the requested resolution. Fitting the current desktop to the pane.',
};

/** Translate the authenticated direct bridge's fixed close reasons into endpoint guidance. */
function directBridgeFailure(
    event: CloseEvent,
    endpoint: string,
): { message: string; retryManually?: boolean } | undefined {
    if (event.code !== 1011) {
        return;
    }
    switch (event.reason) {
        case 'vnc-endpoint-refused':
            return {
                message: `Connection refused at ${endpoint}. Make sure the VNC server is running.`,
            };
        case 'vnc-endpoint-timeout':
            return {
                message: `The VNC server at ${endpoint} did not respond in time. Check the network and firewall.`,
            };
        case 'vnc-endpoint-unreachable':
            return {
                message: `Could not reach the VNC server at ${endpoint}. Check the address, port, and network.`,
            };
        case 'vnc-vault-auth-rejected':
            return {
                message: 'The VNC server rejected the saved Vault password.',
                retryManually: true,
            };
        case 'vnc-vault-auth-failed':
            return {
                message: 'Could not sign in using the saved Vault password.',
                retryManually: true,
            };
        default:
            return;
    }
}

/** Detach listeners before closing noVNC so disconnect cannot end a replacement attempt. */
function disposeViewer(attempt: ViewerAttempt) {
    window.clearTimeout(attempt.timer);
    for (const detach of attempt.detachListeners) {
        detach();
    }
    try {
        if (attempt.viewer) {
            attempt.viewer.disconnect();
        } else {
            // The viewer may have failed to construct before taking ownership of the socket.
            attempt.socket?.close();
        }
    } catch {
        // The native bridge still needs retiring if the viewer is already torn down.
    } finally {
        void closeVncBridge(attempt.id).catch(() => {});
    }
}

type VncPaneProps = {
    contentKey: string;
    visible: boolean;
    focused: boolean;
    registerMenuItems?: WorkspaceActions['registerContentMenuItems'];
} & ({ connectionId: string; direct?: never } | { direct: VncProfile; connectionId?: never });

/** VNC viewer over either a saved direct endpoint or the selected SSH host's loopback. */
export function VncPane({
    connectionId,
    direct,
    contentKey,
    visible,
    focused,
    registerMenuItems,
}: VncPaneProps) {
    const transportReady = useAppStore(
        (state) =>
            Boolean(direct) ||
            state.connections.find((item) => item.id === connectionId)?.status === 'connected',
    );
    const connectRequested = useAppStore((state) =>
        Boolean(direct && state.tabs.some((tab) => tab.id === contentKey && tab.vncConnectRequest)),
    );
    const workspaceActions = useWorkspaceContextActions();
    const registerContentMenuItems =
        registerMenuItems ?? workspaceActions?.registerContentMenuItems;
    const canvas = useRef<HTMLDivElement>(null);
    const attemptRef = useRef<ViewerAttempt | null>(null);
    const visibleRef = useRef(visible);
    const [phase, setPhase] = useState<Phase>('idle');
    const [portInput, setPortInput] = useState(String(DEFAULT_VNC_PORT));
    const [sessionResolution, setSessionResolution] = useState<VncResolution | null>(null);
    const [resizeOverride, setResizeOverride] = useState<boolean | null>(null);
    const [resizeFailure, setResizeFailure] = useState<ResizeFailure | null>(null);
    const [manualRetryCredential, setManualRetryCredential] = useState<string | null>(null);
    const [error, setError] = useState('');
    const credentialId = direct?.credentialId;
    const manualRetry = Boolean(credentialId && manualRetryCredential === credentialId);
    const configuredResolution = direct?.resolution ?? SSH_VNC_RESOLUTION;
    const resolution = sessionResolution ?? configuredResolution;
    const defaultAutoResize = resolution.mode === 'auto';
    const resizeRemoteDesktop = resizeOverride ?? defaultAutoResize;
    const viewerScale = resizeFailure ? DEFAULT_VNC_SCALE : (direct?.scale ?? DEFAULT_VNC_SCALE);
    const viewportScale = viewerScale === 'fit' ? null : viewerScale / 100;
    const port = direct?.port ?? Number(portInput);
    const endpoint = direct ? formatVncEndpoint(direct) : `SSH loopback port ${port}`;
    const validPort =
        (direct || /^[0-9]+$/.test(portInput)) &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65535;
    const status = {
        idle: 'Disconnected',
        starting: 'Connecting…',
        credentials: 'Password required',
        connected: 'Connected',
    }[phase];

    /** Ignore late events from viewers that have already been replaced. */
    const end = useCallback((attempt: ViewerAttempt, message = '') => {
        if (attemptRef.current !== attempt) {
            return;
        }
        attemptRef.current = null;
        disposeViewer(attempt);
        setError(message);
        setPhase('idle');
        setSessionResolution(null);
        setResizeOverride(null);
        setResizeFailure(null);
    }, []);

    function stopViewer() {
        if (attemptRef.current) {
            end(attemptRef.current);
        }
    }

    /** Bound remote negotiation separately from the time allowed for entering a password. */
    function armTimeout(attempt: ViewerAttempt, waitingForPassword = false) {
        window.clearTimeout(attempt.timer);
        attempt.timer = window.setTimeout(
            () =>
                end(
                    attempt,
                    waitingForPassword
                        ? 'The VNC password prompt timed out.'
                        : 'The VNC connection timed out.',
                ),
            waitingForPassword ? PASSWORD_TIMEOUT_MS : NEGOTIATION_TIMEOUT_MS,
        );
    }

    useEffect(
        () => () => {
            const attempt = attemptRef.current;
            attemptRef.current = null;
            if (attempt) {
                disposeViewer(attempt);
            }
        },
        [],
    );

    useEffect(() => {
        if (!transportReady && attemptRef.current) {
            end(attemptRef.current, 'The SSH connection closed.');
        }
    }, [transportReady, end]);

    useLayoutEffect(() => {
        /** Synchronize visibility, local scale, and remote resize policy with this viewer. */
        const syncVisibility = () => {
            const showingDesktop = visible && !document.hidden;
            visibleRef.current = showingDesktop;
            const attempt = attemptRef.current;
            const viewer = attempt?.viewer;
            if (!viewer) {
                return;
            }
            viewer.viewOnly = !showingDesktop;
            viewer.viewportScale = viewportScale;
            // Wait for the connection form to leave the layout before sizing the desktop.
            const readyToResize = showingDesktop && phase === 'connected';
            const shouldResize = readyToResize && resizeRemoteDesktop;
            if (viewer.resizeSession !== shouldResize) {
                viewer.resizeSession = shouldResize;
            }
            viewer.updatesPaused = !showingDesktop;
            if (
                readyToResize &&
                !shouldResize &&
                resolution.mode === 'fixed' &&
                !attempt.fixedResizeStarted
            ) {
                attempt.fixedResizeStarted = true;
                void viewer
                    .requestDesktopSize(resolution.width, resolution.height)
                    .then((result) => {
                        if (attemptRef.current === attempt && result !== 'applied') {
                            setResizeFailure(result);
                        }
                    });
            }
            if (!showingDesktop || !focused) {
                viewer.blur();
            }
        };
        syncVisibility();
        document.addEventListener('visibilitychange', syncVisibility);
        return () => document.removeEventListener('visibilitychange', syncVisibility);
    }, [visible, focused, phase, resizeRemoteDesktop, resolution, viewportScale]);

    useLayoutEffect(() => {
        const attempt = attemptRef.current;
        if (phase !== 'connected' || !attempt || !registerContentMenuItems) {
            return;
        }
        return registerContentMenuItems(contentKey, [
            {
                label: 'Auto-resize',
                checked: resizeRemoteDesktop,
                action: () => {
                    if (attemptRef.current === attempt) {
                        setResizeFailure(null);
                        setResizeOverride((current) => !(current ?? defaultAutoResize));
                    }
                },
            },
            { label: 'Disconnect', action: () => end(attempt) },
        ]);
    }, [contentKey, defaultAutoResize, end, phase, registerContentMenuItems, resizeRemoteDesktop]);

    /** Start one viewer, bypassing the saved password only for an explicit manual retry. */
    async function connectViewer({ manualPassword = false } = {}) {
        const target = canvas.current;
        if (!transportReady || !validPort || !target || attemptRef.current) {
            return;
        }
        const attempt: ViewerAttempt = { id: crypto.randomUUID(), detachListeners: [] };
        attemptRef.current = attempt;
        setManualRetryCredential(null);
        setError('');
        setSessionResolution(configuredResolution);
        setPhase('starting');
        try {
            // The native bridge resolves the linked secret only if the server offers password auth.
            let profileId: string | undefined;
            if (direct && credentialId && !manualPassword) {
                if (!(await useVaultStore.getState().requestUnlock())) {
                    // Cancelling unlock ends this attempt; bypassing Vault requires a manual retry.
                    end(attempt);
                    return;
                }
                profileId = direct.id;
            }
            if (attemptRef.current !== attempt) {
                return;
            }
            armTimeout(attempt);
            const { default: Viewer } = await import('@novnc/novnc');
            if (attemptRef.current !== attempt) {
                return;
            }
            const bridge = direct
                ? await openDirectVncBridge(attempt.id, direct.host, port, profileId)
                : await openVncBridge(attempt.id, connectionId, port);
            if (attemptRef.current !== attempt) {
                await closeVncBridge(attempt.id);
                return;
            }
            if (bridge.sessionId !== attempt.id) {
                throw new Error('Unexpected VNC session.');
            }
            let endpointFailure: ReturnType<typeof directBridgeFailure>;
            if (direct) {
                const socket = new WebSocket(bridge.websocketUrl);
                attempt.socket = socket;
                const recordFailure = (event: CloseEvent) => {
                    endpointFailure = directBridgeFailure(event, endpoint);
                };
                // Capture the bridge reason before noVNC handles close and emits disconnect.
                socket.addEventListener('close', recordFailure);
                attempt.detachListeners.push(() =>
                    socket.removeEventListener('close', recordFailure),
                );
            }
            const viewer = new Viewer(target, attempt.socket ?? bridge.websocketUrl, {
                shared: true,
            });
            attempt.viewer = viewer;
            viewer.scaleViewport = true;
            viewer.viewportScale = viewportScale;
            viewer.viewOnly = !visibleRef.current;
            viewer.updatesPaused = !visibleRef.current;
            let established = false;
            /** noVNC uses its own listener API, which has no AbortSignal option. */
            const listen = (type: string, listener: (event: Event) => void) => {
                viewer.addEventListener(type, listener);
                attempt.detachListeners.push(() => viewer.removeEventListener(type, listener));
            };
            listen('connect', () => {
                established = true;
                window.clearTimeout(attempt.timer);
                if (attemptRef.current === attempt) {
                    setPhase('connected');
                }
            });
            listen('credentialsrequired', (event) => {
                if (attemptRef.current !== attempt) {
                    return;
                }
                const types = (event as CustomEvent<{ types: string[] }>).detail.types;
                if (types.length === 1 && types[0] === 'password') {
                    armTimeout(attempt, true);
                    setPhase('credentials');
                } else {
                    end(
                        attempt,
                        'This VNC server requires a credential type this viewer does not support.',
                    );
                }
            });
            listen('serververification', () => {
                end(
                    attempt,
                    'This VNC server requires a server verification mode this viewer does not support.',
                );
            });
            listen('securityfailure', () => {
                end(
                    attempt,
                    'VNC authentication failed or the server uses an unsupported security mode.',
                );
            });
            listen('desktopresizefailure', () => {
                if (direct && attemptRef.current === attempt) {
                    setResizeOverride(false);
                    setResizeFailure('rejected');
                }
            });
            listen('disconnect', () => {
                if (
                    attemptRef.current === attempt &&
                    endpointFailure?.retryManually &&
                    profileId &&
                    credentialId
                ) {
                    setManualRetryCredential(credentialId);
                }
                const address = direct ? 'saved address and port' : 'remote loopback port';
                const failure = established
                    ? 'The VNC connection closed unexpectedly.'
                    : `Could not open the VNC desktop. Check the ${address} and the server’s authentication mode.`;
                end(attempt, endpointFailure?.message ?? failure);
            });
        } catch (cause) {
            const message =
                typeof cause === 'string'
                    ? cause
                    : cause instanceof Error
                      ? cause.message
                      : 'Could not open the VNC viewer.';
            end(attempt, message);
        }
    }

    const startRequestedViewer = useEffectEvent(() => {
        if (direct && useAppStore.getState().takeVncConnectRequest(contentKey, direct)) {
            void connectViewer();
        }
    });
    useEffect(() => {
        if (!connectRequested || !visible || !focused) {
            return;
        }
        // Let Strict Mode's setup/cleanup replay settle before consuming the one-shot request.
        const task = window.setTimeout(() => startRequestedViewer(), 0);
        return () => window.clearTimeout(task);
    }, [connectRequested, credentialId, focused, visible]);

    /** Submit a one-time credential to the current viewer and resume its negotiation deadline. */
    function submitPassword(password: string) {
        const attempt = attemptRef.current;
        if (!attempt?.viewer) {
            return;
        }
        setPhase('starting');
        armTimeout(attempt);
        try {
            attempt.viewer.sendCredentials({ password });
        } catch {
            end(attempt, 'Could not submit the VNC password.');
        }
    }

    return (
        <section
            aria-label="VNC viewer"
            className="flex h-full min-h-0 flex-col bg-app-bg"
        >
            <span
                role="status"
                className="sr-only"
            >
                {status}
            </span>
            {!transportReady && connectionId && (
                <HostConnectionNotice
                    connectionId={connectionId}
                    className="m-3"
                    description="Connect to this SSH host to reach its local VNC server."
                />
            )}
            {phase === 'credentials' && visible && focused && (
                <VncPasswordDialog
                    endpoint={endpoint}
                    onCancel={stopViewer}
                    onSubmit={submitPassword}
                />
            )}
            {resizeFailure && (
                <p
                    role="status"
                    className="shrink-0 border-b border-app-border px-3 py-2 text-xs text-app-muted"
                >
                    {RESIZE_NOTICES[resizeFailure]}
                </p>
            )}
            <div className="relative min-h-0 flex-1">
                <div
                    ref={canvas}
                    data-zync-shortcuts="local"
                    className="h-full overflow-hidden"
                />
                {phase !== 'connected' && (
                    <div className="absolute inset-0">
                        <VncDisconnectedView
                            profileName={direct?.name}
                            endpoint={endpoint}
                            port={portInput}
                            onPortChange={setPortInput}
                            busy={phase !== 'idle'}
                            canConnect={transportReady && Boolean(validPort)}
                            status={status}
                            error={error}
                            manualRetry={manualRetry}
                            onConnect={() => void connectViewer({ manualPassword: manualRetry })}
                            onCancel={stopViewer}
                        />
                    </div>
                )}
            </div>
        </section>
    );
}
