import type { SyncDomain } from './syncIpc';

export interface SyncDomainDefinition {
  domain: SyncDomain;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const SYNC_DOMAIN_DEFINITIONS: Record<SyncDomain, SyncDomainDefinition> = {
  vault: {
    domain: 'vault',
    label: 'Vault credentials',
    description: 'Encrypted vault backup and credential restore.',
    defaultEnabled: true,
  },
  hosts: {
    domain: 'hosts',
    label: 'Hosts',
    description: 'Connection definitions and vault credential references.',
    defaultEnabled: true,
  },
  tunnels: {
    domain: 'tunnels',
    label: 'Tunnels',
    description: 'Global/local port forwarding definitions.',
    defaultEnabled: false,
  },
  snippets: {
    domain: 'snippets',
    label: 'Snippets',
    description: 'Reusable command snippets.',
    defaultEnabled: false,
  },
  settings: {
    domain: 'settings',
    label: 'Settings',
    description: 'Allowlisted theme/editor/terminal preferences only.',
    defaultEnabled: false,
  },
};

export const SYNC_DOMAIN_ORDER: SyncDomain[] = ['vault', 'hosts', 'tunnels', 'snippets', 'settings'];

export function getSyncDomainDefinition(domain: SyncDomain): SyncDomainDefinition {
  return SYNC_DOMAIN_DEFINITIONS[domain];
}

export function getSyncDomainLabel(domain: SyncDomain): string {
  return getSyncDomainDefinition(domain).label;
}
