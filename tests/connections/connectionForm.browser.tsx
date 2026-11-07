import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { createRoot } from 'react-dom/client';

import { GlobalNetworkInterfaceModal } from '../../src/components/connections/GlobalNetworkInterfaceModal';
import { GlobalSshVerificationDialog } from '../../src/components/connections/GlobalSshVerificationDialog';
import { AddConnectionModal } from '../../src/components/modals/AddConnectionModal';
import { Button } from '../../src/components/ui/Button';
import { ModalRoot } from '../../src/components/ui/ModalRoot';
import type { Connection } from '../../src/features/connections/domain/types';
import type { SshVerificationRequest } from '../../src/features/connections/infrastructure/sshVerificationIpc';
import type { VncProfile } from '../../src/features/vnc/domain/profile';
import { openVncProfileEditor } from '../../src/features/vnc/ui/VncProfileManager';
import { useAppStore } from '../../src/store/useAppStore';
import type { VaultItem } from '../../src/vault/ipc';
import '../../src/index.css';
import '../uiOverlays.browser.css';

const keyHost: Connection = {
    id: 'fixture-key',
    name: 'Lab',
    host: 'fixture.invalid',
    port: 22222,
    username: 'fixture',
    privateKeyPath: 'C:\\fixture\\client',
    status: 'disconnected',
};
interface PendingTest {
    resolve: (result: string) => void;
    reject: (error: Error) => void;
    channel?: { id: number };
    round: number;
}
const pendingTests: PendingTest[] = [];
const callbacks = new Map<number, (payload: object) => void>();
let nextCallbackId = 0;
let certificateDialogAttempt = 0;
let savedVncProfiles: VncProfile[] = [];
let reloadedCommittedVncProfile = false;
let nextVaultItemId = 0;
const createdVaultItems = new Map<string, VaultItem>();
export type VncFixtureWrite =
    | { type: 'create'; item: VaultItem; secretValues?: Record<string, string> }
    | { type: 'delete'; itemId: string }
    | { type: 'save-profile'; profiles: VncProfile[] };
const vncWrites: VncFixtureWrite[] = [];
const vaultItemMetadata = {
    secretFingerprint: 'fixture-fingerprint',
    schemaVersion: 2,
    secretFieldCount: 1,
    hasPassphraseField: false,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
};

/** Expose the write order across the mocked Vault and settings boundaries. */
function recordVncWrite(event: VncFixtureWrite) {
    vncWrites.push(event);
    document.body.dataset.vncWrites = JSON.stringify(vncWrites);
}

/** Simulate one native challenge round and the real Tauri channel delivery shape. */
function deliverVerification(test: PendingTest) {
    if (!test.channel) {
        throw new Error('Missing SSH verification channel');
    }
    const request: SshVerificationRequest = {
        attemptId: 'fixture-attempt',
        requestId: `fixture-round-${test.channel.id}-${test.round}`,
        host: 'jump.fixture.invalid',
        port: 2222,
        username: 'fixture',
        title: 'Fixture verification',
        instructions: 'Follow the server prompts.',
        prompts:
            test.round === 0
                ? [
                      { index: 0, label: 'Account label', echo: true },
                      { index: 1, label: 'Verification code', echo: false },
                  ]
                : [{ index: 0, label: 'Backup code', echo: false }],
    };
    const index = test.round++;
    callbacks.get(test.channel.id)?.({ index, message: request });
}

/** Close the fixture channel before resolving its invocation. */
function finishFixtureTest(test: PendingTest | undefined, error?: Error) {
    if (!test) {
        return;
    }
    if (test.channel) {
        callbacks.get(test.channel.id)?.({ index: test.round, end: true });
    }
    if (error) {
        test.reject(error);
    } else {
        test.resolve('ok');
    }
}

