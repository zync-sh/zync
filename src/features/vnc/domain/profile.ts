export interface VncProfile {
    id: string;
    name: string;
    host: string;
    port: number;
    resolution: VncResolution;
    scale: VncScale;
    credentialId?: string;
    ssh?: VncSshHost;
}

/** Bind a profile to the saved SSH host identity used to reach its loopback desktop. */
export interface VncSshHost {
    id: string;
    host: string;
    port: number;
    username: string;
}

export type VncResolution =
    | { mode: 'server' }
    | { mode: 'auto' }
    | { mode: 'fixed'; width: number; height: number };

export type VncResolutionDraft =
    | { mode: 'server' | 'auto' }
    | { mode: 'fixed'; width: string; height: string };

export const VNC_SCALE_PERCENTAGES = [50, 75, 100, 125, 150, 200] as const;
export type VncScale = 'fit' | (typeof VNC_SCALE_PERCENTAGES)[number];

export interface VncProfileDraft {
    name: string;
    host: string;
    port: string;
    resolution?: VncResolutionDraft;
    scale?: VncScale;
    credentialId?: string;
    ssh?: VncSshHost;
}

export const DEFAULT_VNC_PORT = 5900;
export const VNC_SSH_LOOPBACK = '127.0.0.1';
export const DEFAULT_VNC_RESOLUTION: VncResolution = { mode: 'server' };
export const DEFAULT_VNC_SCALE: VncScale = 'fit';
// Bound explicit requests by both the maximum side and the framebuffer memory budget.
export const VNC_RESOLUTION_MAX_DIMENSION = 8192;
export const VNC_RESOLUTION_MAX_PIXELS = 4096 * 2160;
export const VNC_RESOLUTION_PRESETS = [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3840, height: 2160 },
] as const;
export const VNC_PROFILE_NAME_MAX_LENGTH = 120;
export const VNC_DIRECT_NETWORK_NOTICE =
    'Direct VNC may be unencrypted, with or without a password. Use a trusted network or VPN, or choose Via SSH.';

const DNS_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;
const PROFILE_ID = /^[a-z\d_-]{1,128}$/i;
const VAULT_CREDENTIAL_ID = /^[a-z\d][a-z\d._:-]{0,127}$/i;

/** Validate saved profile identities used by both persistence and settings restore. */
export function isVncProfileId(value: unknown): value is string {
    return typeof value === 'string' && PROFILE_ID.test(value);
}

/** Accept the stable Vault reference as a bounded token, never as an endpoint or secret. */
export function normalizeVncCredentialId(value: unknown): string | undefined {
    const id = typeof value === 'string' ? value.trim() : '';
    return VAULT_CREDENTIAL_ID.test(id) ? id : undefined;
}

/** Accept one bare host or IP address, matching the native direct VNC target format. */
export function normalizeVncHost(input: string): string | null {
    const host = input.trim();
    if (host.includes(':')) {
        const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
        if (!/^[a-f\d:.]+$/i.test(address)) {
            return null;
        }
        try {
            return new URL(`http://[${address}]`).hostname.slice(1, -1);
        } catch {
            return null;
        }
    }
    if (/^[\d.]+$/.test(host)) {
        const parts = host.split('.');
        return parts.length === 4 &&
            parts.every((part) => IPV4_PART.test(part) && Number(part) <= 255)
            ? host
            : null;
    }
    const dnsName = host.endsWith('.') ? host.slice(0, -1) : host;
    return dnsName.length <= 253 && dnsName.split('.').every((label) => DNS_LABEL.test(label))
        ? host
        : null;
}

/** Parse the separate VNC port field as a whole TCP port. */
export function normalizeVncPort(input: string): number | undefined {
    const text = input.trim();
    const port = Number(text);
    return /^\d+$/.test(text) && port >= 1 && port <= 65535 ? port : undefined;
}

