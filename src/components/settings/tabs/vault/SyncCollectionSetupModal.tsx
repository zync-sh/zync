import { useEffect, useMemo, useState } from 'react';
import { Shield } from 'lucide-react';
import { Modal } from '../../../ui/Modal';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { VaultModeSwitch } from '../../../vault/VaultModeSwitch';
import { SecretField } from '../../../vault/SecretField';
import type {
  SyncCollectionSetupArgs,
  SyncKeyPolicyMode,
  SyncRemoteCollectionSummary,
} from '../../../../vault/syncIpc';
import { syncIpc } from '../../../../vault/syncIpc';
import { parseSyncInvokeError } from '../../../../vault/syncError';
import {
  SYNC_PASSPHRASE_MIN_LENGTH,
  canSubmitSyncSetup,
  formatSyncCollectionIdLabel,
  formatSyncCollectionSetupError,
  getSyncPassphraseLabel,
  isLocalPassphrasePolicy,
  validateSyncSetupPassphrase,
} from '../../../../vault/syncPassphrase';

interface SyncCollectionSetupModalProps {
  isOpen: boolean;
  isSubmitting: boolean;
  hasLocalVaultConfigured: boolean;
  onClose: () => void;
  onSubmit: (args: SyncCollectionSetupArgs) => Promise<void>;
}

type RemoteDiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; collections: SyncRemoteCollectionSummary[] }
  | { status: 'error'; message: string };

