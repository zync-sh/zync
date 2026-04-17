import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AppStore } from './useAppStore';
import {
    buildSessionData,
    MAX_TABS_PER_SCOPE,
    type SessionData,
} from './sessionPersistence';

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface SessionSlice {
    /** True once loadSession() has finished (success or failure). Gates UI render. */
    sessionLoaded: boolean;
    /** True while restoreTerminalTabs is running. Suppresses saveSession calls. */
    isRestoring: boolean;
    loadSession: () => Promise<void>;
    saveSession: () => Promise<void>;
}

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

        const data: SessionData = buildSessionData(get());

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
