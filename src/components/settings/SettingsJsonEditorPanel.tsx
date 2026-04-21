import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileEditorHost } from '../FileEditorHost';
import { CODEMIRROR_EDITOR_ID } from '../editor/providers';
import { useAppStore } from '../../store/useAppStore';

interface SettingsFilePayload {
    path: string;
    content: string;
    modifiedMs?: number;
}

interface SettingsJsonEditorPanelProps {
    onClose?: () => void;
}

const NOOP_CLOSE = () => { };
const SETTINGS_CHANGED_ON_DISK_ERROR_CODE = 'SETTINGS_CHANGED_ON_DISK';

interface NormalizedSettingsError {
    code?: string;
    message: string;
}

/**
 * Normalize backend invoke errors into a stable { code, message } shape.
 * Supports:
 * - structured JSON error strings
 * - Error objects with code/message fields
 * - legacy plain string messages
 */
function normalizeSettingsError(error: unknown): NormalizedSettingsError {
    if (error && typeof error === 'object') {
        const maybeCode = (error as { code?: unknown }).code;
        const maybeMessage = (error as { message?: unknown }).message;
        if (typeof maybeCode === 'string' || typeof maybeMessage === 'string') {
            return {
                code: typeof maybeCode === 'string' ? maybeCode : undefined,
                message: typeof maybeMessage === 'string' ? maybeMessage : 'Failed to save settings.json',
            };
        }
    }

    const rawMessage = typeof error === 'string'
        ? error
        : (error as { message?: string; toString?: () => string } | undefined)?.message
            ?? (error as { toString?: () => string } | undefined)?.toString?.()
            ?? 'Failed to save settings.json';

    const normalizedRaw = rawMessage.startsWith('Error: ')
        ? rawMessage.slice('Error: '.length)
        : rawMessage;

    try {
        const parsed = JSON.parse(normalizedRaw) as { code?: unknown; message?: unknown };
        if (typeof parsed?.message === 'string' || typeof parsed?.code === 'string') {
            return {
                code: typeof parsed.code === 'string' ? parsed.code : undefined,
                message: typeof parsed.message === 'string' ? parsed.message : 'Failed to save settings.json',
            };
        }
    } catch {
        // Non-JSON errors fall back to plain text handling.
    }

    return { message: rawMessage };
}

/**
 * Full-screen, in-app editor for native `settings.json`.
 *
 * Design goals:
 * - Keep users inside Zync (no external editor dependency).
 * - Provide safe write flow with conflict detection + recovery.
 * - Surface external-file changes while editing.
 */
