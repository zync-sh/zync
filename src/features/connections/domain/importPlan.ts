import type { Connection } from '../../../store/connectionSlice';
import { normalizePort, normalizeText } from './normalization.js';

export type ImportResolution = 'new' | 'update' | 'skip';

export interface ImportPlanRow {
    imported: Connection;
    matchedByName: Connection | null;
    matchedByEndpoint: Connection | null;
    recommended: Exclude<ImportResolution, 'skip'>;
}

export interface AppliedImportPlan {
    toImport: Array<{
        connection: Connection;
        targetId: string | null;
        matchType: 'name' | 'endpoint' | null;
    }>;
    created: number;
    updated: number;
    skipped: number;
    renamed: Array<{ id: string; from: string; to: string }>;
}

const makeUniqueName = (baseName: string, usedNames: Set<string>): string => {
    const sanitizedBase = normalizeText(baseName) || 'Imported Connection';
    let candidate = `${sanitizedBase} (imported)`;
    let index = 2;
    while (usedNames.has(normalizeText(candidate))) {
        candidate = `${sanitizedBase} (imported ${index})`;
        index += 1;
    }
    usedNames.add(normalizeText(candidate));
    return candidate;
};

const sameEndpoint = (left: Connection, right: Connection): boolean =>
    normalizeText(left.host).toLowerCase() === normalizeText(right.host).toLowerCase()
    && normalizeText(left.username).toLowerCase() === normalizeText(right.username).toLowerCase()
    && normalizePort(left.port) === normalizePort(right.port);

export const buildImportPlanRows = (
    existing: Connection[],
    imported: Connection[],
): ImportPlanRow[] => {
    const byName = new Map<string, Connection[]>();
    for (const conn of existing) {
        const key = normalizeText(conn.name);
        const list = byName.get(key);
        if (list) list.push(conn);
        else byName.set(key, [conn]);
    }

    return imported.map((incoming) => {
        const matchedByName = (byName.get(normalizeText(incoming.name)) || [])[0] || null;
        const matchedByEndpoint = existing.find((conn) => sameEndpoint(conn, incoming)) || null;

        return {
            imported: incoming,
            matchedByName,
            matchedByEndpoint,
            recommended: matchedByName ? 'update' : 'new',
        };
    });
};

export const applyImportPlan = (
    existing: Connection[],
    rows: ImportPlanRow[],
    decisions: Record<string, ImportResolution>,
): AppliedImportPlan => {
    const usedNames = new Set(existing.map((conn) => normalizeText(conn.name)).filter(Boolean));
    const toImport: AppliedImportPlan['toImport'] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const renamed: Array<{ id: string; from: string; to: string }> = [];

    for (const row of rows) {
        const incoming = row.imported;
        const decision = decisions[incoming.id] || row.recommended;

        if (decision === 'skip') {
            skipped += 1;
            continue;
        }

        if (decision === 'new') {
            const hasNameConflict = !!row.matchedByName || usedNames.has(normalizeText(incoming.name));
            if (hasNameConflict) {
                const uniqueName = makeUniqueName(incoming.name || incoming.host, usedNames);
                renamed.push({ id: incoming.id, from: incoming.name || incoming.host, to: uniqueName });
                toImport.push({
                    connection: { ...incoming, name: uniqueName },
                    targetId: null,
                    matchType: null,
                });
            } else {
                const normalized = normalizeText(incoming.name);
                if (normalized) usedNames.add(normalized);
                toImport.push({
                    connection: incoming,
                    targetId: null,
                    matchType: null,
                });
            }
            created += 1;
            continue;
        }

        const target = row.matchedByName || row.matchedByEndpoint;
        const matchType: 'name' | 'endpoint' | null = row.matchedByName ? 'name' : row.matchedByEndpoint ? 'endpoint' : null;
        toImport.push({
            connection: incoming,
            targetId: target?.id || null,
            matchType,
        });
        updated += 1;
    }

    return { toImport, created, updated, skipped, renamed };
};
