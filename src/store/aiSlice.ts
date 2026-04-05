import { StateCreator } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppStore } from './useAppStore';
import {
    checkOllamaAvailability,
    fetchOllamaModels,
    fetchProviderModels,
    translateAiStream,
} from '../ai/services/aiClient';
import type {
    AiContext,
    AiDisplayEntry,
    AiResult,
    AiStreamChunkPayload,
    AiStreamDonePayload,
    ChatMessage,
} from '../ai/types/common';

const HISTORY_TAIL_LENGTH = 100;
const RETENTION_LIMIT = 200;

export interface AiSlice {
    aiLoading: boolean;
    aiResult: AiResult | null;
    aiError: string | null;
    aiStreamingText: string;
    clearAiResult: () => void;

    aiQueryHistory: string[];
    aiHistoryIndex: number;
    pushAiHistory: (query: string) => void;
    clearAiQueryHistory: () => void;
    setAiHistoryIndex: (index: number) => void;

    aiConversations: Record<string, ChatMessage[]>;
    addToConversation: (connectionId: string, message: ChatMessage) => void;
    clearConversation: (connectionId: string) => void;

    aiDisplayHistory: Record<string, AiDisplayEntry[]>;
    addToDisplayHistory: (connectionId: string, entry: AiDisplayEntry) => void;
    clearDisplayHistory: (connectionId: string) => void;
    clearAllHistory: () => void;

    aiAttachedContext: AiContext | null;
    setAiAttachedContext: (context: AiContext | null) => void;

    submitAiQuery: (query: string, context: Record<string, any>, connectionId: string | null) => Promise<void>;

    checkOllama: () => Promise<boolean>;
    getOllamaModels: () => Promise<string[]>;
    getProviderModels: () => Promise<string[]>;
}

export const createAiSlice: StateCreator<AppStore, [], [], AiSlice> = (set, get) => ({
    aiLoading: false,
    aiResult: null,
    aiError: null,
    aiStreamingText: '',
    clearAiResult: () => set({ aiResult: null, aiError: null, aiStreamingText: '' }),

    aiQueryHistory: [],
    aiHistoryIndex: -1,
    pushAiHistory: (query) => {
        const filtered = get().aiQueryHistory.filter(q => q !== query);
        set({ aiQueryHistory: [query, ...filtered].slice(0, 50) });
    },
    clearAiQueryHistory: () => set({ aiQueryHistory: [], aiHistoryIndex: -1 }),
    setAiHistoryIndex: (index) => set({ aiHistoryIndex: index }),

    aiConversations: {},
    addToConversation: (connectionId, message) => set(state => {
        const existing = state.aiConversations[connectionId] || [];
        const newArr = [...existing, message];
        return {
            aiConversations: {
                ...state.aiConversations,
                [connectionId]: newArr.slice(-RETENTION_LIMIT),
            }
        };
    }),
    clearConversation: (connectionId) => set(state => {
        const next = { ...state.aiConversations };
        delete next[connectionId];
        return { aiConversations: next };
    }),

    aiDisplayHistory: {},
    addToDisplayHistory: (connectionId, entry) => set(state => {
        const existing = state.aiDisplayHistory[connectionId] || [];
        const newArr = [...existing, entry];
        return {
            aiDisplayHistory: {
                ...state.aiDisplayHistory,
                [connectionId]: newArr.slice(-RETENTION_LIMIT),
            }
        };
    }),
    clearDisplayHistory: (connectionId) => set(state => {
        const nextDisplay = { ...state.aiDisplayHistory };
        const nextConv = { ...state.aiConversations };
        delete nextDisplay[connectionId];
        delete nextConv[connectionId];
        return { aiDisplayHistory: nextDisplay, aiConversations: nextConv };
    }),
    clearAllHistory: () => set({ aiDisplayHistory: {}, aiConversations: {} }),

    aiAttachedContext: null,
    setAiAttachedContext: (context) => set({ aiAttachedContext: context }),

    submitAiQuery: async (query, context, connectionId) => {
        if (get().aiLoading) return;

        set({ aiLoading: true, aiResult: null, aiError: null, aiStreamingText: '' });
        const requestId = crypto.randomUUID();
        const cleanups: UnlistenFn[] = [];

        const currentHistory = connectionId ? (get().aiConversations[connectionId] || []) : [];
        const history: ChatMessage[] = currentHistory.slice(-HISTORY_TAIL_LENGTH);

        let resolveDone: ((result: AiResult | null) => void) | null = null;
        let rejectDone: ((err: Error) => void) | null = null;

        try {
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

            await translateAiStream({ query, context, requestId, history });
            const result = await donePromise;

            if (result) {
                const finalResult: AiResult = {
                    command: result.command,
                    explanation: result.explanation,
                    safety: result.safety || 'moderate',
                    answer: result.answer ?? undefined,
                };

                set({
                    aiResult: finalResult,
                    aiLoading: false,
                    aiStreamingText: '',
                });

                if (connectionId) {
                    get().addToConversation(connectionId, { role: 'user', content: query });
                    const aiContent = result.answer ? result.answer : `cmd:${result.command}`;
                    get().addToConversation(connectionId, { role: 'assistant', content: aiContent });
                }

                if (connectionId) {
                    const entry: AiDisplayEntry = {
                        id: requestId,
                        query,
                        result: finalResult,
                        error: null,
                        contextSnapshot: get().aiAttachedContext?.content ?? null,
                        timestamp: Date.now(),
                    };
                    get().addToDisplayHistory(connectionId, entry);
                }

                set({ aiAttachedContext: null });
            } else {
                // null result means the stream completed without a parseable result
                // (e.g. the model returned only streaming chunks with no final payload).
                // aiAttachedContext is intentionally preserved here so the user can
                // retry the query with the same context attached.
                set({ aiLoading: false, aiStreamingText: '' });
            }
        } catch (error: any) {
            const msg = error instanceof Error ? error.message : String(error);

            if (connectionId) {
                const contextSnapshot = get().aiAttachedContext?.content ?? null;
                const entry: AiDisplayEntry = {
                    id: requestId,
                    query,
                    result: null,
                    error: msg,
                    contextSnapshot,
                    timestamp: Date.now(),
                };
                get().addToDisplayHistory(connectionId, entry);
            }

            set({ aiError: msg, aiLoading: false, aiStreamingText: '', aiAttachedContext: null });
        } finally {
            for (const fn of cleanups) {
                fn();
            }
        }
    },

    checkOllama: async () => {
        try {
            return await checkOllamaAvailability();
        } catch {
            return false;
        }
    },

    getOllamaModels: async () => {
        try {
            return await fetchOllamaModels();
        } catch {
            return [];
        }
    },

    getProviderModels: async () => {
        try {
            return await fetchProviderModels();
        } catch {
            return [];
        }
    },
});
