import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import type { Channel } from '@tauri-apps/api/core';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Sidebar } from '../../src/components/layout/Sidebar';
import { ModalRoot } from '../../src/components/ui/ModalRoot';
import { useContentMenuItems } from '../../src/components/workspace/WorkspaceContextActions';
import type { Tab } from '../../src/features/connections/domain/types';
import type { SerialProfile } from '../../src/features/serial/domain/profile';
import type { SerialSettings } from '../../src/features/serial/domain/serialSettings';
import { DEFAULT_SERIAL_SETTINGS } from '../../src/features/serial/domain/serialSettings';
import { DirectSerialTab } from '../../src/features/serial/ui/DirectSerialTab';
import { openSerialProfileEditor } from '../../src/features/serial/ui/SerialProfileManager';
import { SerialProfileSection } from '../../src/features/serial/ui/SerialProfileSection';
import { SerialTerminalPane } from '../../src/features/serial/ui/SerialTerminalPane';
import type { VncProfile } from '../../src/features/vnc/domain/profile';
import { useAppStore } from '../../src/store/useAppStore';
import '../../src/index.css';
import '../uiOverlays.browser.css';

interface OpenRequest {
    sessionId: string;
    portId: string;
    documentId: string;
    settings: SerialSettings;
    outputChannel: Channel<unknown>;
    statusChannel: Channel<{ kind: 'error'; message: string }>;
}

export interface SerialFixtureLog {
    commands: string[];
    scans: number;
    opens: Array<Pick<OpenRequest, 'sessionId' | 'portId' | 'documentId' | 'settings'>>;
    closes: string[];
    input: number[][];
    outputCredits: number[];
    profileWrites: SerialProfile[][];
}

interface FixtureSession {
    request: OpenRequest;
    sequence: number;
}

interface SerialFixture {
    log: () => SerialFixtureLog;
    deferNextOpen: () => void;
    completeOpen: () => void;
    output: (text: string, sessionId?: string) => void;
    disconnect: (message: string) => void;
    setPorts: (ids: string[]) => void;
    profiles: () => SerialProfile[];
    failNextSave: () => void;
    deferNextClose: () => void;
    completeClose: () => void;
    setVisible: (visible: boolean) => void;
    workspace: () => { tabs: Tab[]; activeTabId: string | null; activeConnectionId: string | null };
}

declare global {
    interface Window {
        __SERIAL_FIXTURE__: SerialFixture;
    }
}

const log: SerialFixtureLog = {
    commands: [],
    scans: 0,
    opens: [],
    closes: [],
    input: [],
    outputCredits: [],
    profileWrites: [],
};
const sessions = new Map<string, FixtureSession>();
let deferOpen = false;
let resolveOpen: (() => void) | undefined;
let callbackId = 0;
let latestSession: string | undefined;
let portIds = ['COM1', 'COM2'];
let storedProfiles: SerialProfile[] = [];
let storedVncProfiles: VncProfile[] = [];
let failSave = false;
let deferClose = false;
let resolveClose: (() => void) | undefined;
const portOwners = new Map<string, string>();

/** Send the same binary frame shape consumed by the native serial session adapter. */
function output(text: string, sessionId = latestSession) {
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
        throw new Error('No fixture serial session');
    }
    const bytes = new TextEncoder().encode(text);
    const frame = new ArrayBuffer(8 + bytes.length);
    const view = new DataView(frame);
    view.setUint32(0, 1, true);
    view.setUint32(4, ++session.sequence, true);
    new Uint8Array(frame, 8).set(bytes);
    session.request.outputChannel.onmessage(frame);
}

