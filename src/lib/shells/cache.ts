import type { ShellEntry } from './types';

const REMOTE_STORAGE_PREFIX = 'zync.shells.v1.';
const REMOTE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface RemoteShellCacheRecord {
    cachedAt: number;
    shells: ShellEntry[];
}

function isShellEntry(entry: unknown): entry is ShellEntry {
    // Intentionally validate required fields only. Optional properties (icon,
    // elevated) may be absent in old cache payloads and are reconstructed by
    // UI fallbacks.
    return Boolean(
        entry
        && typeof entry === 'object'
        && typeof (entry as ShellEntry).id === 'string'
        && typeof (entry as ShellEntry).label === 'string'
    );
}

function isShellEntryList(value: unknown): value is ShellEntry[] {
    return Array.isArray(value) && value.every(isShellEntry);
}

function isFresh(cachedAt: number, now = Date.now()): boolean {
    return Number.isFinite(cachedAt)
        && cachedAt <= now
        && now - cachedAt <= REMOTE_CACHE_TTL_MS;
}

/** Read a per-connection remote shell cache entry.
 *
 * Backward compatible with the original raw `ShellEntry[]` payload. Legacy
 * entries are accepted and immediately upgraded to the TTL-aware shape.
 */
export function loadRemoteShellCache(connectionId: string): ShellEntry[] | null {
    const key = REMOTE_STORAGE_PREFIX + connectionId;
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;

        const parsed: unknown = JSON.parse(raw);
        if (isShellEntryList(parsed)) {
            saveRemoteShellCache(connectionId, parsed);
            return parsed;
        }

        const record = parsed as Partial<RemoteShellCacheRecord>;
        if (
            typeof record.cachedAt === 'number'
            && isFresh(record.cachedAt)
            && isShellEntryList(record.shells)
        ) {
            return record.shells;
        }

        localStorage.removeItem(key);
        return null;
    } catch {
        return null;
    }
}

export function saveRemoteShellCache(connectionId: string, shells: ShellEntry[]): void {
    try {
        const payload: RemoteShellCacheRecord = {
            cachedAt: Date.now(),
            shells,
        };
        localStorage.setItem(REMOTE_STORAGE_PREFIX + connectionId, JSON.stringify(payload));
    } catch {
        // Quota exceeded or storage disabled — fine, falls through to in-memory only.
    }
}

export function clearRemoteShellCache(connectionId: string): void {
    try {
        localStorage.removeItem(REMOTE_STORAGE_PREFIX + connectionId);
    } catch {
        // Storage disabled — nothing to clear.
    }
}
