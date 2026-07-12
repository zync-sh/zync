import { useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { KeyRound, Copy, Check, Download, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/utils';

interface Props {
  isOpen: boolean;
  recoveryKey: string;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  fileTitle?: string;
  fileDescription?: string;
  downloadFileName?: string;
}

export function RecoveryKeyModal({
  isOpen,
  recoveryKey,
  onClose,
  title = 'Vault Recovery Key',
  subtitle = 'Save this key somewhere safe. It can unlock your vault if you forget your passphrase.',
  fileTitle = 'Zync Vault Recovery Key',
  fileDescription = 'This key can unlock your vault if you forget your passphrase.',
  downloadFileName = 'zync-vault-recovery-key.txt',
}: Props) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (copyTimeoutRef.current !== null) {
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    setCopied(false);
  }, [isOpen, recoveryKey]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.warn('[Vault] Failed to copy recovery key:', error);
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const content = [
      fileTitle,
      '='.repeat(fileTitle.length),
      '',
      'Store this file somewhere safe and offline.',
      fileDescription,
      '',
      recoveryKey,
      '',
      `Generated: ${new Date().toISOString()}`,
    ].join('\n');

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFileName;
    a.click();
    // Defer revocation so the browser has time to start the download
    // before the object URL is invalidated.
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
  };

  // Split key into visual groups of 4 chars for display
  const groups = recoveryKey.split('-');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width="max-w-lg"
      closeOnEsc={false}
      closeOnOverlayClick={false}
      showCloseButton={false}
      explicitDismissOnly
    >
      <div className="space-y-5">
        {/*
          Warning banner — use app CSS vars only.
          Zync themes via data-theme + --color-app-*, not Tailwind `dark:`.
          Hard-coded amber-950 / dark: never applied → unreadable in dark mode.
        */}
        <div
          className={cn(
            'flex items-start gap-3 rounded-lg px-3 py-3',
            'border border-[var(--color-app-warning)]/30',
            'bg-[var(--color-app-warning)]/12',
          )}
        >
          <AlertTriangle
            size={15}
            className="shrink-0 mt-0.5 text-[var(--color-app-warning)]"
          />
          <p className="text-xs leading-relaxed text-[var(--color-app-text)]">
            This key is shown only once. Write it down or save the file before closing this dialog.
          </p>
        </div>

        {/* Key display */}
        <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-bg)] p-4">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={14} className="text-[var(--color-app-muted)]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)]">
              Recovery Key
            </span>
          </div>
          <div className="font-mono text-sm text-[var(--color-app-text)] break-all leading-loose select-all">
            {groups.map((group, i) => (
              <span key={i}>
                <span className="text-[var(--color-app-accent)]">{group}</span>
                {i < groups.length - 1 && (
                  <span className="text-[var(--color-app-muted)]/40 mx-0.5">-</span>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleCopy} className="flex-1 gap-1.5">
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            {copied ? 'Copied!' : 'Copy Key'}
          </Button>
          <Button variant="secondary" onClick={handleDownload} className="flex-1 gap-1.5">
            <Download size={14} />
            Save File
          </Button>
        </div>

        <Button onClick={onClose} className="w-full">
          I've saved my recovery key
        </Button>
      </div>
    </Modal>
  );
}