export function SettingsJsonEditorPanel({ onClose }: SettingsJsonEditorPanelProps) {
    const showToast = useAppStore((state) => state.showToast);
    const loadSettings = useAppStore((state) => state.loadSettings);
    const [settingsJsonContent, setSettingsJsonContent] = useState('{}\n');
    const [settingsJsonModifiedMs, setSettingsJsonModifiedMs] = useState<number | undefined>(undefined);
    const [isLoadingSettingsJson, setIsLoadingSettingsJson] = useState(false);
    const [settingsJsonError, setSettingsJsonError] = useState<string | null>(null);
    const [hasExternalChange, setHasExternalChange] = useState(false);
    const settingsJsonModifiedMsRef = useRef<number | undefined>(undefined);
    const platform = typeof navigator !== 'undefined'
        ? ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent)
        : '';
    const isMac = /mac/i.test(platform);
    const modKey = isMac ? 'Cmd' : 'Ctrl';

    const loadSettingsJson = useCallback(async () => {
        setIsLoadingSettingsJson(true);
        setSettingsJsonError(null);
        try {
            const payload = await invoke<SettingsFilePayload>('settings_read_raw');
            setSettingsJsonContent(payload.content);
            setSettingsJsonModifiedMs(payload.modifiedMs);
            setHasExternalChange(false);
        } catch (error: unknown) {
            const normalized = normalizeSettingsError(error);
            setSettingsJsonError(normalized.message);
            if (normalized.code === SETTINGS_CHANGED_ON_DISK_ERROR_CODE) {
                setHasExternalChange(true);
            }
            showToast('error', normalized.message);
        } finally {
            setIsLoadingSettingsJson(false);
        }
    }, [showToast]);

    const saveSettingsJson = useCallback(async (content: string) => {
        setSettingsJsonError(null);
        try {
            const payload = await invoke<SettingsFilePayload>('settings_write_raw', {
                content,
                expectedModifiedMs: settingsJsonModifiedMs
            });
            setSettingsJsonModifiedMs(payload.modifiedMs);
            setHasExternalChange(false);
            await loadSettings();
            showToast('success', 'settings.json saved');
        } catch (error: unknown) {
            const normalized = normalizeSettingsError(error);
            setSettingsJsonError(normalized.message);
            if (normalized.code === SETTINGS_CHANGED_ON_DISK_ERROR_CODE) {
                setHasExternalChange(true);
            }
            showToast('error', normalized.message);
            throw error;
        }
    }, [loadSettings, settingsJsonModifiedMs, showToast]);

    const restoreLastKnownGoodSettings = useCallback(async () => {
        setSettingsJsonError(null);
        try {
            const payload = await invoke<SettingsFilePayload>('settings_restore_last_known_good');
            setSettingsJsonContent(payload.content);
            setSettingsJsonModifiedMs(payload.modifiedMs);
            setHasExternalChange(false);
            await loadSettings();
            showToast('success', 'Restored last-known-good settings');
        } catch (error: unknown) {
            const normalized = normalizeSettingsError(error);
            setSettingsJsonError(normalized.message);
            if (normalized.code === SETTINGS_CHANGED_ON_DISK_ERROR_CODE) {
                setHasExternalChange(true);
            }
            showToast('error', normalized.message);
        }
    }, [loadSettings, showToast]);

    // Poll for external mutations (manual edits / other process writes).
    useEffect(() => {
        loadSettingsJson();
    }, [loadSettingsJson]);

    useEffect(() => {
        settingsJsonModifiedMsRef.current = settingsJsonModifiedMs;
    }, [settingsJsonModifiedMs]);

    useEffect(() => {
        const timer = window.setInterval(async () => {
            try {
                const payload = await invoke<SettingsFilePayload>('settings_read_raw');
                if (
                    settingsJsonModifiedMsRef.current !== undefined &&
                    payload.modifiedMs !== undefined &&
                    payload.modifiedMs !== settingsJsonModifiedMsRef.current
                ) {
                    setHasExternalChange(true);
                }
            } catch {
                // ignore background poll errors
            }
        }, 3000);

        return () => window.clearInterval(timer);
    }, []);

    return (
        <div className="h-full flex flex-col animate-in fade-in duration-300 bg-app-bg">
            <div className="flex h-9 items-center justify-between border-b border-app-border px-3">
                <div className="min-w-0 truncate text-sm font-semibold text-app-text">
                    settings.json
                </div>
                <div className="flex items-center gap-2">
                    <span className="rounded border border-app-border bg-app-surface/40 px-2 py-0.5 text-[10px] font-medium text-app-muted">
                        {modKey}+S
                    </span>
                    <span className="rounded border border-app-border bg-app-surface/40 px-2 py-0.5 text-[10px] font-medium text-app-muted">
                        {modKey}+F
                    </span>
                    <button
                        onClick={loadSettingsJson}
                        className="px-2 py-1 rounded-md text-[11px] border border-app-border hover:bg-app-surface"
                    >
                        Reload
                    </button>
                    <button
                        onClick={restoreLastKnownGoodSettings}
                        className="px-2 py-1 rounded-md text-[11px] border border-app-border hover:bg-app-surface"
                    >
                        Restore
                    </button>
                </div>
            </div>
            {(hasExternalChange || settingsJsonError) && (
                <div className="border-b border-app-border px-3 py-1.5 text-[11px] text-app-muted space-y-1">
                    {hasExternalChange && (
                        <div className="text-amber-300">
                            settings.json changed externally. Reload before saving.
                        </div>
                    )}
                    {settingsJsonError && (
                        <div className="text-red-400">
                            {settingsJsonError}
                        </div>
                    )}
                </div>
            )}
            <div className="relative flex-1 min-h-0 overflow-hidden">
                {isLoadingSettingsJson ? (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--color-app-muted)]">
                        Loading settings.json...
                    </div>
                ) : (
                    <FileEditorHost
                        filename="settings.json"
                        initialContent={settingsJsonContent}
                        onSave={saveSettingsJson}
                        onClose={onClose || NOOP_CLOSE}
                        hideToolbar
                        preferredProviderId={CODEMIRROR_EDITOR_ID}
                    />
                )}
            </div>
        </div>
    );
}
