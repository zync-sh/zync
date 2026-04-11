import { normalizeFolderPath, normalizeText, parsePort } from './normalization.js';

export interface ConnectionDraft {
    name?: string;
    host?: string;
    username?: string;
    port?: number | string;
    password?: string;
    privateKeyPath?: string;
    folder?: string;
}

export type AuthMode = 'password' | 'key';

export type ConnectionDraftField = 'host' | 'username' | 'port' | 'privateKeyPath';

export interface ValidationResult {
    ok: boolean;
    errors: string[];
    fieldErrors: Partial<Record<ConnectionDraftField, string>>;
    normalizedPort: number;
    normalizedFolder: string;
}

export interface CredentialHealthCheck {
    severity: 'info' | 'warning';
    message: string;
}

const isIpv4Literal = (value: string): boolean => {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
    return value.split('.').every((segment) => {
        const numeric = Number(segment);
        return Number.isInteger(numeric) && numeric >= 0 && numeric <= 255;
    });
};

/**
 * Heuristic only (not RFC-complete IPv6 validation).
 * Used to suppress an info-level host-format hint in form UX.
 * TODO: keep this helper scoped to hint logic; do not reuse for strict network validation.
 */
const isLikelyIpv6Literal = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed.includes(':')) return false;
    if (!/[0-9a-f]/i.test(trimmed)) return false;
    return /^[0-9a-f:.]+$/i.test(trimmed);
};

const isIpLiteral = (value: string): boolean => {
    if (!value) return false;
    const normalized = value.startsWith('[') && value.endsWith(']')
        ? value.slice(1, -1)
        : value;
    return isIpv4Literal(normalized) || isLikelyIpv6Literal(normalized);
};

export const hasRequiredHostAndUsername = (draft: ConnectionDraft): boolean =>
    !!normalizeText(draft.host) && !!normalizeText(draft.username);

export const validateConnectionDraft = (draft: ConnectionDraft, authMode: AuthMode): ValidationResult => {
    const errors: string[] = [];
    const fieldErrors: ValidationResult['fieldErrors'] = {};
    const portResult = parsePort(draft.port);
    const normalizedPort = portResult.normalizedPort;
    const normalizedFolder = normalizeFolderPath(draft.folder);
    const normalizedHost = normalizeText(draft.host);
    const normalizedUsername = normalizeText(draft.username);

    if (!normalizedHost) {
        const message = 'Host is required.';
        errors.push(message);
        fieldErrors.host = message;
    } else if (/\s/.test(normalizedHost)) {
        const message = 'Host cannot contain whitespace characters.';
        errors.push(message);
        fieldErrors.host = message;
    }
    if (!normalizedUsername) {
        const message = 'Username is required.';
        errors.push(message);
        fieldErrors.username = message;
    } else if (/\s/.test(normalizedUsername)) {
        const message = 'Username cannot contain whitespace characters.';
        errors.push(message);
        fieldErrors.username = message;
    }
    if (authMode === 'key' && !normalizeText(draft.privateKeyPath)) {
        const message = 'Private key path is required for key auth.';
        errors.push(message);
        fieldErrors.privateKeyPath = message;
    } else if (authMode === 'key' && /[\r\n]/.test(draft.privateKeyPath || '')) {
        const message = 'Private key path contains invalid characters.';
        errors.push(message);
        fieldErrors.privateKeyPath = message;
    }

    if (portResult.error) {
        errors.push(portResult.error);
        fieldErrors.port = portResult.error;
    }

    return { ok: errors.length === 0, errors, fieldErrors, normalizedPort, normalizedFolder };
};

export const getCredentialHealthChecks = (draft: ConnectionDraft, authMode: AuthMode): CredentialHealthCheck[] => {
    const checks: CredentialHealthCheck[] = [];
    const password = normalizeText(draft.password);
    const keyPath = normalizeText(draft.privateKeyPath);
    const host = normalizeText(draft.host).toLowerCase();
    const username = normalizeText(draft.username).toLowerCase();

    if (authMode === 'password' && !password) {
        checks.push({
            severity: 'info',
            message: 'Password is empty. Ensure server auth supports your selected flow.',
        });
    } else if (authMode === 'password' && password.length < 8) {
        checks.push({
            severity: 'warning',
            message: 'Password is very short. Verify credentials and server policy.',
        });
    }

    if (authMode === 'key' && keyPath.toLowerCase().endsWith('.pub')) {
        checks.push({
            severity: 'warning',
            message: 'Selected key looks like a public key (.pub). Choose a private key file.',
        });
    } else if (authMode === 'key' && keyPath && !/(\.pem|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(keyPath)) {
        checks.push({
            severity: 'info',
            message: 'Key filename is uncommon. Confirm this is a private key.',
        });
    }

    if ((host === 'localhost' || host === '127.0.0.1') && username === 'root') {
        checks.push({
            severity: 'warning',
            message: 'Using root@localhost is unusual for remote SSH. Confirm target details.',
        });
    }

    if (host && !host.includes('.') && !isIpLiteral(host)) {
        checks.push({
            severity: 'info',
            message: 'Host has no domain/IP pattern. Ensure DNS/host alias resolves correctly.',
        });
    }

    return checks;
};
