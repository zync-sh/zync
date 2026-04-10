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
        const message = 'Host cannot contain spaces.';
        errors.push(message);
        fieldErrors.host = message;
    }
    if (!normalizedUsername) {
        const message = 'Username is required.';
        errors.push(message);
        fieldErrors.username = message;
    } else if (/\s/.test(normalizedUsername)) {
        const message = 'Username cannot contain spaces.';
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

    if (authMode === 'password' && !password) {
        checks.push({
            severity: 'info',
            message: 'Password is empty. Ensure server auth supports your selected flow.',
        });
    }

    if (authMode === 'key' && keyPath.toLowerCase().endsWith('.pub')) {
        checks.push({
            severity: 'warning',
            message: 'Selected key looks like a public key (.pub). Choose a private key file.',
        });
    }

    return checks;
};
