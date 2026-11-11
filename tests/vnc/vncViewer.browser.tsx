import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CombinedTabBar } from '../../src/components/layout/CombinedTabBar';
import { WorkspaceTabList } from '../../src/components/layout/WorkspaceTabList';
import { ShortcutManager } from '../../src/components/managers/ShortcutManager';
import { ModalRoot } from '../../src/components/ui/ModalRoot';
import { GlobalVaultUnlockModal } from '../../src/components/vault/GlobalVaultUnlockModal';
import {
    useContentMenuItems,
    WorkspaceContextActions,
} from '../../src/components/workspace/WorkspaceContextActions';
import { VNC_SSH_LOOPBACK, type VncProfile } from '../../src/features/vnc/domain/profile';
import { useVncProfileTabMenuItems } from '../../src/features/vnc/ui/useVncProfileTabMenuItems';
import { VncPane } from '../../src/features/vnc/ui/VncPane';
import { VncProfileTab } from '../../src/features/vnc/ui/VncProfileTab';
import { featurePaneContent, paneContentKey, singleFeaturePane } from '../../src/lib/paneLayout';
import { useAppStore } from '../../src/store/useAppStore';

const connectionId = 'vnc-test-host';
const tabId = 'vnc-test-workspace';
const viewerId = 'vnc-fixture-primary';
const siblingId = 'vnc-fixture-sibling';
const viewerPane = singleFeaturePane('vnc', 'vnc-fixture-pane', viewerId);
const contentKey = paneContentKey(featurePaneContent('vnc', viewerId), viewerPane.activePaneId);
const noop = () => {};
const unavailable = () => false;
const query = new URLSearchParams(location.search);
const viaSsh = query.has('via-ssh');
const ssh = { id: connectionId, host: 'fixture.invalid', port: 22, username: 'fixture' };
let vaultUnlocked = !query.has('locked');
const width = Number(query.get('width'));
const height = Number(query.get('height'));
const directProfile: VncProfile = {
    id: 'vnc-fixture-direct',
    name: 'Direct VNC fixture',
    host: viaSsh ? VNC_SSH_LOOPBACK : 'vnc.fixture.test',
    port: 5999,
    resolution:
        width && height
            ? { mode: 'fixed', width, height }
            : { mode: query.has('auto') ? 'auto' : 'server' },
    scale: query.get('scale') === '150' ? 150 : 'fit',
    ...(query.has('vault') && { credentialId: 'vnc-fixture-credential' }),
    ...(viaSsh && { ssh }),
    ...(query.has('tls') && { tlsUsername: 'desktop-user' }),
};

interface Attempt {
    sessionId: string;
    connectionId?: string;
    host?: string;
    port: number;
    profileId?: string;
    useVault?: boolean;
    tlsUsername?: string;
}
const starts: Attempt[] = [];
const stops: string[] = [];
let finishStart: (() => void) | undefined;

// Playwright's routed socket adds one prototype level. noVNC checks only the immediate
// prototype for socket methods, so expose the inherited WebSocket API on this mock.
const socketPrototype = WebSocket.prototype;
const routedSocketPrototype = Object.getPrototypeOf(socketPrototype);
if (!Object.hasOwn(socketPrototype, 'send') && Object.hasOwn(routedSocketPrototype, 'send')) {
    for (const name of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen']) {
        const descriptor = Object.getOwnPropertyDescriptor(routedSocketPrototype, name);
        if (descriptor) {
            Object.defineProperty(socketPrototype, name, descriptor);
        }
    }
}

/** Mock admission only. The browser still uses production noVNC and its WebSocket transport. */
async function invoke(command: string, args: Record<string, unknown>) {
    if (command === 'vault_status' || command === 'vault_unlock') {
        if (command === 'vault_unlock') {
            vaultUnlocked = true;
        }
        return {
            status: vaultUnlocked ? 'unlocked' : 'locked',
            vaultId: 'vnc-fixture-vault',
            itemCount: 1,
        };
    }
    if (command === 'vault_item_list') {
        return [];
    }
    if (command === 'vnc_start' || command === 'vnc_start_direct') {
        const request = args as unknown as Attempt;
        const { sessionId, port } = request;
        starts.push(request);
        document.body.dataset.vncStarts = JSON.stringify(starts);
        if (port === 5901) {
            await new Promise<void>((resolve) => {
                finishStart = resolve;
            });
        }
        return { sessionId, websocketUrl: `ws://${location.host}/vnc-fixture/${sessionId}` };
    }
    if (command === 'vnc_stop') {
        stops.push(String(args.sessionId));
        document.body.dataset.vncStops = JSON.stringify(stops);
        return;
    }
    throw new Error(`Unexpected fixture command ${command}`);
}

Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
useAppStore.setState((state) => ({
    activeTabId: tabId,
    sessionLoaded: true,
    settings: { ...state.settings, vncProfiles: [directProfile] },
    saveSession: async () => {},
    ...(viaSsh && {
        connect: async (
            id: string,
            options?: { preserveWorkspace?: boolean; signal?: AbortSignal },
        ) => {
            document.body.dataset.vncSshConnect = JSON.stringify({
                id,
                preserveWorkspace: options?.preserveWorkspace,
                scoped: Boolean(options?.signal),
            });
            if (!query.has('queued-ssh')) {
                useAppStore.setState(({ connections }) => ({
                    connections: connections.map((host) => ({ ...host, status: 'connecting' })),
                }));
            }
            if (query.has('hold-ssh')) {
                await new Promise<void>((resolve) => {
                    options?.signal?.addEventListener(
                        'abort',
                        () => {
                            document.body.dataset.vncSshCancel = id;
                            useAppStore.setState(({ connections }) => ({
                                connections: connections.map((host) => ({
                                    ...host,
                                    status: 'disconnected',
                                })),
                            }));
                            resolve();
                        },
                        { once: true },
                    );
                });
                return;
            }
            useAppStore.setState(({ connections }) => ({
                connections: connections.map((host) => ({ ...host, status: 'connected' })),
            }));
        },
    }),
    paneLayouts: {
        [connectionId]: {
            [viewerId]: viewerPane,
            [siblingId]: singleFeaturePane('vnc', 'vnc-fixture-sibling-pane', siblingId),
        },
    },
    connections: [
        {
            id: connectionId,
            name: 'VNC fixture host',
            host: query.has('changed-ssh') ? 'replacement.invalid' : ssh.host,
            port: ssh.port,
            username: ssh.username,
            status: viaSsh ? 'disconnected' : 'connected',
        },
    ],
}));

