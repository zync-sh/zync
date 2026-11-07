import { ArrowLeft, Cable } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '../../../components/ui/Button';
import { ConfirmModal } from '../../../components/ui/ConfirmModal';
import { Input } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';
import { type BaseModalProps, registerModal, useModalStore } from '../../../lib/modalRegistry';
import { useAppStore } from '../../../store/useAppStore';
import {
    SERIAL_PROFILE_NAME_MAX_LENGTH,
    type SerialProfile,
    type SerialProfileDraft,
    validateSerialProfileDraft,
} from '../domain/profile';
import { DEFAULT_SERIAL_SETTINGS } from '../domain/serialSettings';
import { listSerialPorts, type SerialPort, serialError } from '../infrastructure/serialSession';
import { SerialSettingsFields } from './SerialSettingsFields';

const SERIAL_PROFILE_EDITOR = 'serialProfileEditor';
const DELETE_SERIAL_PROFILE = 'deleteSerialProfile';

interface SerialProfileEditorOptions {
    onBack?: () => void;
}

/** Open one profile editor through the same modal stack as SSH and VNC setup. */
export function openSerialProfileEditor(
    profile?: SerialProfile,
    options: SerialProfileEditorOptions = {},
) {
    const modals = useModalStore.getState();
    if (!modals.stack.some((entry) => entry.name === SERIAL_PROFILE_EDITOR && entry.isOpen)) {
        modals.open(SERIAL_PROFILE_EDITOR, { profile, ...options });
    }
}

/** Request explicit confirmation before removing a saved device and its open tab. */
export function confirmDeleteSerialProfile(profile: SerialProfile) {
    const modals = useModalStore.getState();
    if (!modals.stack.some((entry) => entry.name === DELETE_SERIAL_PROFILE && entry.isOpen)) {
        modals.open(DELETE_SERIAL_PROFILE, { profile });
    }
}

