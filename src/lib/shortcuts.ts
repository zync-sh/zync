/**
 * Helper to check if a KeyboardEvent matches a shortcut string like "Mod+Shift+T" or "Ctrl+B".
 * "Mod" translates to Command on macOS and Ctrl on Windows/Linux.
 */
export function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
    if (!shortcut) return false;
    const parts = shortcut.toLowerCase().split('+');
    let key = parts[parts.length - 1];
    if (key === 'plus') key = '+';

    // Check modifiers
    const hasCtrl = parts.includes('ctrl') || parts.includes('control');
    const hasShift = parts.includes('shift');
    const hasAlt = parts.includes('alt');
    const hasMeta = parts.includes('meta') || parts.includes('cmd') || parts.includes('command') || parts.includes('super');
    const hasMod = parts.includes('mod'); // Ctrl on Win/Linux, Meta on Mac

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const effectiveCtrl = hasCtrl || (hasMod && !isMac);
    const effectiveMeta = hasMeta || (hasMod && isMac);

    if (e.ctrlKey !== effectiveCtrl) return false;
    if (e.metaKey !== effectiveMeta) return false;
    if (e.altKey !== hasAlt) return false;
    if (e.shiftKey !== hasShift) return false;

    // Check key
    if (e.key.toLowerCase() === key) return true;
    if (key === 'tab' && e.key === 'Tab') return true;

    return false;
}
