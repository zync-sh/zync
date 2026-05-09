import type { Connection } from './types.js';

export interface MergeResult {
    merged: Connection[];
    created: number;
    updated: number;
}

const generateUniqueId = (usedIds: Set<string>): string => {
    let next = '';
    do {
        next = crypto.randomUUID();
    } while (usedIds.has(next));
    return next;
};

export const preserveVaultCredentialOnUpdate = (
    existing: Connection,
    incoming: Connection,
): Connection => {
    if (incoming.authRef) {
        return {
            ...incoming,
            password: undefined,
            privateKeyPath: undefined,
        };
    }
    if (!existing.authRef) return incoming;

    return {
        ...incoming,
        authRef: existing.authRef,
        password: undefined,
        privateKeyPath: undefined,
    };
};

// Current strategy parity: name is the import identity key in existing flow.
export const mergeImportedConnectionsByName = (
    existing: Connection[],
    imported: Connection[],
): MergeResult => {
    const existingMap = new Map<string, Connection[]>();
    for (const conn of existing) {
        const list = existingMap.get(conn.name);
        if (list) {
            list.push(conn);
        } else {
            existingMap.set(conn.name, [conn]);
        }
    }
    const usedIds = new Set(existing.map((c) => c.id));
    const matchedIds = new Set<string>();

    let created = 0;
    let updated = 0;
    const mergedImported: Connection[] = [];

    for (const incoming of imported) {
        const matches = existingMap.get(incoming.name);
        // Duplicate names are matched in order: each imported entry consumes the
        // next existing match, then preserveVaultCredentialOnUpdate keeps vault
        // secrets while matchedIds/mergedImported track the update target.
        const match = matches && matches.length > 0 ? matches.shift() : undefined;
        if (match) {
            updated += 1;
            matchedIds.add(match.id);
            const secureIncoming = preserveVaultCredentialOnUpdate(match, incoming);
            mergedImported.push({ ...match, ...secureIncoming, id: match.id, status: match.status });
        } else {
            created += 1;
            const normalizedId = (incoming.id || '').trim();
            const safeId = normalizedId && !usedIds.has(normalizedId)
                ? normalizedId
                : generateUniqueId(usedIds);
            usedIds.add(safeId);
            mergedImported.push({ ...incoming, id: safeId });
        }
    }

    const preserved = existing.filter((c) => !matchedIds.has(c.id));
    const merged = [...preserved, ...mergedImported];
    return { merged, created, updated };
};