Object.assign(window, {
    __TAURI_INTERNALS__: {
        transformCallback: () => ++callbackId,
        unregisterCallback: () => {},
        async invoke(command: string, args?: Record<string, unknown>) {
            log.commands.push(command);
            if (command === 'sync_status') {
                return { connected: false };
            }
            if (command === 'sync_collection_status') {
                return {
                    provider: 'google',
                    configured: false,
                    keyCached: false,
                    hasRecoveryKey: false,
                };
            }
            if (command === 'serial_list_ports') {
                log.scans++;
                return portIds.map((id) => ({
                    id,
                    label: `${id} · Virtual serial bridge`,
                    documentId: `fixture-document-${log.scans}`,
                }));
            }
            if (command === 'settings_get') {
                return {
                    serialProfiles: structuredClone(storedProfiles),
                    vncProfiles: structuredClone(storedVncProfiles),
                };
            }
            if (command === 'settings_set') {
                const settings = args?.settings as {
                    serialProfiles?: SerialProfile[];
                    vncProfiles?: VncProfile[];
                };
                if (settings.vncProfiles) {
                    storedVncProfiles = structuredClone(settings.vncProfiles);
                }
                if (settings.serialProfiles) {
                    if (failSave) {
                        failSave = false;
                        throw new Error('Fixture could not save the Serial profile.');
                    }
                    storedProfiles = structuredClone(settings.serialProfiles);
                    log.profileWrites.push(structuredClone(storedProfiles));
                }
                return;
            }
            if (command === 'serial_open') {
                const request = args as unknown as OpenRequest;
                latestSession = request.sessionId;
                sessions.set(request.sessionId, { request, sequence: 0 });
                log.opens.push({
                    sessionId: request.sessionId,
                    portId: request.portId,
                    documentId: request.documentId,
                    settings: { ...request.settings },
                });
                if (portOwners.has(request.portId)) {
                    throw new Error('Fixture serial port is still in use.');
                }
                portOwners.set(request.portId, request.sessionId);
                if (deferOpen) {
                    deferOpen = false;
                    await new Promise<void>((resolve) => {
                        resolveOpen = resolve;
                    });
                }
                output(`Serial fixture connected to ${request.portId}\r\n`, request.sessionId);
                return;
            }
            if (command === 'serial_close') {
                const sessionId = String(args?.sessionId);
                log.closes.push(sessionId);
                if (deferClose) {
                    deferClose = false;
                    await new Promise<void>((resolve) => {
                        resolveClose = resolve;
                    });
                }
                const session = sessions.get(sessionId);
                if (session && portOwners.get(session.request.portId) === sessionId) {
                    portOwners.delete(session.request.portId);
                }
                return;
            }
            if (command === 'serial_write') {
                log.input.push(args?.bytes as number[]);
                return;
            }
            if (command === 'serial_ack_output') {
                log.outputCredits.push(Number(args?.sequence));
                return;
            }
            throw new Error(`Unexpected serial fixture command ${command}`);
        },
    },
    __SERIAL_FIXTURE__: {
        log: () => structuredClone(log),
        deferNextOpen: () => {
            deferOpen = true;
        },
        completeOpen: () => {
            if (!resolveOpen) {
                throw new Error('No pending fixture serial open');
            }
            const complete = resolveOpen;
            resolveOpen = undefined;
            complete();
        },
        output,
        disconnect: (message: string) => {
            const session = latestSession ? sessions.get(latestSession) : undefined;
            if (!session) {
                throw new Error('No fixture serial session');
            }
            session.request.statusChannel.onmessage({ kind: 'error', message });
        },
        setPorts: (ids: string[]) => {
            portIds = [...ids];
        },
        profiles: () => structuredClone(storedProfiles),
        failNextSave: () => {
            failSave = true;
        },
        deferNextClose: () => {
            deferClose = true;
        },
        completeClose: () => {
            if (!resolveClose) {
                throw new Error('No pending fixture serial close');
            }
            const complete = resolveClose;
            resolveClose = undefined;
            complete();
        },
        setVisible: (visible: boolean) => {
            useAppStore.setState((state) => ({
                activeTabId: visible
                    ? (state.tabs.find((tab) => tab.type === 'serial')?.id ?? null)
                    : null,
            }));
        },
        workspace: () => {
            const { tabs, activeTabId, activeConnectionId } = useAppStore.getState();
            return structuredClone({ tabs, activeTabId, activeConnectionId });
        },
    } satisfies SerialFixture,
});

const query = new URLSearchParams(location.search);
const paneWidth = Number(query.get('width'));
document.body.dataset.overlayGalleryTheme = query.has('light') ? 'light' : 'dark';
useAppStore.setState({
    isLoadingSettings: false,
    sessionLoaded: true,
    saveSession: async () => {},
});

