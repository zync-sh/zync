import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AddCredentialModal } from '../../src/components/settings/tabs/vault/AddCredentialModal';
import { useAddCredentialModal } from '../../src/components/settings/tabs/vault/hooks/useAddCredentialModal';
import { useRotateCredentialModal } from '../../src/components/settings/tabs/vault/hooks/useRotateCredentialModal';
import { RotateCredentialModal } from '../../src/components/settings/tabs/vault/RotateCredentialModal';
import { VaultSshCertificateEditor } from '../../src/components/settings/tabs/vault/VaultSshCertificateEditor';
import type { VaultItem, VaultItemDetail } from '../../src/vault/ipc';
import '../../src/index.css';
import '../uiOverlays.browser.css';

const item: VaultItem = {
    id: 'fixture-item',
    logicalId: 'fixture-credential',
    kind: 'ssh-private-key',
    label: 'Fixture key',
    secretFingerprint: 'fixture-fingerprint',
    schemaVersion: 2,
    secretFieldCount: 2,
    hasPassphraseField: false,
    hasSshCertificateField: true,
    revision: 3,
    createdAt: 10,
    updatedAt: 20,
};
const legacyPassword: VaultItem = {
    ...item,
    id: 'legacy-vnc-item',
    logicalId: 'legacy-vnc-password',
    kind: 'vnc-password',
    label: 'Legacy VNC password',
    secretFieldCount: 1,
    hasSshCertificateField: false,
};
const detail: VaultItemDetail = {
    ...item,
    credential: {
        credentialId: item.logicalId,
        kind: 'ssh-private-key',
        label: item.label,
        fields: [
            {
                name: 'sshCertificate',
                label: 'SSH user certificate',
                secret: true,
                valueRef: 'secret:sshCertificate',
            },
        ],
        metadata: {},
        tags: [],
        revision: 3,
        createdAt: 10,
        updatedAt: 20,
        schemaVersion: 2,
    },
};
const calls: { command: string; args: Record<string, unknown> }[] = [];
const fileReads: { command: string; args: Record<string, unknown> }[] = [];
const pendingReads: ((text: string) => void)[] = [];
Object.assign(window, {
    __TAURI_INTERNALS__: {
        async invoke(command: string, payload: { args: Record<string, unknown> }) {
            // File fixtures test the real picker/read boundary without touching device files or credentials.
            if (command === 'plugin:dialog|open') {
                document.body.dataset.pickerOptions = JSON.stringify(payload);
                if (document.body.dataset.fileMode === 'cancel') {
                    return null;
                }
                if (document.body.dataset.fileMode === 'picker-error') {
                    throw new Error('Fixture picker failure');
                }
                return '/fixture/selected-file';
            }
            if (command === 'fs_read_file') {
                fileReads.push({ command, args: payload as unknown as Record<string, unknown> });
                document.body.dataset.fileReads = JSON.stringify(fileReads);
                if (document.body.dataset.fileMode === 'read-error') {
                    throw 'Fixture read failure';
                }
                if (document.body.dataset.fileMode === 'delayed') {
                    return new Promise<string>((resolve) => {
                        pendingReads.push(resolve);
                    });
                }
                return document.body.dataset.fileText || '';
            }
            const args = payload.args;
            calls.push({ command, args });
            document.body.dataset.calls = JSON.stringify(calls);
            if (command === 'vault_item_get') {
                return args.item_id === legacyPassword.id ? legacyPassword : detail;
            }
            if (args.certificate === 'wrong certificate') {
                throw { message: 'SSH user certificate does not match the selected private key' };
            }
            return {
                ...item,
                revision: 4,
                secretFingerprint: 'updated-fingerprint',
                hasSshCertificateField: args.certificate !== null,
            };
        },
    },
});

/** Production hooks/controls with a deterministic native boundary, never device credentials. */
function Fixture() {
    const [mode, setMode] = useState('');
    const [current, setCurrent] = useState(detail);
    const showToast = (_type: unknown, message: string) => {
        document.body.dataset.toast = message;
    };
    const add = useAddCredentialModal({ isUnlocked: true, showToast, onCreated: async () => {} });
    const rotate = useRotateCredentialModal({
        items: [item, legacyPassword],
        connections: [],
        showToast,
        onRotated: async () => {},
        onPromptDisconnect: async () => {},
    });
    return (
        <main className="p-6 text-app-text">
            <button
                onClick={() => {
                    setMode('add');
                    add.open();
                }}
            >
                Add fixture
            </button>
            <button
                onClick={() => {
                    setMode('rotate');
                    void rotate.open(item.id);
                }}
            >
                Rotate fixture
            </button>
            <button
                onClick={() => {
                    setMode('rotate');
                    void rotate.open(legacyPassword.id);
                }}
            >
                Rotate legacy password fixture
            </button>
            <button
                onClick={() => {
                    setMode('edit');
                    setCurrent(detail);
                }}
            >
                Edit certificate fixture
            </button>
            <button
                onClick={() => {
                    pendingReads.shift()?.(document.body.dataset.fileText || '');
                }}
            >
                Finish file read
            </button>
            <button onClick={() => void add.submit()}>Submit add directly</button>
            <button onClick={() => void rotate.submit()}>Submit rotation directly</button>
            {mode === 'edit' && (
                <VaultSshCertificateEditor
                    key={`${current.revision}:${current.secretFingerprint}`}
                    item={current}
                    onUpdated={async (updated) => {
                        setCurrent({
                            ...detail,
                            revision: updated.revision,
                            secretFingerprint: updated.secretFingerprint,
                            credential: {
                                ...detail.credential!,
                                fields: updated.hasSshCertificateField
                                    ? detail.credential!.fields
                                    : [],
                            },
                        });
                    }}
                />
            )}
            <AddCredentialModal
                isOpen={add.isOpen}
                kind={add.kind}
                label={add.label}
                secret={add.secret}
                passphrase={add.passphrase}
                certificate={add.certificate}
                notes={add.notes}
                isCreating={add.isCreating}
                isImporting={add.isImporting}
                onImportStart={add.beginImport}
                onClose={add.close}
                onKindChange={add.setKind}
                onLabelChange={add.setLabel}
                onSecretChange={add.setSecret}
                onPassphraseChange={add.setPassphrase}
                onCertificateChange={add.setCertificate}
                onNotesChange={add.setNotes}
                onSubmit={() => void add.submit()}
            />
            <RotateCredentialModal
                isOpen={rotate.isOpen}
                item={rotate.item}
                label={rotate.label}
                secret={rotate.secret}
                passphrase={rotate.passphrase}
                certificate={rotate.certificate}
                notes={rotate.notes}
                isLoading={rotate.isLoading}
                isImporting={rotate.isImporting}
                onImportStart={rotate.beginImport}
                onClose={rotate.close}
                onLabelChange={rotate.setLabel}
                onSecretChange={rotate.setSecret}
                onPassphraseChange={rotate.setPassphrase}
                onCertificateChange={rotate.setCertificate}
                onNotesChange={rotate.setNotes}
                onSubmit={() => void rotate.submit()}
            />
        </main>
    );
}
document.body.dataset.overlayGalleryTheme = 'dark';
createRoot(document.getElementById('root')!).render(<Fixture />);
