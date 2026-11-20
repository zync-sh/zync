import type { ConnectionAuthMode } from './formTransforms.js';
import type { Connection } from './types.js';

/** Clear overloaded secrets when switching auth modes so login password ≠ key passphrase. */
export function applyAuthMethodTransition(
    formData: Partial<Connection>,
    from: ConnectionAuthMode,
    to: ConnectionAuthMode,
): Partial<Connection> {
    if (from === to) {
        return formData;
    }
    if (to === 'password') {
        return {
            ...formData,
            password: '',
            privateKeyPath: undefined,
            authRef: undefined,
            certificatePath: undefined,
            useSshAgent: undefined,
            agentKey: undefined,
        };
    }
    if (to === 'agent') {
        return {
            ...formData,
            password: '',
            privateKeyPath: undefined,
            authRef: undefined,
            certificatePath: undefined,
        };
    }
    if (from === 'agent') {
        return { ...formData, useSshAgent: undefined, agentKey: undefined, authRef: undefined };
    }
    if (from === 'password' && to === 'key') {
        return { ...formData, password: '', authRef: undefined };
    }
    if (from === 'password' && to === 'vault') {
        return { ...formData, password: '', privateKeyPath: undefined };
    }
    if (from === 'key' && to === 'vault') {
        return { ...formData, password: '', privateKeyPath: undefined };
    }
    if (from === 'vault' && to === 'key') {
        return { ...formData, password: '', authRef: undefined };
    }
    return formData;
}
