import { defaultSettings, type AppSettings } from '../../../store/settingsSlice';
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
    const keybindings = settings.keybindings ?? defaultSettings.keybindings;
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
                        binding={keybindings.openNewConnection}
                        onChange={(val) => handleKeybindingChange({ openNewConnection: val })}
                    />
                    <KeybindingRow
                        label="Toggle Sidebar"
                        binding={keybindings.toggleSidebar}
                        onChange={(val) => handleKeybindingChange({ toggleSidebar: val })}
                    />
                    <KeybindingRow
                        label="Local Terminal"
                        binding={keybindings.newLocalTerminal}
                        onChange={(val) => handleKeybindingChange({ newLocalTerminal: val })}
                    />
                    <KeybindingRow
                        label="Settings"
                        binding={keybindings.toggleSettings}
                        onChange={(val) => handleKeybindingChange({ toggleSettings: val })}
                    />
                    <KeybindingRow
                        label="Command Palette"
                        binding={keybindings.commandPalette}
                        onChange={(val) => handleKeybindingChange({ commandPalette: val })}
                    />
                    <KeybindingRow
                        label="AI Command Bar"
                        binding={keybindings.aiCommandBar}
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
                                binding={keybindings.fmCopy}
                                onChange={(val) => handleKeybindingChange({ fmCopy: val })}
                            />
                            <KeybindingRow
                                label="Cut"
                                binding={keybindings.fmCut}
                                onChange={(val) => handleKeybindingChange({ fmCut: val })}
                            />
                            <KeybindingRow
                                label="Paste"
                                binding={keybindings.fmPaste}
                                onChange={(val) => handleKeybindingChange({ fmPaste: val })}
                            />
                        </div>
                        <div className="space-y-2">
                            <KeybindingRow
                                label="Select All"
                                binding={keybindings.fmSelectAll}
                                onChange={(val) => handleKeybindingChange({ fmSelectAll: val })}
                            />
                            <KeybindingRow
                                label="Rename"
                                binding={keybindings.fmRename}
                                onChange={(val) => handleKeybindingChange({ fmRename: val })}
                            />
                            <KeybindingRow
                                label="Delete"
                                binding={keybindings.fmDelete}
                                onChange={(val) => handleKeybindingChange({ fmDelete: val })}
                            />
                        </div>
                    </div>

                    <div className="h-px bg-[var(--color-app-border)]/50 my-2" />

                    <KeybindingRow
                        label="Edit Path"
                        binding={keybindings.fmEditPath}
                        onChange={(val) => handleKeybindingChange({ fmEditPath: val })}
                    />
                    <KeybindingRow
                        label="Search"
                        binding={keybindings.fmSearch}
                        onChange={(val) => handleKeybindingChange({ fmSearch: val })}
                    />

                    <div className="h-px bg-[var(--color-app-border)]/50 my-2" />

                    <KeybindingRow
                        label="Open Selection"
                        binding={keybindings.fmOpen}
                        onChange={(val) => handleKeybindingChange({ fmOpen: val })}
                    />
                    <KeybindingRow
                        label="Go Up"
                        binding={keybindings.fmUp}
                        onChange={(val) => handleKeybindingChange({ fmUp: val })}
                    />
                    <div className="grid grid-cols-2 gap-4">
                        <KeybindingRow
                            label="Go Back"
                            binding={keybindings.fmBack}
                            onChange={(val) => handleKeybindingChange({ fmBack: val })}
                        />
                        <KeybindingRow
                            label="Go Forward"
                            binding={keybindings.fmForward}
                            onChange={(val) => handleKeybindingChange({ fmForward: val })}
                        />
                    </div>
                </div>
            </Section>

            <Section title="Tabs">
                <div className="space-y-2">
                    <KeybindingRow
                        label="New Terminal (Current Host)"
                        binding={keybindings.newHostTerminal}
                        onChange={(val) => handleKeybindingChange({ newHostTerminal: val })}
                    />
                    <KeybindingRow
                        label="Close Tab"
                        binding={keybindings.closeTab}
                        onChange={(val) => handleKeybindingChange({ closeTab: val })}
                    />
                    <KeybindingRow
                        label="Next Tab"
                        binding={keybindings.switchTabNext}
                        onChange={(val) => handleKeybindingChange({ switchTabNext: val })}
                    />
                    <KeybindingRow
                        label="Previous Tab"
                        binding={keybindings.switchTabPrev}
                        onChange={(val) => handleKeybindingChange({ switchTabPrev: val })}
                    />
                    <div className="h-px bg-[var(--color-app-border)]/50 my-2" />
                    {SWITCH_TAB_DIGITS.map((n) => {
                        const key: SwitchTabKey = `switchTab${n}`;
                        return (
                            <KeybindingRow
                                key={n}
                                label={`Switch to Tab ${n}`}
                                binding={keybindings[key]}
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
                        binding={keybindings.termCopy}
                        onChange={(val) => handleKeybindingChange({ termCopy: val })}
                    />
                    <KeybindingRow
                        label="Paste"
                        binding={keybindings.termPaste}
                        onChange={(val) => handleKeybindingChange({ termPaste: val })}
                    />
                    <KeybindingRow
                        label="Find"
                        binding={keybindings.termFind}
                        onChange={(val) => handleKeybindingChange({ termFind: val })}
                    />
                    <KeybindingRow
                        label="Close Terminal Tab"
                        binding={keybindings.closeTerminalTab}
                        onChange={(val) => handleKeybindingChange({ closeTerminalTab: val })}
                    />
                </div>
            </Section>

            <Section title="View">
                <div className="space-y-2">
                    <KeybindingRow
                        label="Zoom In"
                        binding={keybindings.zoomIn}
                        onChange={(val) => handleKeybindingChange({ zoomIn: val })}
                    />
                    <KeybindingRow
                        label="Zoom Out"
                        binding={keybindings.zoomOut}
                        onChange={(val) => handleKeybindingChange({ zoomOut: val })}
                    />
                </div>
            </Section>
        </div>
    );
}
