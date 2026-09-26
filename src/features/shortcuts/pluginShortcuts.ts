import { SHORTCUT_CATALOG } from './catalog';

// Payloads are untrusted requests, NOT evidence of user keyboard input.
// Only presentation/navigation actions are permitted. Never route persisted
// settings changes, tab closure, server features, or privileged operations here.
const PLUGIN_CHROME_COMMANDS = new Set([
    'toggleSettings', 'commandPalette', 'commandPaletteMode',
    'aiCommandBar', 'switchTabNext', 'switchTabPrev', 'focusSplitPane',
    ...Array.from({ length: 9 }, (_, index) => `switchTab${index + 1}`),
]);

/** Host-side authorization: matching a binding alone never grants permission. */
export function isPluginShortcutCommandAllowed(id: string): boolean {
    return PLUGIN_CHROME_COMMANDS.has(id);
}

export interface PluginShortcutBinding {
    id: string;
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    inField: boolean;
}

export function pluginShortcutBindings(overrides: Record<string, string> | null | undefined, isMac: boolean): PluginShortcutBinding[] {
    return SHORTCUT_CATALOG.filter(command => PLUGIN_CHROME_COMMANDS.has(command.id)).flatMap(command => {
        const primary = command.settingsKey ? overrides?.[command.settingsKey] || command.defaultKeys : command.defaultKeys;
        return [primary, ...(command.extraKeys || [])].filter(Boolean).map(chord => {
            const parts = chord.toLowerCase().split('+');
            const key = parts[parts.length - 1];
            return {
                id: command.id, key: key === 'plus' ? '+' : key,
                ctrlKey: parts.includes('ctrl') || parts.includes('control') || (parts.includes('mod') && !isMac),
                metaKey: parts.some(part => ['meta', 'cmd', 'command', 'super'].includes(part)) || (parts.includes('mod') && isMac),
                altKey: parts.includes('alt'), shiftKey: parts.includes('shift'),
                inField: command.when === 'always',
            };
        });
    });
}

/** Self-contained: this exact matcher also runs in the opaque-origin frame. */
export function matchPluginShortcut(value: unknown, bindings: PluginShortcutBinding[]): string | null {
    if (!value || typeof value !== 'object') return null;
    const event = value as Record<string, unknown>;
    if (typeof event.key !== 'string' || event.key.length > 32 || event.repeat !== false || event.isComposing !== false || typeof event.inField !== 'boolean') return null;
    if (['ctrlKey', 'metaKey', 'altKey', 'shiftKey'].some(key => typeof event[key] !== 'boolean')) return null;
    for (const binding of bindings) {
        if (event.inField && !binding.inField) continue;
        if (event.ctrlKey !== binding.ctrlKey || event.metaKey !== binding.metaKey || event.altKey !== binding.altKey || event.shiftKey !== binding.shiftKey) continue;
        const shiftDigits = ')!@#$%^&*(';
        const matchesDigit = binding.shiftKey && /^[0-9]$/.test(binding.key) && (event.code === `Digit${binding.key}` || event.key === shiftDigits[Number(binding.key)]);
        if (event.key.toLowerCase() === binding.key || matchesDigit) return binding.id;
    }
    return null;
}

export function pluginShortcutBridgeScript(): string {
    return `<script>
(() => {
    const match = ${matchPluginShortcut.toString()};
    let bindings = [];
    window.addEventListener('message', event => {
        if (event.source === window.parent && event.data?.type === 'zync:shortcuts:update') {
            bindings = Array.isArray(event.data.payload) ? event.data.payload : [];
        }
    });
    window.addEventListener('keydown', event => {
        if (!event.isTrusted || event.defaultPrevented || event.repeat || event.isComposing) return;
        const target = event.target;
        const key = {
            key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
            altKey: event.altKey, shiftKey: event.shiftKey, repeat: false, isComposing: false,
            inField: !!(target?.closest?.('input, textarea, select') || target?.isContentEditable),
        };
        if (!match(key, bindings)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.parent.postMessage({ type: 'zync:shortcut', payload: key }, '*');
    }, { capture: true });
})();
</script>`;
}
