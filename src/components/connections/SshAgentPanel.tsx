import { AlertCircle, Info, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';

import type {
    SshAgentDiscoveryIssue,
    SshAgentKeyInfo,
} from '../../features/connections/infrastructure/connectionIpc';
import { IconButton } from '../ui/IconButton';
import { Select } from '../ui/Select';
import { Tooltip } from '../ui/Tooltip';
import { SshAgentHelp } from './SshAgentHelp';
import { SshAgentProviderIcon } from './SshAgentProviderIcon';

export interface SshAgentPanelProps {
    keys: SshAgentKeyInfo[];
    status: 'idle' | 'loading' | 'ready' | 'error';
    issue: SshAgentDiscoveryIssue | null;
    value?: string;
    onChange: (value: string | undefined) => void;
    onRefresh: () => void;
}

/** Keep setup instructions out of the form until requested, using the current desktop platform. */
function AgentSetupHelp({ issue }: { issue: SshAgentDiscoveryIssue | null }) {
    const [open, setOpen] = useState(false);
    const contentId = useId();
    const windows = /win/i.test(navigator.platform);
    const action =
        issue?.code === 'accessDenied'
            ? 'Allow Zync to access the agent in your agent or operating system settings.'
            : issue?.code === 'refused'
              ? 'Unlock your agent and allow it to share its key list with Zync.'
              : issue?.code === 'timeout'
                ? 'Check for an agent prompt and confirm that your agent is responding.'
                : windows
                  ? 'Enable the SSH agent in Bitwarden or 1Password, or start OpenSSH agent or Pageant.'
                  : 'Enable the SSH agent in your password manager, or start ssh-agent and add a key.';
    return (
        <>
            <Tooltip content="SSH agent setup help">
                <IconButton
                    label="SSH agent setup help"
                    icon={<Info size={14} />}
                    aria-expanded={open}
                    aria-controls={open ? contentId : undefined}
                    onClick={() => setOpen(!open)}
                    className="h-6 w-6 text-app-muted"
                />
            </Tooltip>
            {open && (
                <div
                    id={contentId}
                    role="region"
                    aria-label="SSH agent setup help"
                    className="w-full space-y-2 rounded-md border border-app-border p-3 text-xs text-app-muted"
                >
                    <p>
                        {issue
                            ? action
                            : 'Unlock your agent and add or enable an SSH key for this host.'}
                    </p>
                    <p>
                        {windows
                            ? 'Bitwarden, 1Password and Windows OpenSSH use the same agent endpoint. When using a password manager, enable its SSH agent and stop the Windows OpenSSH Authentication Agent service so the chosen provider can use the endpoint.'
                            : 'Zync needs SSH_AUTH_SOCK from your agent. If you changed the agent socket after opening Zync, restart Zync to pick up the new environment.'}
                    </p>
                    <p>
                        Then refresh the key list. New logins need the agent; existing sessions stay
                        connected.
                    </p>
                    {issue && (
                        <details>
                            <summary className="cursor-pointer text-app-text">
                                Technical details
                            </summary>
                            <p className="mt-1 break-words whitespace-pre-wrap">{issue.details}</p>
                        </details>
                    )}
                </div>
            )}
        </>
    );
}

/** A bounded, searchable identity picker; selection always stores the canonical public selector. */
export function SshAgentPanel({
    keys,
    status,
    issue,
    value,
    onChange,
    onRefresh,
}: SshAgentPanelProps) {
    const selected = keys.find((key) => key.publicKey === value);
    const options = [
        {
            value: '',
            label: 'Use agent’s first key',
            icon: <SshAgentProviderIcon provider={keys[0]?.provider} />,
        },
        ...keys.map((key) => ({
            value: key.publicKey,
            label: key.comment || `${key.algorithm}${key.isCertificate ? ' certificate' : ''}`,
            description: `${key.algorithm}${key.isCertificate ? ' certificate' : ''} · ${key.fingerprint}`,
            icon: <SshAgentProviderIcon provider={key.provider} />,
        })),
        ...(value && !selected
            ? [
                  {
                      value,
                      label: 'Saved key (not listed)',
                      description: 'The saved selection is kept. Refresh to check your agent.',
                      icon: <SshAgentProviderIcon />,
                  },
              ]
            : []),
    ];
    return (
        <div
            role="group"
            aria-label="Local SSH agent authentication"
            className="rounded-lg border border-app-border/60 bg-app-surface/30 p-3 space-y-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                    <KeyRound
                        size={14}
                        className="mr-1 text-app-muted"
                        aria-hidden="true"
                    />
                    <span className="text-xs font-medium text-app-text">Local SSH agent</span>
                    <SshAgentHelp />
                </div>
                <div className="flex items-center gap-2">
                    <span
                        role="status"
                        className="text-xs text-app-muted"
                    >
                        {status === 'loading'
                            ? 'Checking...'
                            : status === 'error'
                              ? 'Unavailable'
                              : status === 'ready'
                                ? `${keys.length} key${keys.length === 1 ? '' : 's'} found`
                                : 'Not checked'}
                    </span>
                    <button
                        type="button"
                        aria-label="Refresh local SSH agent keys"
                        disabled={status === 'loading'}
                        onClick={onRefresh}
                        className="inline-flex items-center gap-1 text-xs text-app-muted hover:text-app-text transition-colors disabled:opacity-50"
                    >
                        {status === 'loading' ? (
                            <Loader2
                                size={12}
                                className="animate-spin"
                                aria-hidden="true"
                            />
                        ) : (
                            <RefreshCw
                                size={12}
                                aria-hidden="true"
                            />
                        )}
                        Refresh
                    </button>
                </div>
            </div>
            {(issue || (status === 'ready' && keys.length === 0)) && (
                <div
                    className="flex flex-wrap items-center gap-1 text-xs text-app-muted"
                    role={issue ? 'alert' : undefined}
                >
                    <AlertCircle
                        size={12}
                        aria-hidden="true"
                        className="shrink-0 text-amber-400"
                    />
                    <span className="min-w-0 flex-1">
                        {issue?.message ?? 'No keys are available from this agent.'}
                    </span>
                    <AgentSetupHelp issue={issue} />
                </div>
            )}
            {(keys.length > 0 || value) && (
                <div className="space-y-2">
                    <div className="flex items-center gap-1">
                        <Select
                            className="min-w-0 flex-1"
                            ariaLabel="Local SSH agent key"
                            value={value ?? ''}
                            onChange={(selector) => onChange(selector || undefined)}
                            options={options}
                            disabled={status === 'loading'}
                            portal
                        />
                        <SshAgentHelp topic="firstKey" />
                    </div>
                    {selected && (
                        <p className="break-all text-[10px] font-mono text-app-muted">
                            {selected.fingerprint}
                        </p>
                    )}
                    {value && !selected && (
                        <p className="text-xs text-app-muted">
                            The selected key is not in this list. It has not been replaced.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
