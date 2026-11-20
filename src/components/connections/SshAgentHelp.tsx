import { Info } from 'lucide-react';

import { IconButton } from '../ui/IconButton.js';
import { Tooltip } from '../ui/Tooltip.js';

const help = {
    authentication: {
        label: 'About local SSH agent authentication',
        text: 'Log in with a key managed by OpenSSH, Pageant, Bitwarden/Vaultwarden or 1Password on this device. The agent signs without sharing its private key. New logins need the agent; open sessions stay connected. Agent forwarding is separate.',
    },
    forwarding: {
        label: 'About SSH agent forwarding',
        text: 'Let applications on this remote host request signatures with one selected file or Vault key. This does not choose how you log in. Approve requests once or for the connection. Keys from an external local agent cannot be forwarded here yet.',
    },
    firstKey: {
        label: 'About automatic agent key selection',
        text: 'Use the first key returned by the agent. It must be authorized for this host and username. Zync does not try the remaining keys if it is rejected. Select a specific key for a predictable login.',
    },
};

/** Keep login and forwarding explanations available to hover and keyboard focus without form clutter. */
export function SshAgentHelp({ topic = 'authentication' }: { topic?: keyof typeof help }) {
    const { label, text } = help[topic];
    return (
        <Tooltip
            content={text}
            contentClassName="max-w-xs whitespace-normal leading-relaxed"
        >
            <IconButton
                label={label}
                icon={<Info size={14} />}
                className="h-6 w-6 text-app-muted hover:text-app-text"
            />
        </Tooltip>
    );
}
