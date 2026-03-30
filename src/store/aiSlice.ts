import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppStore } from './useAppStore';

const HISTORY_TAIL_LENGTH = 100;
const RETENTION_LIMIT = 200; // Per-host display history limit

export interface AiResult {
    command: string;
    explanation: string;
    safety: 'safe' | 'moderate' | 'dangerous';
    answer?: string;
}

/** A single message in the AI conversation history (sent to backend as context). */
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

/** A single displayed chat entry in the AI Sidebar UI. */
export interface AiDisplayEntry {
    id: string;
    query: string;
    result: AiResult | null;
    error: string | null;
    /** Attached context snapshot (e.g., terminal output, file content) */
    contextSnapshot?: string | null;
    /** Timestamp for display */
    timestamp: number;
}

/** Active context attached to the current AI input */
export interface AiContext {
    type: 'terminal' | 'file';
    label: string;
    content: string;
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
    // --- Sidebar UI State ---
    isAiSidebarOpen: boolean;
    openAiSidebar: () => void;
    closeAiSidebar: () => void;
    toggleAiSidebar: () => void;

    // --- Streaming & Loading ---
    aiLoading: boolean;
    aiResult: AiResult | null;
    aiError: string | null;
    aiStreamingText: string;
    clearAiResult: () => void;

    // --- Query History (for up-arrow navigation) ---
    aiQueryHistory: string[];
    aiHistoryIndex: number;
    pushAiHistory: (query: string) => void;
    clearAiQueryHistory: () => void;
    setAiHistoryIndex: (index: number) => void;

    // --- Per-Host Conversation Context (sent to backend) ---
    /** Keyed by connectionId. Cleared only when user explicitly clears. */
    aiConversations: Record<string, ChatMessage[]>;
    addToConversation: (connectionId: string, message: ChatMessage) => void;
    clearConversation: (connectionId: string) => void;

    // --- Per-Host Display History (persisted sidebar chat) ---
    /** Keyed by connectionId. Only cleared by user action. */
    aiDisplayHistory: Record<string, AiDisplayEntry[]>;
    addToDisplayHistory: (connectionId: string, entry: AiDisplayEntry) => void;
    clearDisplayHistory: (connectionId: string) => void;
    /** Clear the entire display history for all connections */
    clearAllHistory: () => void;

    // --- Attached Context (context pill in the input area) ---
    aiAttachedContext: AiContext | null;
    setAiAttachedContext: (context: AiContext | null) => void;

    // --- Core Query Submission ---
    submitAiQuery: (query: string, context: Record<string, any>, connectionId: string | null) => Promise<void>;

    // --- Provider / Model Queries ---
    checkOllama: () => Promise<boolean>;
    getOllamaModels: () => Promise<string[]>;
    getProviderModels: () => Promise<string[]>;
}

export const createAiSlice: StateCreator<AppStore, [], [], AiSlice> = (set, get) => ({
    // --- Sidebar ---
    isAiSidebarOpen: false,
    openAiSidebar: () => set({ isAiSidebarOpen: true }),
    closeAiSidebar: () => set({ isAiSidebarOpen: false }),
    toggleAiSidebar: () => set(state => ({ isAiSidebarOpen: !state.isAiSidebarOpen })),

    // --- Streaming & Loading ---
    aiLoading: false,
    aiResult: null,
    aiError: null,
    aiStreamingText: '',
    clearAiResult: () => set({ aiResult: null, aiError: null, aiStreamingText: '' }),

    // --- Query History ---
    aiQueryHistory: [],
    aiHistoryIndex: -1,
    pushAiHistory: (query) => {
        const filtered = get().aiQueryHistory.filter(q => q !== query);
        set({ aiQueryHistory: [query, ...filtered].slice(0, 50) });
    },
    clearAiQueryHistory: () => set({ aiQueryHistory: [], aiHistoryIndex: -1 }),
    setAiHistoryIndex: (index) => set({ aiHistoryIndex: index }),

    // --- Per-Host Conversation Context ---
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

    // --- Per-Host Display History ---
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

    // --- Attached Context ---
    aiAttachedContext: null,
    setAiAttachedContext: (context) => set({ aiAttachedContext: context }),

    // --- Core Query Submission ---
    submitAiQuery: async (query, context, connectionId) => {
        // Guard against concurrent calls
        if (get().aiLoading) return;

        set({ aiLoading: true, aiResult: null, aiError: null, aiStreamingText: '' });
        const requestId = crypto.randomUUID();
        const cleanups: UnlistenFn[] = [];

        // Snapshot conversation history for this host
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

            await invoke('ai_translate_stream', { query, context, requestId, history });
            const result = await donePromise;

            if (result) {
                const finalResult: AiResult = {
                    command: result.command,
                    explanation: result.explanation,
                    safety: (result.safety as AiResult['safety']) || 'moderate',
                    answer: result.answer ?? undefined,
                };

                set({
                    aiResult: finalResult,
                    aiLoading: false,
                    aiStreamingText: '',
                });

                // Save turn to per-host conversation context
                if (connectionId) {
                    get().addToConversation(connectionId, { role: 'user', content: query });
                    const aiContent = result.answer ? result.answer : `cmd:${result.command}`;
                    get().addToConversation(connectionId, { role: 'assistant', content: aiContent });
                }

                // Archive to per-host display history
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

                // Clear attached context after submission
                set({ aiAttachedContext: null });
            } else {
                set({ aiLoading: false, aiStreamingText: '' });
            }
        } catch (error: any) {
            const msg = error instanceof Error ? error.message : String(error);
            
            // Archive error to per-host display history
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
