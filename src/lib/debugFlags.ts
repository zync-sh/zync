/**
 * Debug flags for development + field diagnostics.
 *
 * These are intentionally "soft" toggles (localStorage) so we can ask users
 * to enable logging without shipping UI switches.
 */

function readLocalStorageFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Enable with:
 *   localStorage.setItem('zync.debug.themePayload', '1')
 * Disable with:
 *   localStorage.removeItem('zync.debug.themePayload')
 */
export function isDebugThemePayloadEnabled(): boolean {
  return readLocalStorageFlag('zync.debug.themePayload');
}