/** Save device-local metadata; native port authorization is obtained only when connecting. */
function SerialProfileEditor({
    isOpen,
    onClose,
    profile,
    onBack,
}: BaseModalProps & SerialProfileEditorOptions & { profile?: SerialProfile }) {
    const saveProfile = useAppStore((state) => state.saveSerialProfile);
    const formId = useId();
    const [draft, setDraft] = useState<SerialProfileDraft>(() => ({
        name: profile?.name ?? '',
        portId: profile?.portId ?? '',
        baud: String(profile?.settings.baudRate ?? DEFAULT_SERIAL_SETTINGS.baudRate),
        settings: { ...(profile?.settings ?? DEFAULT_SERIAL_SETTINGS) },
        lineEnding: profile?.lineEnding ?? 'cr',
    }));
    const [ports, setPorts] = useState<SerialPort[]>([]);
    const [scanning, setScanning] = useState(true);
    const [scanError, setScanError] = useState('');
    const [showValidation, setShowValidation] = useState(false);
    const [saveAction, setSaveAction] = useState<'save' | 'connect' | null>(null);
    const [saveError, setSaveError] = useState('');
    const [connectAfterSave, setConnectAfterSave] = useState(false);
    const pending = useRef(false);
    const creationId = useRef<string | null>(null);
    const scanId = useRef(0);
    const saving = saveAction !== null;
    const validation = validateSerialProfileDraft(draft);
    const errors = showValidation ? validation.errors : undefined;
    const missingPort = Boolean(draft.portId && !ports.some(({ id }) => id === draft.portId));
    const portOptions = missingPort
        ? [{ id: draft.portId, label: `${draft.portId} · Unavailable` }, ...ports]
        : ports;

    /** Refresh discovery without replacing a saved or explicitly selected device. */
    const refreshPorts = useCallback(async () => {
        const request = ++scanId.current;
        setScanning(true);
        setScanError('');
        try {
            const found = await listSerialPorts();
            if (request !== scanId.current) {
                return;
            }
            setPorts(found);
            setDraft((current) =>
                current.portId ? current : { ...current, portId: found[0]?.id ?? '' },
            );
        } catch (cause) {
            if (request === scanId.current) {
                setScanError(serialError(cause));
            }
        } finally {
            if (request === scanId.current) {
                setScanning(false);
            }
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            void refreshPorts();
        }
        return () => {
            scanId.current++;
        };
    }, [isOpen, refreshPorts]);

    /** Persist first, then pass one foreground-only connect request to the saved tab. */
    async function submit(action: 'save' | 'connect') {
        setShowValidation(true);
        if (!validation.value || pending.current) {
            return;
        }
        pending.current = true;
        setSaveAction(action);
        setSaveError('');
        try {
            if (!profile) {
                creationId.current ??= crypto.randomUUID();
            }
            const saved = await saveProfile(
                draft,
                profile?.id,
                creationId.current ? { creationId: creationId.current } : undefined,
            );
            setConnectAfterSave(action === 'connect');
            onClose();
            if (action === 'connect') {
                useAppStore.getState().openSerialTab(saved.id, { connect: true });
            }
        } catch (cause) {
            setSaveError(serialError(cause));
        } finally {
            pending.current = false;
            setSaveAction(null);
        }
    }

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={profile ? 'Edit Serial profile' : 'Add Serial profile'}
            subtitle="Save a serial device on this computer."
            explicitDismissOnly={saving}
            restoreFocus={!connectAfterSave}
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
                    placeholder="Router console"
                    value={draft.name}
                    onChange={(event) =>
                        setDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    error={errors?.name}
                    maxLength={SERIAL_PROFILE_NAME_MAX_LENGTH}
                    autoFocus
                    required
                    disabled={saving}
                />
                <SerialSettingsFields
                    ports={portOptions}
                    portId={draft.portId}
                    onPortChange={(portId) => setDraft((current) => ({ ...current, portId }))}
                    baud={draft.baud}
                    onBaudChange={(baud) => setDraft((current) => ({ ...current, baud }))}
                    validBaud={!errors?.baud}
                    baudError={errors?.baud}
                    portError={errors?.portId}
                    settings={draft.settings}
                    onSettingsChange={(patch) =>
                        setDraft((current) => ({
                            ...current,
                            settings: { ...current.settings, ...patch },
                        }))
                    }
                    ending={draft.lineEnding}
                    onEndingChange={(lineEnding) =>
                        setDraft((current) => ({ ...current, lineEnding }))
                    }
                    busy={saving}
                    endingDisabled={saving}
                    scanning={scanning}
                    onRefresh={() => void refreshPorts()}
                />
                {scanError && (
                    <p
                        className="text-xs text-control-danger"
                        role="alert"
                    >
                        {scanError}
                    </p>
                )}
                {profile && (
                    <p className="text-xs leading-relaxed text-app-muted">
                        Changing the port, baud rate, framing, or flow control closes an open
                        session.
                    </p>
                )}
                {!scanning && missingPort && (
                    <p
                        className="text-xs leading-relaxed text-app-muted"
                        role="status"
                    >
                        {draft.portId} is unavailable. You can save this profile and connect when
                        the device is available.
                    </p>
                )}
                {!scanning && !draft.portId && !scanError && (
                    <p
                        className="text-xs leading-relaxed text-app-muted"
                        role="status"
                    >
                        No serial ports found. Attach a device, then refresh the port list.
                    </p>
                )}
                {(errors?.settings || errors?.lineEnding) && (
                    <p
                        className="text-xs text-control-danger"
                        role="alert"
                    >
                        {errors.settings ?? errors.lineEnding}
                    </p>
                )}
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
                        <Cable
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

/** A failed removal leaves the profile and its live session available for retry. */
function DeleteSerialProfileDialog({
    isOpen,
    onClose,
    profile,
}: BaseModalProps & { profile: SerialProfile }) {
    const remove = useAppStore((state) => state.deleteSerialProfile);
    const [removing, setRemoving] = useState(false);
    const [error, setError] = useState('');
    const pending = useRef(false);

    /** Publish deletion only after the device settings write has completed. */
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
        } catch (cause) {
            setError(serialError(cause));
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
            title="Delete Serial profile?"
            message={
                <>
                    Remove <strong>{profile.name}</strong> from this device and close its serial
                    session if open.
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

registerModal(SERIAL_PROFILE_EDITOR, SerialProfileEditor);
registerModal(DELETE_SERIAL_PROFILE, DeleteSerialProfileDialog);
