/** Backend check for local shell child processes (remote always returns false). */
export async function isTerminalSessionProcessBusy(termId: string): Promise<boolean> {
  if (typeof window === 'undefined' || !window.ipcRenderer?.invoke) {
    return false;
  }

  try {
    const busy = await window.ipcRenderer.invoke('terminal:has-active-processes', { termId });
    return Boolean(busy);
  } catch (error) {
    console.warn(`[terminal] process busy check failed for ${termId}`, error);
    return true;
  }
}