import type { VaultItem, VaultItemDetail } from './ipc';

export const CURRENT_CREDENTIAL_SCHEMA_VERSION = 2;

export const KNOWN_CREDENTIAL_KINDS = [
  'ssh-private-key',
  'ssh-password',
  'ssh-certificate',
  'username-password',
  'api-token',
  'secret-text',
  'certificate',
  'certificate-key-pair',
  'certificate-chain',
  'git-credential',
  'jenkins-credential',
  'container-registry-credential',
  'cloud-provider-credential',
  'external-keychain-reference',
  'plugin-defined',
  'generic-secret',
] as const;

export const SUPPORTED_CREATE_CREDENTIAL_KINDS = [
  'ssh-private-key',
  'ssh-password',
] as const satisfies readonly CredentialKind[];

export type CredentialKind = typeof KNOWN_CREDENTIAL_KINDS[number];
export type SupportedCreateCredentialKind = typeof SUPPORTED_CREATE_CREDENTIAL_KINDS[number];

export type CredentialFieldFormat =
  | 'text'
  | 'username'
  | 'password'
  | 'private-key'
  | 'certificate'
  | 'token'
  | 'url'
  | 'json';

export type CredentialFieldEncoding = 'plain' | 'pem' | 'base64';

export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  required?: boolean;
  format?: CredentialFieldFormat;
  value?: string;
  valueRef?: string;
  encoding?: CredentialFieldEncoding;
}

export interface CredentialMetadata {
  service?: string;
  url?: string;
  username?: string;
  pluginId?: string;
  externalRefKind?: 'os-keychain' | 'hardware-key' | 'provider-secret';
  externalRef?: string;
  schemaName?: string;
  schemaVersion?: number;
  legacyKind?: string;
  notes?: string;
}

export interface CredentialEnvelope {
  credentialId: string;
  kind: CredentialKind;
  label: string;
  fields: CredentialField[];
  metadata: CredentialMetadata;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  revision: number;
  schemaVersion: number;
}

export interface CredentialKindOption {
  kind: CredentialKind;
  label: string;
  description: string;
  enabled: boolean;
  badge?: string;
}

export const CREDENTIAL_KIND_OPTIONS: CredentialKindOption[] = [
  {
    kind: 'ssh-private-key',
    label: 'SSH private key',
    description: 'Paste an OpenSSH private key, with optional passphrase.',
    enabled: true,
  },
  {
    kind: 'ssh-password',
    label: 'SSH password',
    description: 'Store a password for SSH password authentication.',
    enabled: true,
  },
  {
    kind: 'username-password',
    label: 'Username + password',
    description: 'Generic login credential for tools like Jenkins.',
    enabled: false,
    badge: 'Coming soon',
  },
  {
    kind: 'api-token',
    label: 'API token',
    description: 'Tokens and access secrets for services or plugins.',
    enabled: false,
    badge: 'Coming soon',
  },
  {
    kind: 'certificate-key-pair',
    label: 'Certificate / key pair',
    description: 'Client certificate plus private key for mTLS and similar flows.',
    enabled: false,
    badge: 'Coming soon',
  },
  {
    kind: 'jenkins-credential',
    label: 'Jenkins credential',
    description: 'Service-aware credential shape for Jenkins integrations.',
    enabled: false,
    badge: 'Planned',
  },
];

const LEGACY_KIND_MAP: Record<string, CredentialKind> = {
  'ssh-private-key': 'ssh-private-key',
  'ssh-key-with-passphrase': 'ssh-private-key',
  'ssh-password': 'ssh-password',
  'ssh-agent-key': 'external-keychain-reference',
  'api-key': 'api-token',
  'api-token': 'api-token',
  'secure-note': 'secret-text',
  'secret-text': 'secret-text',
  'username-password': 'username-password',
  certificate: 'certificate',
  'certificate-key-pair': 'certificate-key-pair',
  'jenkins-credential': 'jenkins-credential',
  'git-credential': 'git-credential',
  'plugin-defined': 'plugin-defined',
};

