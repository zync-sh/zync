/** Isolated test bootstrap: existing slices capture this bridge at module initialization. */
export const ipcRenderer = window.ipcRenderer;
export const electronUtils = { platform: 'linux', getPathForFile: () => '' };
