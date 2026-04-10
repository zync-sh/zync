import { normalizeFolderPath, normalizePort, normalizeText } from './normalization.js';

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

export const hasRequiredHostAndUsername = (draft: ConnectionDraft): boolean =>
    !!normalizeText(draft.host) && !!normalizeText(draft.username);

export const validateConnectionDraft = (draft: ConnectionDraft, authMode: AuthMode): ValidationResult => {
    const errors: string[] = [];
    const fieldErrors: ValidationResult['fieldErrors'] = {};
    const normalizedPort = normalizePort(draft.port);
    const normalizedFolder = normalizeFolderPath(draft.folder);
    const normalizedHost = normalizeText(draft.host);
    const normalizedUsername = normalizeText(draft.username);

    if (!normalizedHost) {
        const message = 'Host is required.';
        errors.push(message);
        fieldErrors.host = message;
    }
    if (!normalizedUsername) {
        const message = 'Username is required.';
        errors.push(message);
        fieldErrors.username = message;
    }
    if (authMode === 'key' && !normalizeText(draft.privateKeyPath)) {
        const message = 'Private key path is required for key auth.';
        errors.push(message);
        fieldErrors.privateKeyPath = message;
    }

    // Keep parity with current app behavior: invalid ports normalize to 22.
    // This validation only guards hard-invalid values that become NaN before normalize.
    if (draft.port !== undefined && Number.isNaN(Number(draft.port))) {
        const message = 'Port must be a valid number.';
        errors.push(message);
        fieldErrors.port = message;
    }

    return { ok: errors.length === 0, errors, fieldErrors, normalizedPort, normalizedFolder };
};
