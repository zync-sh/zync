import { AlertCircle, Cable, RefreshCw, SlidersHorizontal } from 'lucide-react';
import {
    type RefObject,
    useCallback,
    useEffect,
    useEffectEvent,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';

import { ConnectionStateCard } from '../../../components/connections/ConnectionStateCard';
import { Button } from '../../../components/ui/Button';
import { IconButton } from '../../../components/ui/IconButton';
import { Modal } from '../../../components/ui/Modal';
import { Toolbar } from '../../../components/ui/Toolbar';
import type { WorkspaceActions } from '../../../components/workspace/workspaceActionsContext';
import { useAppStore } from '../../../store/useAppStore';
import {
    type FinishConnectionFocus,
    useConnectionFocus,
} from '../../connections/presentation/useConnectionFocus';
import type { SerialProfile } from '../domain/profile';
import {
    DEFAULT_SERIAL_SETTINGS,
    encodeSerialInput,
    type SerialLineEnding,
} from '../domain/serialSettings';
import {
    createSerialSession,
    listSerialPorts,
    type SerialPort,
    serialError,
} from '../infrastructure/serialSession';
import { openSerialProfileEditor } from './SerialProfileManager';
import { SerialSettingsFields } from './SerialSettingsFields';
import { useSerialTerminal } from './useSerialTerminal';

interface SerialTerminalPaneProps {
    profile?: SerialProfile;
    contentKey?: string;
    visible?: boolean;
    focused?: boolean;
    registerMenuItems?: WorkspaceActions['registerContentMenuItems'];
    /** Keep replacement panes behind the previous native device release. */
    releaseBarrier?: RefObject<Promise<void> | undefined>;
}

/** Own a device session independently of shells; restored tabs require explicit Connect. */
export function SerialTerminalPane({
    profile,
    contentKey,
    visible = true,
    focused = true,
    registerMenuItems,
    releaseBarrier,
}: SerialTerminalPaneProps = {}) {
    const [ports, setPorts] = useState<SerialPort[]>([]);
    const [portId, setPortId] = useState(profile?.portId ?? '');
    const [baud, setBaud] = useState(
        String(profile?.settings.baudRate ?? DEFAULT_SERIAL_SETTINGS.baudRate),
    );
    const [settings, setSettings] = useState(profile?.settings ?? DEFAULT_SERIAL_SETTINGS);
    const [ending, setEnding] = useState<SerialLineEnding>('cr');
    const [phase, setPhase] = useState<'idle' | 'opening' | 'connected' | 'closing'>('idle');
    const [scanning, setScanning] = useState(true);
    const [error, setError] = useState('');
    const [hasConnected, setHasConnected] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [restoreSettingsFocus, setRestoreSettingsFocus] = useState(true);
    const paneRef = useRef<HTMLElement>(null);
    const finishFocusRef = useRef<FinishConnectionFocus | undefined>(undefined);
    const formId = useId();
    const scanId = useRef(0);
    const sessionRef = useRef<ReturnType<typeof createSerialSession> | null>(null);
    const savedPortId = profile?.portId;
    const connectRequested = useAppStore((state) =>
        Boolean(
            profile &&
                contentKey &&
                state.tabs.some((tab) => tab.id === contentKey && tab.serialConnectRequest),
        ),
    );
    const { containerRef, terminalRef, inputTargetRef, style } = useSerialTerminal(
        (text) => sessionRef.current?.write(encodeSerialInput(text, profile?.lineEnding ?? ending)),
        (bytes) =>
            sessionRef.current?.write(
                Uint8Array.from(bytes, (character) => character.charCodeAt(0)),
            ),
    );
    const busy = phase !== 'idle';
    const baudRate = Number(baud);
    const validBaud = /^[0-9]+$/.test(baud) && baudRate > 0 && baudRate <= 0xffffffff;
    const beginFocus = useConnectionFocus(
        phase === 'connected' && !connectRequested,
        inputTargetRef,
        contentKey ?? formId,
        visible && focused,
    );

    /** Hold a foreground handoff only while the triggering surface retains keyboard ownership. */
    const requestTerminalFocus = useCallback(
        (fromRequest = false) => {
            const pane = paneRef.current;
            if (
                !pane ||
                !visible ||
                !focused ||
                document.visibilityState !== 'visible' ||
                !document.hasFocus()
            ) {
                return undefined;
            }
            const activeElement = document.activeElement;
            if (pane.contains(activeElement)) {
                return beginFocus(pane);
            }
            if (showSettings && activeElement instanceof HTMLElement) {
                const dialog = activeElement.closest<HTMLElement>('[role="dialog"]');
                if (dialog) {
                    return beginFocus(dialog);
                }
            }
            if (!fromRequest) {
                return undefined;
            }
            if (activeElement === document.body) {
                // An explicit foreground Save & Connect may arrive after its modal has unmounted.
                pane.focus({ preventScroll: true });
                return beginFocus(pane);
            }
            return activeElement instanceof HTMLElement ? beginFocus(activeElement) : undefined;
        },
        [beginFocus, focused, showSettings, visible],
    );

    useLayoutEffect(() => {
        if (connectRequested && visible && focused) {
            finishFocusRef.current?.(false);
            finishFocusRef.current = requestTerminalFocus(true);
        }
    }, [connectRequested, focused, requestTerminalFocus, visible]);

    useEffect(() => {
        /** Hiding the app relinquishes a request even if its tab remains selected. */
        const visibilityChanged = () => {
            if (document.visibilityState !== 'visible') {
                finishFocusRef.current?.(false);
                finishFocusRef.current = undefined;
            }
        };
        document.addEventListener('visibilitychange', visibilityChanged);
        return () => {
            document.removeEventListener('visibilitychange', visibilityChanged);
            finishFocusRef.current?.(false);
            finishFocusRef.current = undefined;
        };
    }, []);

    const refreshPorts = useCallback(async () => {
        const request = ++scanId.current;
        setScanning(true);
        setError('');
        try {
            const found = await listSerialPorts();
            if (request !== scanId.current) {
                return;
            }
            setPorts(found);
            setPortId(
                (current) =>
                    savedPortId ??
                    (found.some((port) => port.id === current) ? current : (found[0]?.id ?? '')),
            );
        } catch (cause) {
            if (request === scanId.current) {
                setError(serialError(cause));
            }
        } finally {
            if (request === scanId.current) {
                setScanning(false);
            }
        }
    }, [savedPortId]);

    useEffect(() => {
        void refreshPorts();
        return () => {
            scanId.current++;
            const session = sessionRef.current;
            sessionRef.current = null;
            const closing = session?.close();
            if (closing && releaseBarrier) {
                releaseBarrier.current = Promise.all([releaseBarrier.current, closing]).then(
                    () => {},
                );
                void releaseBarrier.current.catch(() => {});
            }
            void closing?.catch(() => {});
        };
    }, [refreshPorts, releaseBarrier]);

    /** Re-enumerate the exact selected device before admitting an explicit open attempt. */
    const connect = useCallback(
        async (fromRequest = false) => {
            if (!visible || !focused || !validBaud || scanning || sessionRef.current) {
                return;
            }
            const terminal = terminalRef.current;
            if (!terminal) {
                return;
            }
            if (!portId) {
                return;
            }
            if (!fromRequest) {
                finishFocusRef.current?.(false);
                finishFocusRef.current = requestTerminalFocus();
            }
            setError('');
            setPhase('opening');
            terminal.reset();
            const session = createSerialSession(
                (data, parsed) => terminal.write(data, parsed),
                (message) => {
                    if (sessionRef.current !== session) {
                        return;
                    }
                    sessionRef.current = null;
                    finishFocusRef.current?.(false);
                    finishFocusRef.current = undefined;
                    setPhase('idle');
                    setError(message);
                },
                setError,
            );
            sessionRef.current = session;
            try {
                const retiring = releaseBarrier?.current;
                if (retiring && releaseBarrier) {
                    try {
                        await retiring;
                    } finally {
                        if (releaseBarrier.current === retiring) {
                            releaseBarrier.current = undefined;
                        }
                    }
                }
                if (sessionRef.current !== session || session.closed) {
                    return;
                }
                const discovered = await listSerialPorts();
                if (sessionRef.current !== session || session.closed) {
                    return;
                }
                setPorts(discovered);
                const port = discovered.find((item) => item.id === portId);
                if (!port) {
                    throw new Error(
                        `${portId} is unavailable. Attach the device and refresh the port list.`,
                    );
                }
                await session.open(port, { ...settings, baudRate });
                if (sessionRef.current !== session || session.closed) {
                    return;
                }
                setPhase('connected');
                setHasConnected(true);
                setRestoreSettingsFocus(false);
                setShowSettings(false);
                finishFocusRef.current?.(true);
                finishFocusRef.current = undefined;
            } catch (cause) {
                if (sessionRef.current !== session || session.closed) {
                    return;
                }
                sessionRef.current = null;
                finishFocusRef.current?.(false);
                finishFocusRef.current = undefined;
                void session.close()?.catch(() => {});
                setPhase('idle');
                setError(serialError(cause));
            }
        },
        [
            baudRate,
            focused,
            portId,
            releaseBarrier,
            requestTerminalFocus,
            scanning,
            settings,
            terminalRef,
            validBaud,
            visible,
        ],
    );

    const status = {
        idle: 'Disconnected',
        opening: 'Opening port…',
        connected: 'Connected',
        closing: 'Closing port…',
    }[phase];
    const selectedPort = ports.find((port) => port.id === portId);
    const fields = (
        <SerialSettingsFields
            ports={ports}
            portId={portId}
            onPortChange={setPortId}
            baud={baud}
            onBaudChange={setBaud}
            validBaud={validBaud}
            settings={settings}
            onSettingsChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
            ending={ending}
            onEndingChange={setEnding}
            busy={busy}
            scanning={scanning}
            onRefresh={() => void refreshPorts()}
        />
    );
    const canConnect = Boolean(selectedPort) && validBaud && !scanning;

    /** Keep Connect disabled until the pending open and its cleanup settle. */
    const disconnect = useCallback(async () => {
        finishFocusRef.current?.(false);
        finishFocusRef.current = undefined;
        const session = sessionRef.current;
        if (!session) {
            return;
        }
        setPhase('closing');
        try {
            await session.close();
        } catch (cause) {
            if (sessionRef.current === session) {
                setError(serialError(cause));
            }
        } finally {
            if (sessionRef.current === session) {
                sessionRef.current = null;
                setPhase('idle');
            }
        }
    }, []);

    /** Consume an explicit request against the latest committed saved profile. */
    const startRequestedSession = useEffectEvent(() => {
        if (
            profile &&
            contentKey &&
            useAppStore.getState().takeSerialConnectRequest(contentKey, profile)
        ) {
            if (phase === 'connected' && sessionRef.current) {
                finishFocusRef.current?.(true);
                finishFocusRef.current = undefined;
            } else {
                void connect(true);
            }
        }
    });
    useEffect(() => {
        if (!connectRequested || !visible || !focused || scanning || phase === 'closing') {
            return;
        }
        // Let Strict Mode replay settle before consuming the explicit foreground request.
        const task = window.setTimeout(() => startRequestedSession(), 0);
        return () => window.clearTimeout(task);
    }, [connectRequested, focused, phase, profile, scanning, visible]);

    useLayoutEffect(() => {
        if (!contentKey || !registerMenuItems) {
            return;
        }
        return registerMenuItems(contentKey, [
            {
                label:
                    phase === 'opening' ? 'Cancel connection' : busy ? 'Disconnect' : 'Reconnect',
                disabled: phase === 'closing' || (!busy && !canConnect),
                /** Share lifecycle actions and activate a standalone tab before connecting. */
                action: () => {
                    if (busy) {
                        void disconnect();
                    } else if (profile) {
                        useAppStore.getState().openSerialTab(profile.id, { connect: true });
                    } else {
                        void connect();
                    }
                },
            },
        ]);
    }, [busy, canConnect, connect, contentKey, disconnect, phase, profile, registerMenuItems]);

    return (
        <section
            ref={paneRef}
            tabIndex={-1}
            aria-label="Serial Terminal"
            className="relative flex h-full min-h-0 flex-col bg-app-bg outline-none"
        >
            {hasConnected && (
                <Toolbar
                    label="Serial connection controls"
                    className="shrink-0 gap-2 border-b border-app-border bg-app-panel px-3 py-1.5"
                >
                    <Cable
                        size={14}
                        aria-hidden
                        className="shrink-0 text-app-accent"
                    />
                    <div className="min-w-0 flex-1">
                        <p
                            className="truncate text-xs font-medium text-app-text"
                            title={profile?.name ?? selectedPort?.label}
                        >
                            {profile?.name ?? portId}
                            <span className="ml-2 font-normal text-app-muted">
                                {profile && `${portId} · `}
                                {baud} · {settings.dataBits}
                                {settings.parity[0].toUpperCase()}
                                {settings.stopBits}
                            </span>
                        </p>
                        <p
                            role="status"
                            className="text-[11px] text-app-muted"
                        >
                            {status}
                        </p>
                    </div>
                    <IconButton
                        label="Serial settings"
                        title="Serial settings"
                        icon={<SlidersHorizontal size={14} />}
                        onClick={() => {
                            if (profile) {
                                openSerialProfileEditor(profile);
                            } else {
                                setRestoreSettingsFocus(true);
                                setShowSettings(true);
                            }
                        }}
                        disabled={phase === 'opening' || phase === 'closing'}
                    />
                    {!busy && (
                        <IconButton
                            label="Refresh ports"
                            title="Refresh ports"
                            icon={<RefreshCw size={14} />}
                            disabled={scanning}
                            isLoading={scanning}
                            onClick={() => void refreshPorts()}
                        />
                    )}
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={phase === 'closing' || (!busy && !canConnect)}
                        onClick={() => void (busy ? disconnect() : connect())}
                    >
                        {phase === 'opening' ? 'Cancel' : busy ? 'Disconnect' : 'Reconnect'}
                    </Button>
                </Toolbar>
            )}
            {hasConnected && error && (
                <p
                    role="alert"
                    className="shrink-0 border-b border-control-danger/20 bg-control-danger/5 px-3 py-2 text-xs text-control-danger"
                >
                    {error}
                </p>
            )}
            <div className="relative min-h-0 flex-1">
                <div
                    ref={containerRef}
                    data-zync-shortcuts="local"
                    className="h-full overflow-hidden px-1.5 pt-1.5"
                    style={style}
                />
                {!hasConnected && (
                    <div className="absolute inset-0">
                        <ConnectionStateCard
                            title={
                                busy
                                    ? status
                                    : error
                                      ? "Couldn't connect"
                                      : 'Connect to serial port'
                            }
                            badge={busy ? undefined : error ? 'Error' : 'Disconnected'}
                            tone={error ? 'error' : 'neutral'}
                            icon={
                                busy ? (
                                    <RefreshCw
                                        size={20}
                                        className="motion-safe:animate-spin text-app-accent"
                                    />
                                ) : error ? (
                                    <AlertCircle size={20} />
                                ) : (
                                    <Cable size={20} />
                                )
                            }
                            identity={
                                profile ? (
                                    <>
                                        <p className="truncate text-sm font-medium text-app-text">
                                            {profile.name}
                                        </p>
                                        <p className="mt-0.5 break-all font-mono text-xs text-app-muted">
                                            {portId} · {baud} · {settings.dataBits}
                                            {settings.parity[0].toUpperCase()}
                                            {settings.stopBits}
                                        </p>
                                    </>
                                ) : (
                                    <p className="text-xs leading-relaxed text-app-muted">
                                        Connect to a local device through its serial port.
                                    </p>
                                )
                            }
                        >
                            <form
                                id={formId}
                                className="mt-4 space-y-4"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void connect();
                                }}
                            >
                                {profile ? (
                                    <p
                                        className="text-xs leading-relaxed text-app-muted"
                                        role="status"
                                    >
                                        {scanning
                                            ? 'Checking serial port…'
                                            : selectedPort
                                              ? 'Ready to open the saved serial device.'
                                              : `${portId} is unavailable. Attach the device and refresh the port list.`}
                                    </p>
                                ) : (
                                    fields
                                )}
                                {error && (
                                    <p
                                        role="alert"
                                        className="max-h-24 overflow-auto break-words rounded-lg border border-control-danger/25 bg-control-danger/5 px-3 py-2 text-xs leading-relaxed text-control-danger"
                                    >
                                        {error}
                                    </p>
                                )}
                            </form>
                            <div className="mt-4 flex flex-wrap items-center gap-2">
                                {busy ? (
                                    <Button
                                        key="cancel"
                                        type="button"
                                        variant="secondary"
                                        disabled={phase === 'closing'}
                                        onClick={() => void disconnect()}
                                    >
                                        {phase === 'closing' ? 'Closing…' : 'Cancel'}
                                    </Button>
                                ) : (
                                    <Button
                                        key="connect"
                                        type="submit"
                                        form={formId}
                                        disabled={!canConnect}
                                    >
                                        Connect
                                    </Button>
                                )}
                                {profile && !busy && (
                                    <>
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            onClick={() => openSerialProfileEditor(profile)}
                                        >
                                            Edit connection
                                        </Button>
                                        <IconButton
                                            label="Refresh ports"
                                            title="Refresh ports"
                                            icon={<RefreshCw size={15} />}
                                            variant="secondary"
                                            disabled={scanning}
                                            isLoading={scanning}
                                            onClick={() => void refreshPorts()}
                                        />
                                    </>
                                )}
                            </div>
                        </ConnectionStateCard>
                    </div>
                )}
            </div>
            <Modal
                isOpen={showSettings}
                restoreFocus={restoreSettingsFocus}
                onClose={() => setShowSettings(false)}
                title="Serial connection"
                subtitle={
                    busy
                        ? 'Disconnect to change the port or connection settings.'
                        : 'Choose a device and configure its connection.'
                }
            >
                <form
                    className="space-y-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void connect();
                    }}
                >
                    {fields}
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setShowSettings(false)}
                        >
                            Done
                        </Button>
                        {phase === 'opening' ? (
                            <Button
                                key="cancel"
                                type="button"
                                variant="secondary"
                                onClick={() => void disconnect()}
                            >
                                Cancel
                            </Button>
                        ) : !busy ? (
                            <Button
                                key="connect"
                                type="submit"
                                disabled={!canConnect}
                            >
                                Connect
                            </Button>
                        ) : null}
                    </div>
                </form>
            </Modal>
        </section>
    );
}
