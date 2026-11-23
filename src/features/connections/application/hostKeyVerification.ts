import {
    type LegacyKex,
    LegacyKexDeclinedError,
    parseLegacyKexChallenge,
    readLegacyKex,
    type SshEndpoint,
    sameSshEndpoint,
} from './legacyKeyExchange.js';

export interface HostKeyChallenge {
    kind: 'unknown' | 'changed';
    connectionId: string;
    host: string;
    port: number;
    algorithm: string;
    fingerprint: string;
}

interface HostKeyConnectConfig extends SshEndpoint {
    jump_host: HostKeyConnectConfig | null;
    legacy_kex?: LegacyKex;
    host_key_approval?: {
        fingerprint: string;
        replace: boolean;
    };
}

interface ConfirmHostKeyOptions {
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    variant: 'primary' | 'danger';
}

const CHALLENGE_PREFIX = 'ZYNC_HOST_KEY:';

interface LegacyKexApproval {
    load?: (endpoint: SshEndpoint) => LegacyKex | undefined;
    savedWhen?: (endpoint: SshEndpoint) => 'on-success' | 'on-save' | undefined;
    onSuccess: (endpoint: SshEndpoint, algorithm: LegacyKex) => void;
}

function configureLegacyKex<C extends HostKeyConnectConfig>(
    config: C,
    choose: (hop: HostKeyConnectConfig) => LegacyKex | undefined,
): C {
    return {
        ...config,
        legacy_kex: choose(config),
        jump_host: config.jump_host && configureLegacyKex(config.jump_host, choose),
    };
}

export class HostKeyVerificationCancelledError extends Error {
    constructor(challenge: HostKeyChallenge) {
        const endpoint =
            challenge.port === 22 ? challenge.host : `[${challenge.host}]:${challenge.port}`;
        super(
            challenge.kind === 'changed'
                ? `Stored host key for ${endpoint} does not match. Connection refused. Presented fingerprint: ${challenge.fingerprint}`
                : `Host key for ${endpoint} was not trusted. Connection cancelled. Presented fingerprint: ${challenge.fingerprint}`,
        );
    }
}

export function parseHostKeyChallenge(error: unknown): HostKeyChallenge | null {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const marker = raw.indexOf(CHALLENGE_PREFIX);
    if (marker < 0) {
        return null;
    }
    try {
        const value = JSON.parse(
            raw.slice(marker + CHALLENGE_PREFIX.length),
        ) as Partial<HostKeyChallenge>;
        if (
            (value.kind === 'unknown' || value.kind === 'changed') &&
            typeof value.connectionId === 'string' &&
            typeof value.host === 'string' &&
            typeof value.port === 'number' &&
            typeof value.algorithm === 'string' &&
            typeof value.fingerprint === 'string'
        ) {
            return value as HostKeyChallenge;
        }
    } catch {
        // Fall through to the original connection error.
    }
    return null;
}

function promptOptions(challenge: HostKeyChallenge): ConfirmHostKeyOptions {
    const endpoint =
        challenge.port === 22 ? challenge.host : `[${challenge.host}]:${challenge.port}`;
    const key = `${challenge.algorithm} fingerprint: ${challenge.fingerprint}`;
    return challenge.kind === 'changed'
        ? {
              title: 'Remote host identification has changed',
              message: `WARNING: The stored host key for ${endpoint} does not match the key presented now. This could indicate a man-in-the-middle attack. ${key}. Update the stored key and connect anyway only if you have verified this change.`,
              confirmText: 'Update and connect',
              cancelText: 'Refuse connection',
              variant: 'danger',
          }
        : {
              title: 'Unknown SSH host',
              message: `The authenticity of ${endpoint} cannot be established. ${key}. Trust this key and save it to known_hosts?`,
              confirmText: 'Trust and connect',
              cancelText: 'Cancel',
              variant: 'primary',
          };
}

function approveChallenge<T extends HostKeyConnectConfig>(
    config: T,
    challenge: HostKeyChallenge,
): T {
    if (
        config.id === challenge.connectionId &&
        config.host === challenge.host &&
        config.port === challenge.port
    ) {
        return {
            ...config,
            host_key_approval: {
                fingerprint: challenge.fingerprint,
                replace: challenge.kind === 'changed',
            },
        };
    }
    if (!config.jump_host) {
        return config;
    }
    return { ...config, jump_host: approveChallenge(config.jump_host, challenge) };
}

/** Keep transport exceptions and host-key decisions on the same retry route. */
export async function connectWithHostKeyVerification<T, C extends HostKeyConnectConfig>(
    config: C,
    attempt: (config: C) => Promise<T>,
    confirm: (options: ConfirmHostKeyOptions) => Promise<boolean>,
    legacyKex?: LegacyKexApproval,
): Promise<T> {
    let approvedConfig = legacyKex
        ? configureLegacyKex(config, legacyKex.load ?? readLegacyKex)
        : config;
    const prompted = new Set<string>();
    const exceptions: Array<{ endpoint: SshEndpoint; algorithm: LegacyKex }> = [];
    for (;;) {
        let result: T;
        try {
            result = await attempt(approvedConfig);
        } catch (error) {
            const legacy = legacyKex && parseLegacyKexChallenge(error);
            if (legacy) {
                let hop: HostKeyConnectConfig | null = approvedConfig;
                while (hop && !sameSshEndpoint(hop, legacy)) {
                    hop = hop.jump_host;
                }
                if (!hop || hop.legacy_kex) {
                    throw error;
                }
                const endpoint = hop;
                const savedWhen = legacyKex?.savedWhen?.(endpoint);
                const host =
                    endpoint.host.includes(':') && !endpoint.host.startsWith('[')
                        ? `[${endpoint.host}]`
                        : endpoint.host;
                const retention =
                    savedWhen === 'on-success'
                        ? 'A successful retry remembers this exception on this device.'
                        : savedWhen === 'on-save'
                          ? 'If the test succeeds, saving this host will remember the exception on this device.'
                          : 'This approval applies to this attempt.';
                const accepted = await confirm({
                    title: 'Allow legacy SSH key exchange?',
                    message: `${host}:${endpoint.port} requires legacy key exchange. Allowing ${legacy.algorithm} weakens SSH security. ${retention}`,
                    confirmText: 'Allow & retry',
                    cancelText: 'Cancel',
                    variant: 'danger',
                });
                if (!accepted) {
                    throw new LegacyKexDeclinedError();
                }
                approvedConfig = configureLegacyKex(approvedConfig, (candidate) =>
                    sameSshEndpoint(candidate, endpoint) ? legacy.algorithm : candidate.legacy_kex,
                );
                exceptions.push({ endpoint, algorithm: legacy.algorithm });
                continue;
            }
            const challenge = parseHostKeyChallenge(error);
            if (!challenge) {
                throw error;
            }
            const promptKey = `${challenge.connectionId}:${challenge.fingerprint}:${challenge.kind}`;
            if (prompted.has(promptKey)) {
                throw error;
            }
            prompted.add(promptKey);
            if (!(await confirm(promptOptions(challenge)))) {
                throw new HostKeyVerificationCancelledError(challenge);
            }
            approvedConfig = approveChallenge(approvedConfig, challenge);
            continue;
        }
        for (const { endpoint, algorithm } of exceptions) {
            legacyKex?.onSuccess(endpoint, algorithm);
        }
        return result;
    }
}
