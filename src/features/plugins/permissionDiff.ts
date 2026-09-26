import type {
    PluginPermissionDeclarations,
    PluginPermissionRequest,
} from './types';

export type PluginPermissionChange = 'added' | 'changed' | 'unchanged' | 'removed';

export interface PluginPermissionDiffEntry {
    id: string;
    change: PluginPermissionChange;
    before?: PluginPermissionRequest & { required: boolean };
    after?: PluginPermissionRequest & { required: boolean };
}

export interface PluginPermissionDiff {
    entries: PluginPermissionDiffEntry[];
    added: PluginPermissionDiffEntry[];
    changed: PluginPermissionDiffEntry[];
    unchanged: PluginPermissionDiffEntry[];
    removed: PluginPermissionDiffEntry[];
    optionalSelectedByDefault: string[];
}

function flatten(declarations?: PluginPermissionDeclarations | null) {
    const permissions = new Map<string, PluginPermissionRequest & { required: boolean }>();
    for (const permission of declarations?.required ?? []) {
        permissions.set(permission.id, { ...permission, required: true });
    }
    for (const permission of declarations?.optional ?? []) {
        permissions.set(permission.id, { ...permission, required: false });
    }
    return permissions;
}

function accessSignature(permission: PluginPermissionRequest & { required: boolean }): string {
    return JSON.stringify({
        required: permission.required,
        scope: permission.scope ?? null,
        hosts: [...(permission.hosts ?? [])].sort(),
    });
}

export function diffPluginPermissions(
    previous: PluginPermissionDeclarations | null | undefined,
    next: PluginPermissionDeclarations | null | undefined,
    previouslyGrantedOptional: string[] = [],
): PluginPermissionDiff {
    const before = flatten(previous);
    const after = flatten(next);
    const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
    const entries = ids.map((id): PluginPermissionDiffEntry => {
        const previousPermission = before.get(id);
        const nextPermission = after.get(id);
        if (!previousPermission) return { id, change: 'added', after: nextPermission };
        if (!nextPermission) return { id, change: 'removed', before: previousPermission };
        return {
            id,
            change: accessSignature(previousPermission) === accessSignature(nextPermission)
                ? 'unchanged'
                : 'changed',
            before: previousPermission,
            after: nextPermission,
        };
    });
    const granted = new Set(previouslyGrantedOptional);
    const optionalSelectedByDefault = entries
        .filter(entry => (
            entry.change === 'unchanged'
            && entry.before?.required === false
            && entry.after?.required === false
            && granted.has(entry.id)
        ))
        .map(entry => entry.id);
    return {
        entries,
        added: entries.filter(entry => entry.change === 'added'),
        changed: entries.filter(entry => entry.change === 'changed'),
        unchanged: entries.filter(entry => entry.change === 'unchanged'),
        removed: entries.filter(entry => entry.change === 'removed'),
        optionalSelectedByDefault,
    };
}
