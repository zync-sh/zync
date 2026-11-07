import { type ElementColors, parseElementColors } from './elementColors';
import { CUSTOM_THEME_ID, parseThemeDocument, type ThemeSettingsSnapshot } from './themeDocument';

export interface ThemeSelectionPatch {
    theme: string;
    accentColor: null;
    elementColors: ElementColors;
}

/**
 * Derive renderer colors for publication after the native selection is acknowledged.
 * A selection replaces global overrides while retaining the saved custom document and
 * independently owned tab styling. Unknown element formats must not be discarded.
 */
export function themeSelectionPatch(
    current: ThemeSettingsSnapshot,
    themeId: unknown,
): ThemeSelectionPatch {
    if (typeof themeId !== 'string') {
        throw new Error('Choose a valid theme.');
    }
    if (!parseElementColors(current.elementColors ?? undefined)) {
        throw new Error('Unsupported element color preferences; nothing was replaced.');
    }
    let elementColors: ElementColors = { version: 1, overrides: {} };
    if (themeId === CUSTOM_THEME_ID) {
        const customTheme = parseThemeDocument(current.customTheme);
        if (!customTheme) {
            throw new Error('Import a valid custom theme first.');
        }
        elementColors = customTheme.elements;
    }
    return { theme: themeId, accentColor: null, elementColors };
}
