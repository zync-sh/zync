import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppStore } from './useAppStore';

export interface AiResult {
    command: string;
    explanation: string;
    safety: 'safe' | 'moderate' | 'dangerous';
    answer?: string;
}

interface AiStreamChunkPayload {
    requestId: string;
    chunk: string;
    done: boolean;
    error: string | null;
}

interface AiStreamDonePayload {
    requestId: string;
    result: AiResult | null;
    error: string | null;
}

export interface AiSlice {
    aiCommandBarOpen: boolean;
    aiLoading: boolean;
    aiResult: AiResult | null;
    aiError: string | null;
    aiStreamingText: string;
    aiQueryHistory: string[];
    aiHistoryIndex: number;

    openAiCommandBar: () => void;
    closeAiCommandBar: () => void;
    submitAiQuery: (query: string, context: Record<string, any>) => Promise<void>;
    clearAiResult: () => void;
    pushAiHistory: (query: string) => void;
    setAiHistoryIndex: (index: number) => void;
    checkOllama: () => Promise<boolean>;
    getOllamaModels: () => Promise<string[]>;
    getProviderModels: () => Promise<string[]>;
}

export const createAiSlice: StateCreator<AppStore, [], [], AiSlice> = (set, get) => ({
    aiCommandBarOpen: false,
    aiLoading: false,
    aiResult: null,
    aiError: null,
    aiStreamingText: '',
    aiQueryHistory: [],
    aiHistoryIndex: -1,

    openAiCommandBar: () => set({ aiCommandBarOpen: true, aiResult: null, aiError: null, aiStreamingText: '', aiHistoryIndex: -1 }),
    closeAiCommandBar: () => set({ aiCommandBarOpen: false, aiLoading: false, aiStreamingText: '' }),
    clearAiResult: () => set({ aiResult: null, aiError: null, aiStreamingText: '' }),

    pushAiHistory: (query) => {
        const filtered = get().aiQueryHistory.filter(q => q !== query);
        set({ aiQueryHistory: [query, ...filtered].slice(0, 50) });
    },

    setAiHistoryIndex: (index) => set({ aiHistoryIndex: index }),

    submitAiQuery: async (query, context) => {
        // Guard against concurrent calls — skip if already loading
        if (get().aiLoading) return;

        set({ aiLoading: true, aiResult: null, aiError: null, aiStreamingText: '' });
        const requestId = crypto.randomUUID();
        const cleanups: UnlistenFn[] = [];

        // Shared resolve/reject refs so both chunk-error and done listeners can settle the promise
        let resolveDone: ((result: AiResult | null) => void) | null = null;
        let rejectDone: ((err: Error) => void) | null = null;

        try {
            // Listen for streaming chunks
            const unlistenChunk = await listen<AiStreamChunkPayload>('ai:stream-chunk', (event) => {
                if (event.payload.requestId !== requestId) return;
                if (event.payload.error) {
                    set({ aiError: event.payload.error, aiLoading: false, aiStreamingText: '' });
                    rejectDone?.(new Error(event.payload.error));
                    return;
                }
                set(state => ({ aiStreamingText: state.aiStreamingText + event.payload.chunk }));
            });
            cleanups.push(unlistenChunk);

            // Await listen() so unlisten is captured synchronously before the promise can settle
            const unlistenDone = await listen<AiStreamDonePayload>('ai:stream-done', (event) => {
                if (event.payload.requestId !== requestId) return;
                if (event.payload.error) {
                    rejectDone?.(new Error(event.payload.error));
                } else {
                    resolveDone?.(event.payload.result);
                }
            });
            cleanups.push(unlistenDone);

            const donePromise = new Promise<AiResult | null>((resolve, reject) => {
                resolveDone = resolve;
                rejectDone = reject;
            });

            // Fire the streaming command (returns immediately)
            await invoke('ai_translate_stream', { query, context, requestId });

            // Wait for the done event
            const result = await donePromise;

            if (result) {
                set({
                    aiResult: {
                        command: result.command,
                        explanation: result.explanation,
                        safety: (result.safety as AiResult['safety']) || 'moderate',
                        answer: result.answer ?? undefined,
                    },
                    aiLoading: false,
                    aiStreamingText: '',
                });
            } else {
                set({ aiLoading: false, aiStreamingText: '' });
            }
        } catch (error: any) {
            const msg = error instanceof Error ? error.message : String(error);
            set({ aiError: msg, aiLoading: false, aiStreamingText: '' });
        } finally {
            cleanups.forEach(fn => fn());
        }
    },

    checkOllama: async () => {
        try {
            return await invoke<boolean>('ai_check_ollama');
        } catch {
            return false;
        }
    },

    getOllamaModels: async () => {
        try {
            return await invoke<string[]>('ai_get_ollama_models');
        } catch {
            return [];
        }
    },

    getProviderModels: async () => {
        try {
            return await invoke<string[]>('ai_get_provider_models');
        } catch {
            return [];
        }
    },
});