// Mock the dialog plugin itself so production Browse handling is exercised without native UI.
Object.assign(window, {
    __TAURI_INTERNALS__: {
        transformCallback(callback: (payload: object) => void) {
            const id = ++nextCallbackId;
            callbacks.set(id, callback);
            return id;
        },
        unregisterCallback(id: number) {
            callbacks.delete(id);
        },
        async invoke(
            command: string,
            args?: {
                attemptId?: string;
                requestId?: string;
                responses?: string[] | null;
                settings?: { vncProfiles?: VncProfile[] };
                args?: {
                    credential_id?: string;
                    item_id?: string;
                    kind?: string;
                    label?: string;
                    secret_values?: Record<string, string>;
                };
            },
        ) {
            if (command === 'serial_list_ports') {
                return [
                    {
                        id: 'COM1',
                        label: 'COM1 · Connection fixture',
                        documentId: 'connection-fixture',
                    },
                ];
            }
            if (command === 'settings_get') {
                return { vncProfiles: structuredClone(savedVncProfiles) };
            }
            if (command === 'vault_status') {
                return {
                    status: 'unlocked',
                    vaultId: 'fixture-vault',
                    itemCount: 4 + createdVaultItems.size,
                };
            }
            if (command === 'vault_item_list') {
                return [
                    {
                        ...vaultItemMetadata,
                        id: 'vnc-item',
                        logicalId: 'vnc-logical',
                        kind: 'vnc-password',
                        label: 'Fixture VNC password',
                    },
                    {
                        ...vaultItemMetadata,
                        id: 'ssh-item',
                        logicalId: 'ssh-logical',
                        kind: 'ssh-password',
                        label: 'Fixture SSH password',
                    },
                    {
                        ...vaultItemMetadata,
                        id: 'key-item',
                        logicalId: 'key-logical',
                        kind: 'ssh-private-key',
                        label: 'Fixture private key',
                    },
                    {
                        ...vaultItemMetadata,
                        id: 'token-item',
                        logicalId: 'token-logical',
                        kind: 'api-token',
                        label: 'Fixture API token',
                    },
                    ...createdVaultItems.values(),
                ];
            }
            if (command === 'vault_item_create' && args?.args?.kind && args.args.label) {
                const { kind, label, secret_values, credential_id } = args.args;
                const id = ++nextVaultItemId;
                const item = {
                    ...vaultItemMetadata,
                    id: `created-item-${id}`,
                    logicalId: credential_id ?? `created-logical-${id}`,
                    kind,
                    label,
                };
                createdVaultItems.set(item.id, item);
                recordVncWrite({ type: 'create', item, secretValues: secret_values });
                return item;
            }
            if (command === 'vault_item_delete' && args?.args?.item_id) {
                const { item_id } = args.args;
                if (!createdVaultItems.delete(item_id)) {
                    throw new Error('Only a newly created fixture item can be rolled back.');
                }
                recordVncWrite({ type: 'delete', itemId: item_id });
                return;
            }
            if (command === 'settings_set' && args?.settings?.vncProfiles) {
                recordVncWrite({ type: 'save-profile', profiles: args.settings.vncProfiles });
                if (
                    args.settings.vncProfiles.some(
                        ({ host }) => host === 'fail-save.fixture.invalid',
                    )
                ) {
                    throw new Error('Fixture could not save the VNC profile.');
                }
                savedVncProfiles = structuredClone(args.settings.vncProfiles);
                if (
                    !reloadedCommittedVncProfile &&
                    savedVncProfiles.some(
                        ({ host }) => host === 'post-commit-reload.fixture.invalid',
                    )
                ) {
                    reloadedCommittedVncProfile = true;
                    await useAppStore.getState().loadSettings();
                }
                return;
            }
            if (command === 'ssh_verification_reply') {
                const test = pendingTests[0];
                if (
                    !test?.channel ||
                    args?.responses === undefined ||
                    args.attemptId !== 'fixture-attempt' ||
                    args.requestId !== `fixture-round-${test.channel.id}-${test.round - 1}`
                ) {
                    throw new Error('Unexpected verification reply identity');
                }
                if (args.responses === null) {
                    document.body.dataset.verificationReply = 'cancelled';
                    finishFixtureTest(
                        pendingTests.shift(),
                        new Error('SSH verification cancelled'),
                    );
                } else if (
                    args.responses.some((answer) => new TextEncoder().encode(answer).length > 4096)
                ) {
                    throw new Error('SSH verification responses must be at most 4096 bytes');
                } else if (
                    test.round === 1 &&
                    args.responses[0] === 'account' &&
                    args.responses[1] === '012345'
                ) {
                    deliverVerification(test);
                } else if (test.round === 2 && args.responses[0] === 'backup') {
                    document.body.dataset.verificationReply = 'accepted';
                    finishFixtureTest(pendingTests.shift());
                } else {
                    finishFixtureTest(
                        pendingTests.shift(),
                        new Error('SSH verification was rejected'),
                    );
                }
                return;
            }
            if (command !== 'plugin:dialog|open') {
                throw new Error(`Unexpected Tauri fixture call: ${command}`);
            }
            certificateDialogAttempt++;
            if (certificateDialogAttempt === 1) {
                throw new Error('fixture dialog failure');
            }
            if (certificateDialogAttempt === 2) {
                throw 'fixture string failure';
            }
            if (certificateDialogAttempt === 3) {
                return 'C:\\fixture\\picked-cert.pub';
            }
            return null;
        },
    },
});

// Test-only native boundary: no credentials, sockets, adapters or files are accessed.
window.ipcRenderer = {
    async invoke(channel: string, _config: unknown, verificationChannel?: { id: number }) {
        if (channel === 'ssh:importConfigBySource') {
            return [
                {
                    ...keyHost,
                    id: 'import-fixture',
                    name: 'Repeated certificates fixture',
                    certificatePath: '/first.pub',
                    privateKeyStatus: 'passphraseRequired',
                    certificateWarning:
                        'Multiple CertificateFile entries: only the first is imported. Review the certificate after import.',
                },
            ];
        }
        if (channel === 'ssh:test') {
            return new Promise<string>((resolve, reject) => {
                pendingTests.push({ resolve, reject, channel: verificationChannel, round: 0 });
            });
        }
        if (channel === 'ssh:networkPreference') {
            return { mode: 'default' };
        }
        if (channel === 'ssh:setNetworkPreference') {
            return;
        }
        if (channel === 'ssh:networkInterfaces') {
            return [
                {
                    id: 'wifi',
                    name: 'Wi-Fi fixture',
                    description: 'Fixture wireless driver',
                    kind: 'wifi',
                    addresses: ['fe80::12', '192.0.2.5'],
                    available: true,
                },
                {
                    id: 'loopback',
                    name: 'Loopback fixture',
                    kind: 'loopback',
                    addresses: ['::1', '127.0.0.1'],
                    available: true,
                },
            ];
        }
        if (channel === 'ssh:private-key-readiness' || channel === 'ssh:inspect-private-key') {
            return { status: 'valid', encrypted: false };
        }
        throw new Error(`Unexpected native call in host form fixture: ${channel}`);
    },
} as typeof window.ipcRenderer;

