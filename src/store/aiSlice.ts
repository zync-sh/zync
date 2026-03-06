import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppStore } from './useAppStore';

const HISTORY_TAIL_LENGTH = 100;
const RETENTION_LIMIT = 100;

export interface AiResult {
    command: string;
    explanation: string;
    safety: 'safe' | 'moderate' | 'dangerous';
    answer?: string;
}

/** A single message in the AI conversation history (sent to backend as TOON-encoded context). */
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

/** A single displayed chat entry in the AI Command Bar UI. */
export interface AiDisplayEntry {
    query: string;
    result: AiResult | null;
    error: string | null;
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

    /** Per-terminal-tab conversation history (TOON context). Keyed by termId. Cleared when tab is closed. */
    aiConversations: Record<string, ChatMessage[]>;
    /** Per-terminal-tab display history (UI chat entries). Keyed by termId. Cleared when tab is closed. */
    aiDisplayHistory: Record<string, AiDisplayEntry[]>;

    openAiCommandBar: () => void;
    closeAiCommandBar: () => void;
    submitAiQuery: (query: string, context: Record<string, any>, termId: string | null) => Promise<void>;
    clearAiResult: () => void;
    pushAiHistory: (query: string) => void;
    clearAiQueryHistory: () => void;
    setAiHistoryIndex: (index: number) => void;
    checkOllama: () => Promise<boolean>;
    getOllamaModels: () => Promise<string[]>;
    getProviderModels: () => Promise<string[]>;

    /** Add a message to a terminal tab's conversation history. */
    addToConversation: (termId: string, message: ChatMessage) => void;
    /** Clear conversation history for a terminal tab (called on tab close). */
    clearConversation: (termId: string) => void;

    /** Append a display entry to a terminal tab's chat UI history. */
    addToDisplayHistory: (termId: string, entry: AiDisplayEntry) => void;
    /** Clear display history for a terminal tab (called on tab close). */
    clearDisplayHistory: (termId: string) => void;
}

export const createAiSlice: StateCreator<AppStore, [], [], AiSlice> = (set, get) => ({
    aiCommandBarOpen: false,
    aiLoading: false,
    aiResult: null,
    aiError: null,
    aiStreamingText: '',
    aiQueryHistory: [],
    aiHistoryIndex: -1,
    aiConversations: {},
    aiDisplayHistory: {},

    openAiCommandBar: () => set({ aiCommandBarOpen: true, aiResult: null, aiError: null, aiStreamingText: '', aiHistoryIndex: -1 }),
    closeAiCommandBar: () => set({ aiCommandBarOpen: false, aiLoading: false, aiStreamingText: '' }),
    clearAiResult: () => set({ aiResult: null, aiError: null, aiStreamingText: '' }),

    addToConversation: (termId, message) => set(state => {
        const existing = state.aiConversations[termId] || [];
        const newArr = [...existing, message];
        return {
            aiConversations: {
                ...state.aiConversations,
                [termId]: newArr.slice(-RETENTION_LIMIT),
            }
        };
    }),

    clearConversation: (termId) => set(state => {
        const next = { ...state.aiConversations };
        delete next[termId];
        return { aiConversations: next };
    }),

    addToDisplayHistory: (termId, entry) => set(state => {
        const existing = state.aiDisplayHistory[termId] || [];
        const newArr = [...existing, entry];
        return {
            aiDisplayHistory: {
                ...state.aiDisplayHistory,
                [termId]: newArr.slice(-RETENTION_LIMIT),
            }
        };
    }),

    clearDisplayHistory: (termId) => set(state => {
        const next = { ...state.aiDisplayHistory };
        delete next[termId];
        return { aiDisplayHistory: next };
    }),

    pushAiHistory: (query) => {
        const filtered = get().aiQueryHistory.filter(q => q !== query);
        set({ aiQueryHistory: [query, ...filtered].slice(0, 50) });
    },

    clearAiQueryHistory: () => set({ aiQueryHistory: [], aiHistoryIndex: -1 }),

    setAiHistoryIndex: (index) => set({ aiHistoryIndex: index }),

    submitAiQuery: async (query, context, termId) => {
        // Guard against concurrent calls — skip if already loading
        if (get().aiLoading) return;

        set({ aiLoading: true, aiResult: null, aiError: null, aiStreamingText: '' });
        const requestId = crypto.randomUUID();
        const cleanups: UnlistenFn[] = [];

        // Snapshot current history for this tab (sent as TOON-encoded context), capped to tail length
        const currentHistory = termId ? (get().aiConversations[termId] || []) : [];
        const history: ChatMessage[] = currentHistory.slice(-HISTORY_TAIL_LENGTH);

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
            await invoke('ai_translate_stream', { query, context, requestId, history });

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

                // Save this turn to per-tab conversation history
                if (termId) {
                    get().addToConversation(termId, { role: 'user', content: query });
                    // Store a compact summary of the AI response for the history
                    const aiContent = result.answer
                        ? result.answer
                        : `cmd:${result.command}`;
                    get().addToConversation(termId, { role: 'assistant', content: aiContent });
                }
            } else {
                set({ aiLoading: false, aiStreamingText: '' });
            }
        } catch (error: any) {
            const msg = error instanceof Error ? error.message : String(error);
            set({ aiError: msg, aiLoading: false, aiStreamingText: '' });
        } finally {
            for (const fn of cleanups) {
                fn();
            }
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
