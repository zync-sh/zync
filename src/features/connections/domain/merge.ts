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
    const importedNames = new Set(imported.map((c) => c.name));
    const usedIds = new Set(existing.map((c) => c.id));

    let created = 0;
    let updated = 0;
    const mergedImported: Connection[] = [];

    for (const incoming of imported) {
        const matches = existingMap.get(incoming.name);
        const match = matches && matches.length > 0 ? matches.shift() : undefined;
        if (match) {
            updated += 1;
            const preservedMetadata: Partial<Connection> = {
                isFavorite: match.isFavorite,
                pinnedFeatures: match.pinnedFeatures,
                icon: match.icon,
                lastConnected: match.lastConnected,
                homePath: match.homePath,
                createdAt: match.createdAt,
            };
            mergedImported.push({ ...incoming, ...preservedMetadata, id: match.id, status: match.status });
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

    const preserved = existing.filter((c) => !importedNames.has(c.name));
    const merged = [...preserved, ...mergedImported];
    return { merged, created, updated };
};