useAppStore.setState({
    connections: [keyHost],
    folders: [{ name: 'Development' }],
    isLoadingSettings: false,
    isAddConnectionModalOpen: true,
    addConnection: async (connection) => {
        document.body.dataset.savedSshConnection = JSON.stringify(connection);
        useAppStore.setState((state) => ({ connections: [...state.connections, connection] }));
    },
    editConnection: async (connection) => {
        useAppStore.setState((state) => ({
            connections: state.connections.map((item) =>
                item.id === connection.id ? connection : item,
            ),
        }));
    },
    openTab: () => {},
    openVncTab: (profileId, options) => {
        const saved = savedVncProfiles.find(({ id }) => id === profileId);
        if (!saved) {
            throw new Error('The VNC viewer was opened before the profile was saved.');
        }
        document.body.dataset.vncOpen = JSON.stringify({
            host: saved.host,
            connect: options?.connect,
        });
    },
    showToast: (type, message) => {
        document.body.dataset.fixtureToast = `${type}:${message}`;
    },
});
/** Reopen the saved profile from the native fixture instead of the existing in-memory copy. */
async function editReloadedVncProfile() {
    useAppStore.setState((state) => ({ settings: { ...state.settings, vncProfiles: [] } }));
    await useAppStore.getState().loadSettings();
    const profile = useAppStore.getState().settings.vncProfiles[0];
    if (!profile) {
        throw new Error('Expected a saved VNC profile after reloading settings');
    }
    openVncProfileEditor(profile);
}

/** Production modal with deterministic native ports; the controls expose delayed-result regressions. */
function Fixture() {
    const open = useAppStore((state) => state.isAddConnectionModalOpen);
    const editing = useAppStore((state) => state.editingConnectionId);
    const openConnectionModal = useAppStore((state) => state.openConnectionModal);
    const setAddConnectionModalOpen = useAppStore((state) => state.setAddConnectionModalOpen);
    return (
        <TooltipProvider>
            <main className="p-5 text-app-text">
                <div className="flex flex-wrap gap-3">
                    <Button onClick={() => openConnectionModal()}>New host fixture</Button>
                    <Button onClick={() => openConnectionModal(keyHost.id)}>
                        Key host fixture
                    </Button>
                    <Button onClick={editReloadedVncProfile}>Edit reloaded VNC profile</Button>
                    <Button
                        onClick={async () => {
                            const profile = savedVncProfiles[0];
                            if (profile) {
                                await useAppStore.getState().deleteVncProfile(profile.id);
                                document.body.dataset.deletedVncProfile = profile.id;
                            }
                        }}
                    >
                        Delete first VNC profile
                    </Button>
                    <Button onClick={() => finishFixtureTest(pendingTests.shift())}>
                        Finish test
                    </Button>
                    <Button
                        onClick={() =>
                            finishFixtureTest(
                                pendingTests.shift(),
                                new Error('Connection refused (os error 10061)'),
                            )
                        }
                    >
                        Reject test
                    </Button>
                    <Button onClick={() => Object.assign(window, { isTauri: true })}>
                        Enable SSH verification fixture
                    </Button>
                    <Button
                        onClick={() => {
                            if (pendingTests[0]) {
                                deliverVerification(pendingTests[0]);
                            }
                        }}
                    >
                        Request SSH verification
                    </Button>
                    <Button
                        onClick={() =>
                            useAppStore.setState((state) => ({
                                connections: state.connections.map((connection) => ({
                                    ...connection,
                                    status: 'connected',
                                    lastConnected: Date.now(),
                                    homePath: '/fixture/home',
                                })),
                            }))
                        }
                    >
                        Update connection status
                    </Button>
                    <Button
                        onClick={() => {
                            document.body.dataset.overlayGalleryTheme =
                                document.body.dataset.overlayGalleryTheme === 'light'
                                    ? 'dark'
                                    : 'light';
                        }}
                    >
                        Toggle theme
                    </Button>
                </div>
                <ModalRoot />
                <AddConnectionModal
                    isOpen={open}
                    editingConnectionId={editing}
                    onClose={() => setAddConnectionModalOpen(false)}
                />
                <GlobalNetworkInterfaceModal />
                <GlobalSshVerificationDialog />
            </main>
        </TooltipProvider>
    );
}

document.body.dataset.overlayGalleryTheme = 'dark';
createRoot(document.getElementById('root')!).render(<Fixture />);