if (query.has('sidebar')) {
    const count = query.has('empty') ? 0 : query.has('many') ? 80 : 3;
    storedProfiles = Array.from({ length: count }, (_, index) => ({
        id: `serial-sidebar-${index}`,
        name: `Console ${index + 1}`,
        portId: `COM${index + 1}`,
        settings: { ...DEFAULT_SERIAL_SETTINGS },
        lineEnding: 'cr',
    }));
    storedVncProfiles = Array.from({ length: count }, (_, index) => ({
        id: `vnc-sidebar-${index}`,
        name: `Desktop ${index + 1}`,
        host: '127.0.0.1',
        port: 5900 + index,
        resolution: { mode: 'server' },
        scale: 'fit',
    }));
    useAppStore.setState((state) => ({
        globalSidebarSection: 'hosts',
        activeConnectionId: 'host-sidebar-0',
        activeTabId: 'host-initial-tab',
        tabs: [
            {
                id: 'host-initial-tab',
                type: 'connection',
                title: 'Host 1',
                connectionId: 'host-sidebar-0',
                view: 'terminal',
            },
        ],
        connections: Array.from({ length: 106 }, (_, index) => ({
            id: `host-sidebar-${index}`,
            name: `Host ${index + 1}`,
            host: `host${index + 1}.example.test`,
            username: 'admin',
            port: 22,
            status: 'disconnected',
        })),
        settings: {
            ...state.settings,
            sidebarCollapsed: false,
            sidebarWidth: paneWidth || 288,
            compactMode: query.has('compact'),
            serialProfiles: storedProfiles,
            vncProfiles: storedVncProfiles,
        },
    }));
}

/** Render the complete production sidebar so section allocation and host rows share real layout. */
function SidebarFixture() {
    return (
        <div className="flex h-full bg-app-bg text-app-text">
            <Sidebar />
            <main
                className="min-w-0 flex-1"
                aria-label="Sidebar fixture workspace"
            />
        </div>
    );
}

/** Exercise saved profiles through the real store while native calls remain deterministic. */
function StandaloneFixture() {
    const tabs = useAppStore((state) => state.tabs);
    const activeTabId = useAppStore((state) => state.activeTabId);
    const [backCount, setBackCount] = useState(0);
    const [, registerMenuItems] = useContentMenuItems();
    const serialTabs = tabs.filter((tab) => tab.type === 'serial');
    return (
        <div className="flex h-full flex-col bg-app-bg text-app-text">
            <div className="flex shrink-0 flex-wrap gap-3 p-2 text-xs text-app-text">
                <button
                    type="button"
                    onClick={() =>
                        openSerialProfileEditor(undefined, {
                            onBack: () => setBackCount((count) => count + 1),
                        })
                    }
                >
                    Add serial fixture
                </button>
                <button
                    type="button"
                    onClick={() => {
                        const profile = useAppStore.getState().settings.serialProfiles[0];
                        if (profile) {
                            useAppStore.getState().openSerialTab(profile.id);
                        }
                    }}
                >
                    Reopen serial fixture
                </button>
                <button
                    type="button"
                    onClick={() => {
                        const state = useAppStore.getState();
                        if (state.activeTabId) {
                            state.closeTab(state.activeTabId);
                        }
                    }}
                >
                    Close serial fixture
                </button>
                <button
                    type="button"
                    onClick={() => {
                        const state = useAppStore.getState();
                        const profile = state.settings.serialProfiles[0];
                        if (profile) {
                            state.restoreTabState(
                                [
                                    {
                                        id: 'restored-serial',
                                        tabType: 'serial',
                                        title: profile.name,
                                        serialProfileId: profile.id,
                                        view: 'serial',
                                    },
                                ],
                                'restored-serial',
                                null,
                            );
                        }
                    }}
                >
                    Restore serial fixture
                </button>
                <output aria-label="Fixture Back count">{backCount}</output>
            </div>
            <div className="flex min-h-0 flex-1">
                {(!paneWidth || paneWidth >= 640) && (
                    <aside className="w-60 shrink-0 border-r border-app-border bg-app-panel p-2">
                        <SerialProfileSection compactMode={false} />
                    </aside>
                )}
                <main
                    id="serial-fixture-pane"
                    className="relative min-h-0 flex-1"
                    style={{ width: paneWidth || '100%', maxWidth: '100%' }}
                >
                    {serialTabs.map((tab) => (
                        <div
                            key={tab.id}
                            hidden={tab.id !== activeTabId}
                            className="absolute inset-0"
                        >
                            <DirectSerialTab
                                tabId={tab.id}
                                profileId={tab.serialProfileId}
                                active={tab.id === activeTabId}
                                registerMenuItems={registerMenuItems}
                            />
                        </div>
                    ))}
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <TooltipProvider>
            {query.has('sidebar') ? (
                <SidebarFixture />
            ) : query.has('standalone') ? (
                <StandaloneFixture />
            ) : (
                <main
                    id="serial-fixture-pane"
                    style={{ width: paneWidth || '100%', maxWidth: '100%', height: '100%' }}
                >
                    <SerialTerminalPane />
                </main>
            )}
            <ModalRoot />
        </TooltipProvider>
    </StrictMode>,
);