export function SyncCollectionSetupModal({
  isOpen,
  isSubmitting,
  hasLocalVaultConfigured,
  onClose,
  onSubmit,
}: SyncCollectionSetupModalProps) {
  const [mode, setMode] = useState<SyncKeyPolicyMode>('local-passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(true);
  const [error, setError] = useState('');
  const [remoteDiscovery, setRemoteDiscovery] = useState<RemoteDiscoveryState>({ status: 'idle' });
  const [selectedCollectionId, setSelectedCollectionId] = useState('');

  const requiresConfirmPassphrase = !isLocalPassphrasePolicy(mode);
  const remoteCollections = remoteDiscovery.status === 'ready' ? remoteDiscovery.collections : [];
  const requiresCollectionSelection = remoteCollections.length > 1;

  useEffect(() => {
    if (!isOpen) {
      setRemoteDiscovery({ status: 'idle' });
      setPassphrase('');
      setConfirmPassphrase('');
      setShowPassphrase(false);
      setHasRecoveryKey(true);
      setError('');
      setSelectedCollectionId('');
      return;
    }

    setMode(hasLocalVaultConfigured ? 'local-passphrase' : 'custom-passphrase');
    setPassphrase('');
    setConfirmPassphrase('');
    setShowPassphrase(false);
    setHasRecoveryKey(true);
    setError('');
    setSelectedCollectionId('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!hasLocalVaultConfigured && isLocalPassphrasePolicy(mode)) {
      setMode('custom-passphrase');
      setPassphrase('');
      setConfirmPassphrase('');
      setError('');
    }
  }, [hasLocalVaultConfigured, isOpen, mode]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setRemoteDiscovery({ status: 'loading' });

    void (async () => {
      try {
        const result = await syncIpc.collectionDiscoverRemote('google');
        if (cancelled) return;

        const collections = result.collections ?? [];
        setRemoteDiscovery({ status: 'ready', collections });
        if (collections.length === 1) {
          setSelectedCollectionId(collections[0].syncCollectionId);
        }
      } catch (discoveryError) {
        if (cancelled) return;
        const { message } = parseSyncInvokeError(discoveryError);
        setRemoteDiscovery({
          status: 'error',
          message: message || 'Could not scan Google Drive for existing encrypted backups.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleModeChange = (nextMode: SyncKeyPolicyMode) => {
    setMode(nextMode);
    setPassphrase('');
    setConfirmPassphrase('');
    setError('');
  };

  const collectionSelectionReady = !requiresCollectionSelection || selectedCollectionId.trim().length > 0;

  const canSubmit = useMemo(() => (
    canSubmitSyncSetup({
      mode,
      passphrase,
      confirmPassphrase,
      hasLocalVaultConfigured,
      isSubmitting,
    })
    && collectionSelectionReady
    && remoteDiscovery.status !== 'loading'
  ), [
    collectionSelectionReady,
    confirmPassphrase,
    hasLocalVaultConfigured,
    isSubmitting,
    mode,
    passphrase,
    remoteDiscovery.status,
  ]);

  const handleClose = () => {
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (requiresCollectionSelection && !selectedCollectionId.trim()) {
      setError('Choose which Google Drive backup to link on this device.');
      return;
    }

    const validationError = validateSyncSetupPassphrase({
      mode,
      passphrase,
      confirmPassphrase,
      hasLocalVaultConfigured,
    });
    if (validationError) {
      setError(validationError);
      return;
    }

    const trimmedPassphrase = passphrase.trim();

    try {
      await onSubmit({
        keyPolicyMode: mode,
        passphrase: trimmedPassphrase,
        hasRecoveryKey,
        syncCollectionId: selectedCollectionId.trim() || null,
      });
      handleClose();
    } catch (submissionError) {
      setError(formatSyncCollectionSetupError(submissionError));
    }
  };

  const passphraseLabel = getSyncPassphraseLabel(mode);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Set up Google Encryption"
      subtitle={
        isLocalPassphrasePolicy(mode)
          ? 'Verify your Local Vault passphrase to create this device\'s Google encryption key.'
          : 'Create the local encryption key used for Google Drive sync records.'
      }
      width="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex justify-center mb-2">
          <div className="w-12 h-12 rounded-full bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] flex items-center justify-center">
            <Shield size={22} />
          </div>
        </div>

        {remoteDiscovery.status === 'loading' && (
          <p className="text-xs text-[var(--color-app-muted)]">
            Scanning Google Drive for existing encrypted backups…
          </p>
        )}

        {remoteDiscovery.status === 'error' && (
          <p
            className="rounded-lg border border-[var(--color-app-warning)]/30 bg-[var(--color-app-warning)]/12 px-3 py-2 text-xs leading-relaxed text-[var(--color-app-text)]"
            role="alert"
          >
            {remoteDiscovery.message}
          </p>
        )}

        {remoteDiscovery.status === 'ready' && remoteCollections.length === 1 && (
          <p className="text-xs text-[var(--color-app-muted)]">
            Found 1 existing encrypted backup on Google Drive. This device will link to{' '}
            <span className="text-[var(--color-app-text)] font-medium">
              {formatSyncCollectionIdLabel(remoteCollections[0].syncCollectionId)}
            </span>
            .
          </p>
        )}

        {requiresCollectionSelection && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--color-app-muted)]">
              Multiple encrypted backups were found on Google Drive. Choose which one to restore from.
              Disconnecting Google does not delete these files.
            </p>
            <div className="space-y-2">
              {remoteCollections.map((collection) => {
                const inputId = `sync-collection-${collection.syncCollectionId}`;
                const isSelected = selectedCollectionId === collection.syncCollectionId;
                return (
                  <label
                    key={collection.syncCollectionId}
                    htmlFor={inputId}
                    className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-[var(--color-app-accent)]/60 bg-[var(--color-app-accent)]/5'
                        : 'border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 hover:border-[var(--color-app-border)]'
                    }`}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="sync-collection"
                      checked={isSelected}
                      onChange={() => {
                        setSelectedCollectionId(collection.syncCollectionId);
                        setError('');
                      }}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-[var(--color-app-text)] font-medium">
                        {formatSyncCollectionIdLabel(collection.syncCollectionId)}
                      </span>
                      <span className="block text-[11px] text-[var(--color-app-muted)]">
                        {collection.fileCount} encrypted file{collection.fileCount === 1 ? '' : 's'} on Drive
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <VaultModeSwitch
          value={mode}
          onChange={handleModeChange}
          options={[
            { value: 'local-passphrase', label: 'Use Local Passphrase', disabled: !hasLocalVaultConfigured },
            { value: 'custom-passphrase', label: 'Use Custom Passphrase' },
          ]}
        />

        {isLocalPassphrasePolicy(mode) && (
          <p className="text-xs text-[var(--color-app-muted)]">
            Enter your Local Vault passphrase once. Zync verifies it against your vault before enabling Google encryption.
          </p>
        )}
        {!hasLocalVaultConfigured && (
          <p className="rounded-lg border border-[var(--color-app-warning)]/30 bg-[var(--color-app-warning)]/12 px-3 py-2 text-xs leading-relaxed text-[var(--color-app-text)]">
            Local Vault is not set up yet, so Google app-data sync will use a separate encryption passphrase.
            You can still sync hosts, tunnels, snippets, and settings. Vault credentials remain disabled until the local vault exists.
          </p>
        )}

        <SecretField
          label={passphraseLabel}
          value={passphrase}
          onChange={setPassphrase}
          showSecret={showPassphrase}
          onToggleShow={() => setShowPassphrase(value => !value)}
          autoFocus={!requiresCollectionSelection}
          autoComplete={isLocalPassphrasePolicy(mode) ? 'current-password' : 'new-password'}
          placeholder={
            isLocalPassphrasePolicy(mode)
              ? 'Enter your local vault passphrase'
              : 'Create Google encryption passphrase'
          }
        />

        {requiresConfirmPassphrase && (
          <Input
            label="Confirm Google encryption passphrase"
            type={showPassphrase ? 'text' : 'password'}
            value={confirmPassphrase}
            onChange={(event) => setConfirmPassphrase(event.target.value)}
            autoComplete="new-password"
            placeholder="Repeat Google encryption passphrase"
          />
        )}

        <p className="text-[11px] text-[var(--color-app-muted)]">
          Minimum {SYNC_PASSPHRASE_MIN_LENGTH} characters.
        </p>

        <label className="flex items-start gap-2 text-sm text-[var(--color-app-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={hasRecoveryKey}
            onChange={(event) => setHasRecoveryKey(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Generate a Google encryption recovery key (recommended).
          </span>
        </label>

        <div className="rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-3 text-[11px] text-[var(--color-app-muted)] leading-relaxed">
          <div className="flex items-center gap-2 text-[var(--color-app-text)] mb-1">
            <Shield size={12} />
            Security note
          </div>
          Google Drive only stores encrypted domain records and sync metadata. Passphrases and recovery keys are not uploaded.
        </div>

        {error && (
          <p className="text-xs text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={handleClose} className="flex-1" disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={!canSubmit}>
            {isSubmitting ? 'Setting up…' : 'Set up Encryption'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}