export function isKnownCredentialKind(kind: string): kind is CredentialKind {
  return (KNOWN_CREDENTIAL_KINDS as readonly string[]).includes(kind);
}

export function normalizeCredentialKind(kind: string): CredentialKind {
  return LEGACY_KIND_MAP[kind] ?? (isKnownCredentialKind(kind) ? kind : 'generic-secret');
}

export function isSupportedCreateCredentialKind(
  kind: string,
): kind is SupportedCreateCredentialKind {
  return (SUPPORTED_CREATE_CREDENTIAL_KINDS as readonly string[]).includes(kind);
}

export function getCredentialKindOption(kind: string): CredentialKindOption | undefined {
  const normalizedKind = normalizeCredentialKind(kind);
  return CREDENTIAL_KIND_OPTIONS.find(option => option.kind === normalizedKind);
}

export function getCredentialKindLabel(kind: string): string {
  return getCredentialKindOption(kind)?.label ?? normalizeCredentialKind(kind).replace(/-/g, ' ');
}

export function isHostAssignableCredentialKind(kind: string): boolean {
  const normalizedKind = normalizeCredentialKind(kind);
  return (
    normalizedKind === 'ssh-private-key'
    || normalizedKind === 'ssh-password'
    || normalizedKind === 'ssh-certificate'
    || normalizedKind === 'external-keychain-reference'
  );
}

export function vaultItemToCredentialEnvelope(item: VaultItem | VaultItemDetail): CredentialEnvelope {
  if ('credential' in item && item.credential) {
    return {
      ...item.credential,
      tags: item.credential.tags ?? [],
    };
  }
  const kind = normalizeCredentialKind(item.kind);
  const fields = [vaultItemSecretReferenceField(item, kind)];
  const hasPassphraseField =
    ('hasPassphraseField' in item && item.hasPassphraseField)
    || ('credential' in item
      && item.credential?.fields?.some((field: CredentialField) => field.name === 'passphrase') === true);
  if (hasPassphraseField && kind === 'ssh-private-key') {
    fields.push(vaultItemPassphraseReferenceField());
  }
  return {
    credentialId: item.logicalId || item.id,
    kind,
    label: item.label,
    fields,
    metadata: {
      legacyKind: item.kind,
      notes: 'notes' in item ? item.notes : undefined,
    },
    tags: [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    revision: item.revision,
    schemaVersion: CURRENT_CREDENTIAL_SCHEMA_VERSION,
  };
}

export function vaultItemPassphraseReferenceField(): CredentialField {
  return {
    name: 'passphrase',
    label: 'Passphrase',
    secret: true,
    required: false,
    format: 'password',
    valueRef: 'secret:passphrase',
  };
}

export function vaultItemSecretReferenceField(
  item: Pick<VaultItem | VaultItemDetail, 'id' | 'kind'>,
  kind = normalizeCredentialKind(item.kind),
): CredentialField {
  if (kind === 'ssh-private-key') {
    return {
      name: 'privateKey',
      label: 'Private Key',
      secret: true,
      required: true,
      format: 'private-key',
      encoding: 'pem',
      valueRef: 'secret:privateKey',
    };
  }
  if (kind === 'ssh-password' || kind === 'username-password') {
    return {
      name: 'password',
      label: 'Password',
      secret: true,
      required: true,
      format: 'password',
      valueRef: 'secret:password',
    };
  }
  if (kind === 'api-token') {
    return {
      name: 'token',
      label: 'Token',
      secret: true,
      required: true,
      format: 'token',
      valueRef: 'secret:token',
    };
  }
  return {
    name: 'secret',
    label: 'Secret',
    secret: true,
    required: true,
    format: 'text',
    valueRef: 'secret:secret',
  };
}