/** Accept only bounded SSH connection metadata, keeping the exact saved identity. */
function normalizeVncSshHost(value: unknown): VncSshHost | undefined {
    if (!value || typeof value !== 'object') {
        return;
    }
    const { id, host, port, username } = value as Partial<VncSshHost>;
    const valid = (text: unknown): text is string =>
        typeof text === 'string' &&
        text.length > 0 &&
        text.length <= 512 &&
        !/[\u0000-\u001f\u007f]/.test(text);
    if (
        !valid(id) ||
        id === 'local' ||
        !valid(host) ||
        !valid(username) ||
        typeof port !== 'number' ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        return;
    }
    return { id, host, port, username };
}

/** A changed or missing SSH host needs explicit profile review before it can carry VNC. */
export function matchesVncSshHost(saved: VncSshHost, current?: VncSshHost): boolean {
    return (
        current?.id === saved.id &&
        current.host === saved.host &&
        current.port === saved.port &&
        current.username === saved.username
    );
}

/** Identify the complete VNC destination for connection requests and Vault confirmation. */
export function vncDestinationKey(profile: Pick<VncProfile, 'host' | 'port' | 'ssh'>): string {
    const ssh = profile.ssh;
    return JSON.stringify([
        profile.host.toLowerCase(),
        profile.port,
        ssh && [ssh.id, ssh.host, ssh.port, ssh.username],
    ]);
}

type VncProfileValidation =
    | { value: Omit<VncProfile, 'id'>; errors?: never }
    | { value?: never; errors: VncProfileErrors };

type VncProfileErrors = Partial<Record<keyof VncProfileDraft | 'width' | 'height', string>>;

/** Require a positive whole dimension inside the client desktop request budget. */
export function isVncResolutionDimension(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= VNC_RESOLUTION_MAX_DIMENSION
    );
}

/** Limit the requested framebuffer area as well as either individual side. */
export function isVncResolutionSize(width: number, height: number): boolean {
    return (
        isVncResolutionDimension(width) &&
        isVncResolutionDimension(height) &&
        width * height <= VNC_RESOLUTION_MAX_PIXELS
    );
}

/** Accept only the local zoom levels exposed by the profile editor and viewer. */
export function isVncScale(value: unknown): value is VncScale {
    return value === 'fit' || VNC_SCALE_PERCENTAGES.some((percentage) => percentage === value);
}

/** Parse editable pixel counts without accepting decimal, exponential or signed input. */
function parseResolutionDimension(input: string): number | null {
    const text = input.trim();
    const value = Number(text);
    return /^\d+$/.test(text) && isVncResolutionDimension(value) ? value : null;
}

/** Build a canonical requested size and report invalid sides beside their own controls. */
function validateResolutionDraft(
    draft: VncResolutionDraft | undefined,
    errors: VncProfileErrors,
): VncResolution | null {
    if (!draft) {
        return DEFAULT_VNC_RESOLUTION;
    }
    if (draft.mode === 'server' || draft.mode === 'auto') {
        return { mode: draft.mode };
    }
    if (draft.mode !== 'fixed') {
        errors.resolution = 'Select a remote resolution.';
        return null;
    }
    const width = parseResolutionDimension(draft.width);
    const height = parseResolutionDimension(draft.height);
    const invalidDimension = `Enter a whole number from 1 to ${VNC_RESOLUTION_MAX_DIMENSION.toLocaleString('en-US')}.`;
    if (width === null) {
        errors.width = invalidDimension;
    }
    if (height === null) {
        errors.height = invalidDimension;
    }
    if (width === null || height === null) {
        return null;
    }
    if (!isVncResolutionSize(width, height)) {
        errors.resolution = `Width × height must be at most ${VNC_RESOLUTION_MAX_PIXELS.toLocaleString('en-US')} pixels.`;
        return null;
    }
    return { mode: 'fixed', width, height };
}

