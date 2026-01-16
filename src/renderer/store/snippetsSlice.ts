import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';

export interface Snippet {
    id: string;
    name: string;
    command: string;
    category?: string;
    connectionId?: string;
}

export interface SnippetsSlice {
    snippets: Snippet[];
    isLoadingSnippets: boolean;

    // Actions
    loadSnippets: () => Promise<void>;
    addSnippet: (snippet: Snippet) => Promise<void>;
    deleteSnippet: (id: string) => Promise<void>;
}

// @ts-ignore
const ipc = window.ipcRenderer;

export const createSnippetsSlice: StateCreator<AppStore, [], [], SnippetsSlice> = (set, get) => ({
    snippets: [],
    isLoadingSnippets: false,

    loadSnippets: async () => {
        set({ isLoadingSnippets: true });
        try {
            console.log('[Snippets] Loading...');
            const list = await ipc.invoke('snippets:getAll');
            set({ snippets: list || [], isLoadingSnippets: false });
        } catch (error) {
            console.error('Failed to load snippets:', error);
            set({ isLoadingSnippets: false });
        }
    },

    addSnippet: async (snippet) => {
        // Optimistic Update
        const oldSnippets = get().snippets;
        const exists = oldSnippets.some(s => s.id === snippet.id);

        let newSnippets;
        if (exists) {
            newSnippets = oldSnippets.map(s => s.id === snippet.id ? snippet : s);
        } else {
            newSnippets = [...oldSnippets, snippet];
        }

        set({ snippets: newSnippets });

        try {
            await ipc.invoke('snippets:save', snippet);
            // Optionally reload to confirm (or rely on optimistic)
            // await get().loadSnippets(); 
        } catch (error) {
            console.error('Failed to save snippet:', error);
            // Revert on error could be implemented here
            set({ snippets: oldSnippets });
            get().showToast('error', 'Failed to save snippet');
        }
    },

    deleteSnippet: async (id) => {
        const oldSnippets = get().snippets;
        const newSnippets = oldSnippets.filter(s => s.id !== id);
        set({ snippets: newSnippets });

        try {
            await ipc.invoke('snippets:delete', id);
        } catch (error) {
            console.error('Failed to delete snippet:', error);
            set({ snippets: oldSnippets }); // Revert
            get().showToast('error', 'Failed to delete snippet');
        }
    }
});