/** Exercise the main tab menu and viewer against the real store with native IPC stubbed. */
function DirectFixture() {
    const tabs = useAppStore((state) => state.tabs);
    const activeTabId = useAppStore((state) => state.activeTabId);
    const [menuItems, registerMenuItems] = useContentMenuItems();
    const tabMenuItems = useVncProfileTabMenuItems(tabs, menuItems);
    const [visible, setVisible] = useState(true);
    const store = useAppStore.getState();
    return (
        <>
            <button
                type="button"
                onClick={() => store.openVncTab(directProfile.id)}
            >
                Open saved VNC
            </button>
            <button
                type="button"
                onClick={() => store.openVncTab(directProfile.id, { connect: true })}
            >
                Connect saved VNC
            </button>
            <button
                type="button"
                onClick={() =>
                    store.restoreTabState(
                        [
                            {
                                id: 'restored',
                                tabType: 'vnc',
                                title: 'Stale name',
                                view: 'vnc',
                                connectionId,
                                vncProfileId: directProfile.id,
                            },
                            {
                                id: 'missing',
                                tabType: 'vnc',
                                title: 'Deleted profile',
                                view: 'vnc',
                                vncProfileId: 'deleted',
                            },
                            {
                                id: 'duplicate',
                                tabType: 'vnc',
                                title: 'Duplicate profile',
                                view: 'vnc',
                                vncProfileId: directProfile.id,
                            },
                        ],
                        'restored',
                        connectionId,
                    )
                }
            >
                Restore saved VNC
            </button>
            <button
                type="button"
                onClick={() => setVisible(!visible)}
            >
                {visible ? 'Hide viewer' : 'Show viewer'}
            </button>
            <WorkspaceTabList
                tabs={tabs}
                activeTabId={activeTabId}
                contentMenuItems={tabMenuItems}
                onActivate={store.activateTab}
                onClose={store.closeTab}
                onDisconnect={noop}
                onRename={noop}
                renderIcon={() => null}
                canDisconnect={unavailable}
            />
            <ModalRoot />
            <GlobalVaultUnlockModal />
            <div
                id="vnc-fixture-workspace"
                hidden={!visible}
            >
                {tabs.map((tab) => (
                    <VncProfileTab
                        key={tab.id}
                        tabId={tab.id}
                        profileId={tab.vncProfileId}
                        active={visible && tab.id === activeTabId}
                        registerMenuItems={registerMenuItems}
                    />
                ))}
            </div>
        </>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(
    query.has('direct') ? (
        <StrictMode>
            <DirectFixture />
        </StrictMode>
    ) : (
        <TooltipProvider>
            <ShortcutManager />
            <button
                type="button"
                onClick={() => finishStart?.()}
            >
                Release pending bridge
            </button>
            <WorkspaceContextActions
                connectionId={connectionId}
                tabId={tabId}
                active
                openRequest={0}
                onSetHidden={unavailable}
                onSelectContent={unavailable}
                onRevealAll={unavailable}
            >
                <CombinedTabBar
                    connectionId={connectionId}
                    tabId={tabId}
                    activeView="vnc"
                    activeTerminalId={null}
                    activeFeatureTabId={viewerId}
                    featureTabs={[
                        { id: viewerId, featureId: 'vnc', instanceId: viewerId },
                        { id: siblingId, featureId: 'vnc', instanceId: siblingId },
                    ]}
                    pinnedFeatures={[]}
                    onTabSelect={noop}
                    onPluginTabSelect={noop}
                    onPluginTabClose={noop}
                    onFeatureTabSelect={noop}
                    onFeatureTabClose={noop}
                    onTerminalClose={noop}
                    onNewTerminal={noop}
                    onTogglePin={noop}
                />
                <div id="vnc-fixture-workspace">
                    <VncPane
                        connectionId={connectionId}
                        contentKey={contentKey}
                        visible
                        focused
                    />
                </div>
            </WorkspaceContextActions>
        </TooltipProvider>
    ),
);
