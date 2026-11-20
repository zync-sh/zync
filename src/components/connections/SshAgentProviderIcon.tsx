import { KeyRound } from 'lucide-react';
import { useState } from 'react';

import type { SshAgentProvider } from '../../features/connections/infrastructure/connectionIpc';
import { Tooltip } from '../ui/Tooltip';

const providers = {
    bitwarden: { name: 'Bitwarden', mark: '/agent-providers/bitwarden.png' },
    onePassword: { name: '1Password', mark: '/agent-providers/1password.png' },
    openSsh: { name: 'Windows OpenSSH', mark: null },
    pageant: { name: 'Pageant-compatible agent', mark: null },
};

/** Identify the supplying agent at the last refresh, with uncertainty explicit to assistive technology. */
export function SshAgentProviderIcon({ provider }: { provider?: SshAgentProvider | null }) {
    const [failedMark, setFailedMark] = useState<string | null>(null);
    const known =
        provider && Object.prototype.hasOwnProperty.call(providers, provider.id)
            ? providers[provider.id]
            : null;
    const evidence =
        provider?.evidence === 'signedProcess'
            ? 'process signature checked'
            : provider?.evidence === 'socketHint'
              ? 'inferred from socket path'
              : provider?.evidence === 'transport'
                ? 'identified by transport'
                : null;
    const description =
        known && evidence
            ? `Agent: ${known.name} (${evidence}). Supplied this key list at the last refresh. This does not identify where the key was created.`
            : 'Local SSH agent. Provider could not be identified.';
    const mark = evidence ? known?.mark : null;
    return (
        <Tooltip
            content={description}
            contentClassName="max-w-xs whitespace-normal leading-relaxed"
        >
            <span
                role="img"
                aria-label={description}
                className="flex h-4 w-4 shrink-0 items-center justify-center text-app-text"
            >
                {mark && failedMark !== mark ? (
                    <img
                        src={mark}
                        alt=""
                        aria-hidden="true"
                        draggable={false}
                        className="h-4 w-4 object-contain"
                        onError={() => setFailedMark(mark)}
                    />
                ) : (
                    <KeyRound
                        size={14}
                        aria-hidden="true"
                    />
                )}
            </span>
        </Tooltip>
    );
}
