import type { StateCreator } from 'zustand';

import type { AiMode } from '../types/common';

export interface AiUiSlice {
    isAiSidebarOpen: boolean;
    aiMode: AiMode;
    openAiSidebar: () => void;
    closeAiSidebar: () => void;
    toggleAiSidebar: () => void;
    setAiMode: (mode: AiMode) => void;
}

export const createAiUiSlice: StateCreator<AiUiSlice, [], [], AiUiSlice> = (set) => ({
    isAiSidebarOpen: false,
    aiMode: 'ask',
    openAiSidebar: () => set({ isAiSidebarOpen: true }),
    closeAiSidebar: () => set({ isAiSidebarOpen: false }),
    toggleAiSidebar: () => set((state) => ({ isAiSidebarOpen: !state.isAiSidebarOpen })),
    setAiMode: (mode) => set({ aiMode: mode }),
});
