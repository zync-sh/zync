import { contextBridge, ipcRenderer, webUtils } from 'electron';

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args;
    return ipcRenderer.on(channel, listener);
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, listener] = args;
    return ipcRenderer.off(channel, listener);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  },
});

contextBridge.exposeInMainWorld('electronUtils', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});
