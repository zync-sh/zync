import { LEGACY_KEX_ALGORITHMS, type LegacyKex } from '../domain/types.js';

export type { LegacyKex } from '../domain/types.js';

export interface SshEndpoint {
    id: string;
    host: string;
    port: number;
}

interface LegacyKexChallenge extends SshEndpoint {
    algorithm: LegacyKex;
}

/** Dismissing the compatibility prompt cancels the whole connection attempt. */
export class LegacyKexDeclinedError extends Error {
    constructor() {
        super('Legacy SSH key exchange was declined.');
    }
}

function isLegacyKex(value: unknown): value is LegacyKex {
    return LEGACY_KEX_ALGORITHMS.some((algorithm) => algorithm === value);
}

/** Decode the native negotiation error, including its optional jump-hop context. */
export function parseLegacyKexChallenge(error: unknown): LegacyKexChallenge | undefined {
    const raw = error instanceof Error ? error.message : String(error);
    const match =
        /^(?:Error: )?(?:(?:Failed to connect(?: to jump host)?|Connection Failed): )*ZYNC_LEGACY_KEX:(.+)$/.exec(
            raw,
        );
    if (!match) {
        return;
    }
    try {
        const value = JSON.parse(match[1]);
        if (
            typeof value?.connectionId === 'string' &&
            typeof value.host === 'string' &&
            Number.isInteger(value.port) &&
            isLegacyKex(value.algorithm)
        ) {
            return {
                id: value.connectionId,
                host: value.host,
                port: value.port,
                algorithm: value.algorithm,
            };
        }
    } catch {
        // Unrecognized errors continue through the normal connection flow.
    }
}

export function sameSshEndpoint(a: SshEndpoint, b: SshEndpoint): boolean {
    return (
        a.id === b.id &&
        a.host.trim().toLowerCase() === b.host.trim().toLowerCase() &&
        a.port === b.port
    );
}

/** Device-only exception keyed by profile and endpoint, so retargeted profiles start fresh. */
function storageKey({ id, host, port }: SshEndpoint): string {
    return `zync:legacy-kex:${JSON.stringify([id, host.trim().toLowerCase(), port])}`;
}

export function readLegacyKex(endpoint: SshEndpoint): LegacyKex | undefined {
    try {
        const value = localStorage.getItem(storageKey(endpoint));
        return isLegacyKex(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

export function writeLegacyKex(endpoint: SshEndpoint, algorithm?: LegacyKex): void {
    const key = storageKey(endpoint);
    if (algorithm) {
        localStorage.setItem(key, algorithm);
    } else {
        localStorage.removeItem(key);
    }
}
