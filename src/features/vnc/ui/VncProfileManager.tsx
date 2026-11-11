import { ArrowLeft, Monitor, ShieldAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { Button } from '../../../components/ui/Button';
import { ConfirmModal } from '../../../components/ui/ConfirmModal';
import { Input } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';
import { Select } from '../../../components/ui/Select';
import { type BaseModalProps, registerModal, useModalStore } from '../../../lib/modalRegistry';
import { useAppStore } from '../../../store/useAppStore';
import { PASSWORD_CREDENTIAL_KIND } from '../../../vault/credentialTypes';
import { vaultIpc } from '../../../vault/ipc';
import { useVaultStore } from '../../../vault/useVaultStore';
import {
    DEFAULT_VNC_PORT,
    DEFAULT_VNC_RESOLUTION,
    DEFAULT_VNC_SCALE,
    normalizeVncHost,
    normalizeVncPort,
    VNC_DIRECT_NETWORK_NOTICE,
    VNC_DIRECT_TLS_NOTICE,
    VNC_PROFILE_NAME_MAX_LENGTH,
    VNC_RESOLUTION_MAX_DIMENSION,
    VNC_RESOLUTION_MAX_PIXELS,
    VNC_RESOLUTION_PRESETS,
    VNC_SCALE_PERCENTAGES,
    VNC_SSH_LOOPBACK,
    type VncProfile,
    type VncResolution,
    type VncResolutionDraft,
    validateVncProfileDraft,
    vncDestinationKey,
} from '../domain/profile';
import { VncCredentialPicker } from './VncCredentialPicker';

const VNC_PROFILE_EDITOR = 'vncProfileEditor';
const DELETE_VNC_PROFILE = 'deleteVncProfile';

const RESOLUTION_PRESET_OPTIONS = VNC_RESOLUTION_PRESETS.map(({ width, height }) => ({
    width,
    height,
    value: `${width}x${height}`,
    label: `${width} × ${height}`,
}));
const RESOLUTION_OPTIONS = [
    { value: 'server', label: 'Keep server resolution' },
    { value: 'auto', label: 'Auto (match pane)' },
    ...RESOLUTION_PRESET_OPTIONS,
    { value: 'custom', label: 'Custom resolution' },
];
const SCALE_OPTIONS = [
    { value: 'fit', label: 'Fit to pane' },
    ...VNC_SCALE_PERCENTAGES.map((percent) => ({ value: String(percent), label: `${percent}%` })),
];
const AUTH_OPTIONS = [
    { value: 'manual', label: 'Ask for password' },
    { value: 'vault', label: 'Saved Vault credential' },
    { value: 'new-password', label: 'Save password to Vault' },
];

const TRANSPORT_OPTIONS = [
    { value: 'direct', label: 'Direct' },
    { value: 'tls', label: 'Direct TLS' },
    { value: 'ssh', label: 'Via SSH' },
];

/** Match a saved fixed size to a preset when possible. */
function resolutionChoice(resolution: VncResolution): string {
    if (resolution.mode !== 'fixed') {
        return resolution.mode;
    }
    return (
        RESOLUTION_PRESET_OPTIONS.find(
            ({ width, height }) => width === resolution.width && height === resolution.height,
        )?.value ?? 'custom'
    );
}

/** Convert the selector and editable dimensions to a single draft resolution. */
function resolutionDraft(choice: string, width: string, height: string): VncResolutionDraft {
    if (choice === 'server' || choice === 'auto') {
        return { mode: choice };
    }
    const preset = RESOLUTION_PRESET_OPTIONS.find((option) => option.value === choice);
    return preset
        ? { mode: 'fixed', width: String(preset.width), height: String(preset.height) }
        : { mode: 'fixed', width, height };
}

interface VncProfileEditorOptions {
    focusDisplay?: boolean;
    onBack?: () => void;
}

/** Open the editor with optional display focus or a return action from its entry point. */
export function openVncProfileEditor(profile?: VncProfile, options: VncProfileEditorOptions = {}) {
    const modals = useModalStore.getState();
    if (!modals.stack.some((entry) => entry.name === VNC_PROFILE_EDITOR && entry.isOpen)) {
        modals.open(VNC_PROFILE_EDITOR, { profile, ...options });
    }
}

/** Confirm removal using the same modal stack as the profile editor. */
export function confirmDeleteVncProfile(profile: VncProfile) {
    const modals = useModalStore.getState();
    if (!modals.stack.some((entry) => entry.name === DELETE_VNC_PROFILE && entry.isOpen)) {
        modals.open(DELETE_VNC_PROFILE, { profile });
    }
}

/** Edit a profile and persist only a reference when using Vault authentication. */
function VncProfileEditor({
    isOpen,
    onClose,
    profile,
    focusDisplay = false,
    onBack,
}: BaseModalProps & VncProfileEditorOptions & { profile?: VncProfile }) {
    const saveProfile = useAppStore((state) => state.saveVncProfile);
    const connections = useAppStore((state) => state.connections);
    const [transport, setTransport] = useState(
        profile?.ssh ? 'ssh' : profile?.tlsUsername ? 'tls' : 'direct',
    );
    const [sshId, setSshId] = useState(profile?.ssh?.id ?? '');
    const viaSsh = transport === 'ssh';
    const viaTls = transport === 'tls';
    const [vncUsername, setVncUsername] = useState(profile?.tlsUsername ?? '');
    const sshHosts = connections.filter(({ id }) => id !== 'local');
    const sshHost = viaSsh ? sshHosts.find(({ id }) => id === sshId) : undefined;
    const ssh = sshHost && {
        id: sshHost.id,
        host: sshHost.host,
        port: sshHost.port,
        username: sshHost.username,
    };
    const initialResolution = profile?.resolution ?? DEFAULT_VNC_RESOLUTION;
    const formId = useId();
    const sshErrorId = useId();
    const resolutionHelp = useId();
    const scaleHelp = useId();
    const [draft, setDraft] = useState({
        name: profile?.name ?? '',
        host: profile?.host ?? '',
        port: String(profile?.port ?? DEFAULT_VNC_PORT),
        resolutionChoice: resolutionChoice(initialResolution),
        width: initialResolution.mode === 'fixed' ? String(initialResolution.width) : '',
        height: initialResolution.mode === 'fixed' ? String(initialResolution.height) : '',
        scale: profile?.scale ?? DEFAULT_VNC_SCALE,
    });
    const [showValidation, setShowValidation] = useState(false);
    const [saveAction, setSaveAction] = useState<'save' | 'connect' | null>(null);
    const saving = saveAction !== null;
    const [saveError, setSaveError] = useState('');
    const [authMode, setAuthMode] = useState(profile?.credentialId ? 'vault' : 'manual');
    const [password, setPassword] = useState('');
    const [vaultLabel, setVaultLabel] = useState<string>();
    const [selection, setSelection] = useState(() =>
        profile?.credentialId
            ? { id: profile.credentialId, endpoint: vncDestinationKey(profile) }
            : undefined,
    );
    const pending = useRef(false);
    const creationId = useRef<string | null>(null);
    const { resolutionChoice: choice, width, height, ...endpointDraft } = draft;
    const host = viaSsh ? VNC_SSH_LOOPBACK : normalizeVncHost(draft.host);
    const port = normalizeVncPort(draft.port);
    const tlsUsername = viaTls ? vncUsername.trim() : undefined;
    const endpoint =
        host && port !== undefined && (!viaSsh || ssh) && (!viaTls || tlsUsername)
            ? vncDestinationKey({ host, port, ssh, tlsUsername })
            : undefined;
    const needsConfirmation = Boolean(selection && selection.endpoint !== endpoint);
    const credentialId = authMode === 'vault' && !needsConfirmation ? selection?.id : undefined;
    const profileDraft = {
        ...endpointDraft,
        host: viaSsh ? VNC_SSH_LOOPBACK : endpointDraft.host,
        ssh,
        tlsUsername,
        resolution: resolutionDraft(choice, width, height),
        credentialId,
    };
    const validation = validateVncProfileDraft(profileDraft);
    const errors = showValidation ? validation.errors : undefined;
    const needsCredential = authMode === 'vault' && !credentialId;
    const creatingPassword = authMode === 'new-password';
    const passwordLabel = (vaultLabel ?? draft.name).trim();
    const credentialError =
        errors?.credentialId ??
        (showValidation && needsCredential
            ? needsConfirmation
                ? 'Select a Vault credential for the new address before saving.'
                : 'Select a password from Vault.'
            : undefined);

    /** Create the credential on submit and link its identity before optionally connecting. */
    async function submit(action: 'save' | 'connect') {
        setShowValidation(true);
        if (!validation.value || (viaSsh && !ssh) || needsCredential || pending.current) {
            return;
        }
        if (creatingPassword && (!password.trim() || !passwordLabel)) {
            return;
        }
        pending.current = true;
        setSaveAction(action);
        setSaveError('');
        let createdCredentialId: string | undefined;
        const savedEndpoint = vncDestinationKey(validation.value);
        try {
            if (creatingPassword) {
                if (!(await useVaultStore.getState().requestUnlock())) {
                    setSaveError('Unlock Vault to save this password.');
                    return;
                }
                if (useVaultStore.getState().items.some(({ label }) => label === passwordLabel)) {
                    setSaveError(
                        'That name already exists in Vault. Choose another name or link the existing password.',
                    );
                    return;
                }
                try {
                    const item = await vaultIpc.itemCreate(
                        passwordLabel,
                        PASSWORD_CREDENTIAL_KIND,
                        {
                            password,
                        },
                    );
                    createdCredentialId = item.logicalId;
                    setPassword('');
                } catch {
                    setSaveError(
                        'Could not save the password to Vault. Check that Vault is unlocked and try again.',
                    );
                    return;
                }
            }
            if (!profile) {
                creationId.current ??= crypto.randomUUID();
            }
            const saved = await saveProfile(
                { ...profileDraft, credentialId: createdCredentialId ?? credentialId },
                profile?.id,
                creationId.current ? { creationId: creationId.current } : undefined,
            );
            onClose();
            if (action === 'connect') {
                useAppStore.getState().openVncTab(saved.id, { connect: true });
            }
            if (createdCredentialId) {
                void useVaultStore
                    .getState()
                    .refresh()
                    .catch(() => {});
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (createdCredentialId) {
                // Settings can report a reload conflict after writing the profile to disk.
                // Keep the credential and reuse it if the user retries the profile save.
                setSelection({ id: createdCredentialId, endpoint: savedEndpoint });
                setAuthMode('vault');
                setSaveError(`Password saved in Vault. ${message}`);
            } else {
                setSaveError(message);
            }
        } finally {
            pending.current = false;
            setSaveAction(null);
        }
    }

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={profile ? 'Edit VNC profile' : 'Add VNC profile'}
            subtitle="Save a remote desktop on this device."
            explicitDismissOnly={saving}
            contentClassName="flex min-h-0 flex-col overflow-hidden p-0"
        >
            <form
                id={formId}
                className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-6"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit('save');
                }}
            >
                <Input
                    label="Profile name"
                    placeholder="Office desktop"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    error={errors?.name}
                    maxLength={VNC_PROFILE_NAME_MAX_LENGTH}
                    autoFocus={!focusDisplay}
                    required
                    disabled={saving}
                />
                <Select
                    label="Connection route"
                    value={transport}
                    options={TRANSPORT_OPTIONS}
                    onChange={setTransport}
                    disabled={saving}
                    showSearch={false}
                    portal
                />
                <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
                    {viaSsh ? (
                        <div>
                            <Select
                                label="SSH host"
                                placeholder="Choose a saved SSH host"
                                value={sshId}
                                options={sshHosts.map(({ id, name, host, username }) => ({
                                    value: id,
                                    label: name || host,
                                    description: `${username}@${host}`,
                                }))}
                                onChange={setSshId}
                                ariaDescribedBy={sshErrorId}
                                disabled={saving}
                                portal
                            />
                            <p
                                id={sshErrorId}
                                className="mt-1 text-xs text-control-danger"
                            >
                                {showValidation && !ssh ? 'Choose a saved SSH host.' : errors?.ssh}
                            </p>
                        </div>
                    ) : (
                        <Input
                            label="Host or IP address"
                            placeholder="desktop.example.com"
                            value={draft.host}
                            onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                            error={errors?.host}
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                            required
                            disabled={saving}
                        />
                    )}
                    <Input
                        label={viaSsh ? 'VNC port' : 'Port'}
                        inputMode="numeric"
                        value={draft.port}
                        onChange={(event) => setDraft({ ...draft, port: event.target.value })}
                        error={errors?.port}
                        required
                        disabled={saving}
                    />
                </div>
                {viaTls && (
                    <Input
                        label="VNC username"
                        value={vncUsername}
                        onChange={(event) => setVncUsername(event.target.value)}
                        error={errors?.tlsUsername}
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        disabled={saving}
                    />
                )}
                <div className="space-y-2">
                    <Select
                        label="VNC authentication"
                        value={authMode}
                        options={AUTH_OPTIONS}
                        onChange={(mode) => {
                            setAuthMode(mode);
                            setSaveError('');
                            if (mode !== 'new-password') {
                                setPassword('');
                            }
                        }}
                        disabled={saving}
                        showSearch={false}
                        portal
                    />
                    {authMode === 'vault' && (
                        <VncCredentialPicker
                            credentialId={credentialId}
                            endpointReady={endpoint !== undefined}
                            needsConfirmation={needsConfirmation}
                            disabled={saving}
                            error={credentialError}
                            onSelect={(id) => {
                                if (endpoint !== undefined) {
                                    setSelection({ id, endpoint });
                                }
                            }}
                        />
                    )}
                    {creatingPassword && (
                        <div className="space-y-2">
                            <Input
                                label="Password"
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                error={
                                    showValidation && !password.trim()
                                        ? 'Enter a password.'
                                        : undefined
                                }
                                required
                                disabled={saving}
                            />
                            <Input
                                label="Name in Vault"
                                value={vaultLabel ?? draft.name}
                                onChange={(event) => setVaultLabel(event.target.value)}
                                error={
                                    showValidation && !passwordLabel
                                        ? 'Enter a name for the saved password.'
                                        : undefined
                                }
                                required
                                disabled={saving}
                            />
                            <p className="text-xs text-app-muted">
                                Saving encrypts the password in Vault and links it to this profile.
                            </p>
                        </div>
                    )}
                </div>
                <div className="space-y-1">
                    <Select
                        label="Remote resolution"
                        ariaDescribedBy={resolutionHelp}
                        value={choice}
                        options={RESOLUTION_OPTIONS}
                        onChange={(resolutionChoice) => setDraft({ ...draft, resolutionChoice })}
                        autoFocus={focusDisplay}
                        disabled={saving}
                        showSearch={false}
                        portal
                    />
                    <p
                        id={resolutionHelp}
                        className="text-xs text-app-muted"
                    >
                        Preset and custom sizes are requested once per connection when the server
                        supports resizing.
                    </p>
                </div>
                {choice === 'custom' && (
                    <div className="space-y-1">
                        <div className="grid grid-cols-2 gap-3">
                            <Input
                                label="Width (pixels)"
                                inputMode="numeric"
                                value={width}
                                onChange={(event) =>
                                    setDraft({ ...draft, width: event.target.value })
                                }
                                error={errors?.width}
                                disabled={saving}
                                required
                            />
                            <Input
                                label="Height (pixels)"
                                inputMode="numeric"
                                value={height}
                                onChange={(event) =>
                                    setDraft({ ...draft, height: event.target.value })
                                }
                                error={errors?.height}
                                disabled={saving}
                                required
                            />
                        </div>
                        <p className="text-xs text-app-muted">
                            Up to {VNC_RESOLUTION_MAX_DIMENSION.toLocaleString('en-US')} pixels per
                            side and {VNC_RESOLUTION_MAX_PIXELS.toLocaleString('en-US')} pixels
                            total.
                        </p>
                    </div>
                )}
                {errors?.resolution && (
                    <p
                        className="text-xs text-control-danger"
                        role="alert"
                    >
                        {errors.resolution}
                    </p>
                )}
                <div className="space-y-1">
                    <Select
                        label="Viewer scale"
                        ariaDescribedBy={scaleHelp}
                        value={String(draft.scale)}
                        options={SCALE_OPTIONS}
                        onChange={(value) =>
                            setDraft({
                                ...draft,
                                scale:
                                    VNC_SCALE_PERCENTAGES.find(
                                        (percent) => String(percent) === value,
                                    ) ?? DEFAULT_VNC_SCALE,
                            })
                        }
                        disabled={saving}
                        showSearch={false}
                        portal
                    />
                    <p
                        id={scaleHelp}
                        className="text-xs text-app-muted"
                    >
                        Changes the local zoom in the viewer.
                    </p>
                </div>
                <div className="flex gap-2.5 rounded-lg border border-app-border bg-app-surface/40 p-3 text-xs text-app-muted">
                    <ShieldAlert
                        size={16}
                        className="mt-0.5 shrink-0 text-app-accent"
                        aria-hidden
                    />
                    <div className="space-y-1">
                        <p>
                            {viaSsh
                                ? 'Zync uses SSH to reach the VNC server listening on the selected host’s loopback address.'
                                : viaTls
                                  ? VNC_DIRECT_TLS_NOTICE
                                  : VNC_DIRECT_NETWORK_NOTICE}
                        </p>
                        <p>Zync uses the saved password only if the server requests one.</p>
                    </div>
                </div>
            </form>
            <div className="shrink-0 space-y-2 border-t border-app-border px-4 py-3">
                {saveError && (
                    <p
                        className="text-xs text-control-danger"
                        role="alert"
                    >
                        {saveError}
                    </p>
                )}
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {onBack && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="mr-auto gap-1"
                            disabled={saving}
                            onClick={() => {
                                onClose();
                                onBack();
                            }}
                        >
                            <ArrowLeft
                                size={14}
                                aria-hidden
                            />{' '}
                            Back
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={onClose}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        form={formId}
                        variant="secondary"
                        size="sm"
                        disabled={saving}
                        isLoading={saveAction === 'save'}
                    >
                        Save profile
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        disabled={saving}
                        isLoading={saveAction === 'connect'}
                        onClick={() => void submit('connect')}
                    >
                        <Monitor
                            size={15}
                            aria-hidden
                        />{' '}
                        Save &amp; Connect
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

/** Remove the selected profile and report any storage error inside the confirmation. */
function DeleteVncProfileDialog({
    isOpen,
    onClose,
    profile,
}: BaseModalProps & { profile: VncProfile }) {
    const remove = useAppStore((state) => state.deleteVncProfile);
    const [removing, setRemoving] = useState(false);
    const [error, setError] = useState('');
    const pending = useRef(false);

    /** A failed write leaves both the saved endpoint and any open viewer available. */
    async function confirm() {
        if (pending.current) {
            return;
        }
        pending.current = true;
        setRemoving(true);
        setError('');
        try {
            await remove(profile.id);
            onClose();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            pending.current = false;
            setRemoving(false);
        }
    }

    return (
        <ConfirmModal
            isOpen={isOpen}
            onClose={() => {
                if (!pending.current) {
                    onClose();
                }
            }}
            onConfirm={confirm}
            title="Delete VNC profile?"
            message={
                <>
                    Remove <strong>{profile.name}</strong> from this device and close its viewer if
                    open.
                    {error && (
                        <span
                            className="mt-2 block text-control-danger"
                            role="alert"
                        >
                            {error}
                        </span>
                    )}
                </>
            }
            confirmLabel="Delete profile"
            variant="danger"
            isLoading={removing}
        />
    );
}

registerModal(VNC_PROFILE_EDITOR, VncProfileEditor);
registerModal(DELETE_VNC_PROFILE, DeleteVncProfileDialog);
