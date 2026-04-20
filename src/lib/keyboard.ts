export function isMatch(e: KeyboardEvent, binding: string): boolean {
    if (!binding) return false;

    const parts = binding.split('+').map(p => p.trim().toLowerCase());

    // Check modifiers
    const needsCtrl = parts.includes('ctrl') || parts.includes('control');
    const needsShift = parts.includes('shift');
    const needsAlt = parts.includes('alt');
    const needsMeta = parts.includes('meta') || parts.includes('super') || parts.includes('win') || parts.includes('cmd') || parts.includes('command');

    // Handle 'Mod' - Generic modifier
    const needsMod = parts.includes('mod');
    const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    // Calculate effective requirements
    // If 'Mod' is used, it maps to Meta on Mac, and Ctrl on others.
    // We add this to the explicit requirements.
    const requiredCtrl = needsCtrl || (needsMod && !isMac);
    const requiredMeta = needsMeta || (needsMod && isMac);

    if (e.ctrlKey !== requiredCtrl) return false;
    if (e.shiftKey !== needsShift) return false;
    if (e.altKey !== needsAlt) return false;
    if (e.metaKey !== requiredMeta) return false;

    // Identify the main key (non-modifier)
    const modifiers = ['ctrl', 'control', 'shift', 'alt', 'meta', 'super', 'win', 'cmd', 'command', 'mod'];
    const mainKeys = parts.filter(p => !modifiers.includes(p));

    // If there is no main key (e.g. just "Ctrl"), we can't really match a keydown event for an action usually, 
    // unless the event is just the modifier, but actions usually trigger on the main key.
    // However, if the binding is valid, there should be 1 main key.
    if (mainKeys.length !== 1) return false;

    const targetKey = mainKeys[0];
    let pressedKey = e.key.toLowerCase();

    // Map common aliases to standard KeyboardEvent.key values (lowercase)
    const aliases: Record<string, string> = {
        'left': 'arrowleft',
        'right': 'arrowright',
        'up': 'arrowup',
        'down': 'arrowdown',
        'esc': 'escape',
        'return': 'enter',
        'space': ' ',
        'plus': '+',
    };

    const normalizedTarget = aliases[targetKey] || targetKey;
    const normalizedPressed = aliases[pressedKey] || pressedKey;

    return normalizedTarget === normalizedPressed;
}
