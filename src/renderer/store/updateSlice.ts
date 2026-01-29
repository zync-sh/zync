import { StateCreator } from 'zustand';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'error';

export interface UpdateSlice {
    updateStatus: UpdateStatus;
    updateInfo: any;
    downloadProgress: number;
    setUpdateStatus: (status: UpdateStatus) => void;
    setUpdateInfo: (info: any) => void;
    setDownloadProgress: (progress: number) => void;
}

export const createUpdateSlice: StateCreator<UpdateSlice> = (set) => ({
    updateStatus: 'idle',
    updateInfo: null,
    downloadProgress: 0,
    setUpdateStatus: (status) => set({ updateStatus: status }),
    setUpdateInfo: (info) => set({ updateInfo: info }),
    setDownloadProgress: (progress) => set({ downloadProgress: progress }),
});