/** Validate the editable fields and return only the metadata allowed in device settings. */
export function validateVncProfileDraft(draft: VncProfileDraft): VncProfileValidation {
    const name = draft.name.trim();
    const ssh = normalizeVncSshHost(draft.ssh);
    const host = ssh ? VNC_SSH_LOOPBACK : normalizeVncHost(draft.host);
    const port = normalizeVncPort(draft.port);
    const errors: VncProfileErrors = {};
    if (!name || name.length > VNC_PROFILE_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
        errors.name = 'Enter a name using 1 to 120 characters.';
    }
    if (!host) {
        errors.host = 'Enter a host name or IP address. Use the separate port field.';
    }
    if (draft.ssh !== undefined && !ssh) {
        errors.ssh = 'Choose a valid saved SSH host.';
    }
    if (port === undefined) {
        errors.port = 'Enter a whole port number from 1 to 65535.';
    }
    const resolution = validateResolutionDraft(draft.resolution, errors);
    const scale = draft.scale ?? DEFAULT_VNC_SCALE;
    if (!isVncScale(scale)) {
        errors.scale = 'Select a viewer scale.';
    }
    const credentialId = normalizeVncCredentialId(draft.credentialId);
    if (draft.credentialId !== undefined && !credentialId) {
        errors.credentialId = 'Select a valid password from Vault.';
    }
    return !host || port === undefined || !resolution || Object.keys(errors).length > 0
        ? { errors }
        : {
              value: {
                  name,
                  host,
                  port,
                  resolution,
                  scale,
                  ...(credentialId && { credentialId }),
                  ...(ssh && { ssh }),
              },
          };
}

/** Preserve legacy auto-resize behavior only when the replacement setting is absent. */
function normalizeStoredResolution(resolution: unknown, legacyAutoResize: unknown): VncResolution {
    if (resolution === undefined) {
        return { mode: legacyAutoResize === false ? 'server' : 'auto' };
    }
    if (resolution && typeof resolution === 'object' && 'mode' in resolution) {
        if (resolution.mode === 'server' || resolution.mode === 'auto') {
            return { mode: resolution.mode };
        }
        if (
            resolution.mode === 'fixed' &&
            'width' in resolution &&
            'height' in resolution &&
            isVncResolutionDimension(resolution.width) &&
            isVncResolutionDimension(resolution.height) &&
            isVncResolutionSize(resolution.width, resolution.height)
        ) {
            return { mode: 'fixed', width: resolution.width, height: resolution.height };
        }
    }
    return DEFAULT_VNC_RESOLUTION;
}

/** Restore valid, uniquely keyed metadata and discard unknown fields from editable JSON. */
export function normalizeVncProfiles(input: unknown): VncProfile[] {
    const profiles = new Map<string, VncProfile>();
    if (!Array.isArray(input)) {
        return [];
    }
    for (const item of input) {
        if (
            !isVncProfileId(item?.id) ||
            typeof item.name !== 'string' ||
            typeof item.host !== 'string' ||
            !Number.isInteger(item.port)
        ) {
            continue;
        }
        const { value } = validateVncProfileDraft({
            name: item.name,
            host: item.host,
            port: String(item.port),
            ssh: item.ssh,
        });
        if (value) {
            const credentialId = normalizeVncCredentialId(item.credentialId);
            profiles.set(item.id, {
                id: item.id,
                ...value,
                resolution: normalizeStoredResolution(item.resolution, item.autoResize),
                scale: isVncScale(item.scale) ? item.scale : DEFAULT_VNC_SCALE,
                ...(credentialId && { credentialId }),
            });
        }
    }
    return [...profiles.values()];
}

/** Bracket IPv6 for display so the host and port remain visually distinct. */
export function formatVncEndpoint(profile: Pick<VncProfile, 'host' | 'port'>): string {
    return `${profile.host.includes(':') ? `[${profile.host}]` : profile.host}:${profile.port}`;
}

/** Describe the visible route without confusing the SSH port and the remote VNC port. */
export function describeVncDestination(profile: Pick<VncProfile, 'host' | 'port' | 'ssh'>): string {
    return profile.ssh
        ? `Loopback port ${profile.port} via ${formatVncEndpoint(profile.ssh)}`
        : formatVncEndpoint(profile);
}
