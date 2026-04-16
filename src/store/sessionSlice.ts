import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AppStore } from './useAppStore';

// ─── Types (mirrors Rust SessionData) ────────────────────────────────────────

export interface TerminalTabSnapshot {
    id: string;
    title: string;
    cwd?: string;
    initialPath?: string;
    isSynced?: boolean;
}

export interface TabSnapshot {
    id: string;
    tabType: string;
    title: string;
    connectionId?: string;
    view: string;
}

interface SessionData {
    version: number;
    activeTabId?: string;
    activeConnectionId?: string;
    tabs: TabSnapshot[];
    terminals: Record<string, TerminalTabSnapshot[]>;
    activeTerminalIds: Record<string, string>;
}

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface SessionSlice {
    /** True once loadSession() has finished (success or failure). Gates UI render. */
    sessionLoaded: boolean;
    /** True while restoreTerminalTabs is running. Suppresses saveSession calls. */
    isRestoring: boolean;
    loadSession: () => Promise<void>;
    saveSession: () => Promise<void>;
}

// Keep in sync with MAX_TABS_PER_SCOPE in session.rs
const MAX_TABS_PER_SCOPE = 20;

// ─── Module-level debounce + dirty check ────────────────────────────────────

let _cwdDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSavedSnapshot = '';
let _pendingSave: Promise<void> = Promise.resolve();

/** Debounced wrapper used by setTerminalCwd — fires 1 s after the last call. */
export function scheduleSaveSession(saveSession: () => Promise<void>): void {
    if (_cwdDebounceTimer !== null) clearTimeout(_cwdDebounceTimer);
    _cwdDebounceTimer = setTimeout(() => {
        _cwdDebounceTimer = null;
        saveSession().catch(err => console.warn('[Session] CWD save failed:', err));
    }, 1000);
}

/**
 * Clears the CWD debounce timer and resets the dirty-check snapshot.
 * Call this in tests (afterEach) and HMR cleanup to prevent cross-instance leakage
 * from the module-level mutable state.
 */
export function resetSessionDebounce(): void {
    if (_cwdDebounceTimer !== null) {
        clearTimeout(_cwdDebounceTimer);
        _cwdDebounceTimer = null;
    }
    _lastSavedSnapshot = '';
    _pendingSave = Promise.resolve();
}

// ─── Slice factory ────────────────────────────────────────────────────────────

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = (set, get) => ({
    sessionLoaded: false,
    isRestoring: false,

    loadSession: async () => {
        try {
            const data = await invoke<SessionData | null>('session_load');
            if (!data) return;

            set({ isRestoring: true });

            // Phase 2: restore sidebar tabs (connections must already be loaded).
            if (data.tabs?.length) {
                get().restoreTabState(
                    data.tabs,
                    data.activeTabId ?? null,
                    data.activeConnectionId ?? null,
                );
            }

            // Phase 3: restore terminal tabs for all scopes.
            // Local tabs get live PTYs; SSH tabs are metadata-only until reconnect.
            const knownConnectionIds = new Set(get().connections.map(c => c.id));
            for (const [scopeId, snapshots] of Object.entries(data.terminals ?? {})) {
                if (!snapshots?.length) continue;
                // Skip orphaned scopes — connection was deleted since last session.
                if (scopeId !== 'local' && !knownConnectionIds.has(scopeId)) continue;
                get().restoreTerminalTabs(
                    scopeId,
                    snapshots.slice(0, MAX_TABS_PER_SCOPE),
                    data.activeTerminalIds?.[scopeId] ?? null,
                );
            }
        } catch (e) {
            console.warn('[Session] Failed to load session:', e);
        } finally {
            // Always unblock the UI — even if restore failed.
            set({ sessionLoaded: true, isRestoring: false });
        }
    },

    saveSession: async () => {
        // Never save mid-restore — would overwrite the snapshot we're reading.
        if (get().isRestoring) return;

        const state = get();

        const data: SessionData = {
            version: 1,
            activeTabId: state.activeTabId ?? undefined,
            activeConnectionId: state.activeConnectionId ?? undefined,
            // Exclude transient UI-only tabs (settings) from persistence.
            tabs: (state.tabs ?? [])
                .filter(t => t.type !== 'settings')
                .map(t => ({
                    id: t.id,
                    tabType: t.type,
                    title: t.title,
                    connectionId: t.connectionId,
                    view: t.view,
                })),
            terminals: Object.fromEntries(
                Object.entries(state.terminals ?? {}).map(([connId, tabs]) => [
                    connId,
                    tabs.slice(0, MAX_TABS_PER_SCOPE).map(t => ({
                        id: t.id,
                        title: t.title,
                        cwd: t.lastKnownCwd,
                        initialPath: t.initialPath,
                        isSynced: t.isSynced,
                    })),
                ]),
            ),
            activeTerminalIds: Object.fromEntries(
                (Object.entries(state.activeTerminalIds ?? {}) as [string, string | null][])
                    .filter((entry): entry is [string, string] => entry[1] != null),
            ),
        };

        // Dirty check: skip the IPC round-trip if nothing changed.
        const snapshot = JSON.stringify(data);
        if (snapshot === _lastSavedSnapshot) return;

        // Chain through _pendingSave so concurrent calls never interleave writes.
        // Only update _lastSavedSnapshot after a successful invoke so a failed
        // write doesn't suppress the next retry.
        _pendingSave = _pendingSave.then(async () => {
            if (snapshot === _lastSavedSnapshot) return; // deduplicate if batched
            try {
                await invoke('session_save', { data });
                _lastSavedSnapshot = snapshot;
            } catch (e) {
                console.warn('[Session] Failed to save session:', e);
            }
        });
        await _pendingSave;
    },
});
