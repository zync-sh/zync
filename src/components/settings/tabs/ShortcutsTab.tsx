import type { AppSettings } from '../../../store/settingsSlice';
import { useAppStore } from '../../../store/useAppStore';
import { KeybindingRow } from '../common/KeybindingRow';
import { Section } from '../common/Section';

interface ShortcutsTabProps {
    settings: AppSettings;
    updateKeybindings: (updates: Partial<AppSettings['keybindings']>) => Promise<void>;
}

type SwitchTabDigit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type SwitchTabKey = `switchTab${SwitchTabDigit}`;
const SWITCH_TAB_DIGITS: readonly SwitchTabDigit[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function ShortcutsTab({ settings, updateKeybindings }: ShortcutsTabProps) {
    const showToast = useAppStore((state) => state.showToast);
    const handleKeybindingChange = (updates: Partial<AppSettings['keybindings']>) => {
        void updateKeybindings(updates).catch((error) => {
            console.error('Failed to update keybinding', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to save keybinding: ${message}`);
        });
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <Section title="Global Shortcuts">
                <div className="space-y-2">
                    <KeybindingRow
                        label="New Connection"
                        binding={settings.keybindings?.openNewConnection ?? 'Mod+N'}
                        onChange={(val) => handleKeybindingChange({ openNewConnection: val })}
                    />
                    <KeybindingRow
                        label="Toggle Sidebar"
                        binding={settings.keybindings?.toggleSidebar ?? 'Mod+B'}
                        onChange={(val) => handleKeybindingChange({ toggleSidebar: val })}
                    />
                    <KeybindingRow
                        label="Local Terminal"
                        binding={settings.keybindings?.newLocalTerminal ?? 'Mod+T'}
                        onChange={(val) => handleKeybindingChange({ newLocalTerminal: val })}
                    />
                    <KeybindingRow
                        label="Settings"
                        binding={settings.keybindings?.toggleSettings ?? 'Mod+,'}
                        onChange={(val) => handleKeybindingChange({ toggleSettings: val })}
                    />
                    <KeybindingRow
                        label="Command Palette"
                        binding={settings.keybindings?.commandPalette ?? 'Mod+P'}
                        onChange={(val) => handleKeybindingChange({ commandPalette: val })}
                    />
                    <KeybindingRow
                        label="AI Command Bar"
                        binding={settings.keybindings?.aiCommandBar ?? 'Mod+I'}
                        onChange={(val) => handleKeybindingChange({ aiCommandBar: val })}
                    />
                </div>
            </Section>

            <Section title="File Manager">
                <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <KeybindingRow
                                label="Copy"
                                binding={settings.keybindings?.fmCopy ?? 'Mod+C'}
                                onChange={(val) => handleKeybindingChange({ fmCopy: val })}
                            />
                            <KeybindingRow
                                label="Cut"
                                binding={settings.keybindings?.fmCut ?? 'Mod+X'}
                                onChange={(val) => handleKeybindingChange({ fmCut: val })}
                            />
                            <KeybindingRow
                                label="Paste"
                                binding={settings.keybindings?.fmPaste ?? 'Mod+V'}
                                onChange={(val) => handleKeybindingChange({ fmPaste: val })}
                            />
                        </div>
                        <div className="space-y-2">
                            <KeybindingRow
                                label="Select All"
                                binding={settings.keybindings?.fmSelectAll ?? 'Mod+A'}
                                onChange={(val) => handleKeybindingChange({ fmSelectAll: val })}
                            />
                            <KeybindingRow
                                label="Rename"
                                binding={settings.keybindings?.fmRename ?? 'F2'}
                                onChange={(val) => handleKeybindingChange({ fmRename: val })}
                            />
                            <KeybindingRow
                                label="Delete"
                                binding={settings.keybindings?.fmDelete ?? 'Delete'}
                                onChange={(val) => handleKeybindingChange({ fmDelete: val })}
                            />
                        </div>
                    </div>

                    <div className="h-px bg-[var(--color-app-border)]/50 my-2" />

                    <KeybindingRow
                        label="Edit Path"
                        binding={settings.keybindings?.fmEditPath ?? 'Mod+L'}
                        onChange={(val) => handleKeybindingChange({ fmEditPath: val })}
                    />
                    <KeybindingRow
                        label="Search"
                        binding={settings.keybindings?.fmSearch ?? 'Mod+F'}
                        onChange={(val) => handleKeybindingChange({ fmSearch: val })}
                    />

                    <div className="h-px bg-[var(--color-app-border)]/50 my-2" />

                    <KeybindingRow
                        label="Open Selection"
                        binding={settings.keybindings?.fmOpen ?? 'Enter'}
                        onChange={(val) => handleKeybindingChange({ fmOpen: val })}
                    />
                    <KeybindingRow
                        label="Go Up"
                        binding={settings.keybindings?.fmUp ?? 'Backspace'}
                        onChange={(val) => handleKeybindingChange({ fmUp: val })}
                    />
                    <div className="grid grid-cols-2 gap-4">
                        <KeybindingRow
                            label="Go Back"
                            binding={settings.keybindings?.fmBack ?? 'Alt+Left'}
                            onChange={(val) => handleKeybindingChange({ fmBack: val })}
                        />
                        <KeybindingRow
                            label="Go Forward"
                            binding={settings.keybindings?.fmForward ?? 'Alt+Right'}
                            onChange={(val) => handleKeybindingChange({ fmForward: val })}
                        />
                    </div>
                </div>
            </Section>

            <Section title="Tabs">
                <div className="space-y-2">
                    <KeybindingRow
                        label="New Terminal (Current Host)"
                        binding={settings.keybindings?.newHostTerminal ?? 'Mod+Shift+T'}
                        onChange={(val) => handleKeybindingChange({ newHostTerminal: val })}
                    />
                    <KeybindingRow
                        label="Close Tab"
                        binding={settings.keybindings?.closeTab ?? 'Mod+W'}
                        onChange={(val) => handleKeybindingChange({ closeTab: val })}
                    />
                    <KeybindingRow
                        label="Next Tab"
                        binding={settings.keybindings?.switchTabNext ?? 'Ctrl+Tab'}
                        onChange={(val) => handleKeybindingChange({ switchTabNext: val })}
                    />
                    <KeybindingRow
                        label="Previous Tab"
                        binding={settings.keybindings?.switchTabPrev ?? 'Ctrl+Shift+Tab'}
                        onChange={(val) => handleKeybindingChange({ switchTabPrev: val })}
                    />
                    <div className="h-px bg-[var(--color-app-border)]/50 my-2" />
                    {SWITCH_TAB_DIGITS.map((n) => {
                        const key: SwitchTabKey = `switchTab${n}`;
                        return (
                            <KeybindingRow
                                key={n}
                                label={`Switch to Tab ${n}`}
                                binding={settings.keybindings?.[key] ?? `Mod+${n}`}
                                onChange={(val) => handleKeybindingChange({ [key]: val })}
                            />
                        );
                    })}
                </div>
            </Section>

            <Section title="Terminal (Active)">
                <div className="space-y-2">
                    <KeybindingRow
                        label="Copy"
                        binding={settings.keybindings?.termCopy ?? 'Mod+Shift+C'}
                        onChange={(val) => handleKeybindingChange({ termCopy: val })}
                    />
                    <KeybindingRow
                        label="Paste"
                        binding={settings.keybindings?.termPaste ?? 'Mod+Shift+V'}
                        onChange={(val) => handleKeybindingChange({ termPaste: val })}
                    />
                    <KeybindingRow
                        label="Find"
                        binding={settings.keybindings?.termFind ?? 'Mod+F'}
                        onChange={(val) => handleKeybindingChange({ termFind: val })}
                    />
                    <KeybindingRow
                        label="Close Terminal Tab"
                        binding={settings.keybindings?.closeTerminalTab ?? 'Mod+Shift+W'}
                        onChange={(val) => handleKeybindingChange({ closeTerminalTab: val })}
                    />
                </div>
            </Section>

            <Section title="View">
                <div className="space-y-2">
                    <KeybindingRow
                        label="Zoom In"
                        binding={settings.keybindings?.zoomIn ?? 'Mod+='}
                        onChange={(val) => handleKeybindingChange({ zoomIn: val })}
                    />
                    <KeybindingRow
                        label="Zoom Out"
                        binding={settings.keybindings?.zoomOut ?? 'Mod+-'}
                        onChange={(val) => handleKeybindingChange({ zoomOut: val })}
                    />
                </div>
            </Section>
        </div>
    );
}
