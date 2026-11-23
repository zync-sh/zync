import { resolveHostIcon } from '../../features/connections/domain/hostAppearance';
import { cn } from '../../lib/utils';
import { OSIcon } from '../icons/OSIcon';
import { Select } from '../ui/Select';

const ICONS = [
    'Server',
    'Database',
    'Cloud',
    'Terminal',
    'Code',
    'Box',
    'Monitor',
    'Globe',
    'HardDrive',
    'Ubuntu',
    'Debian',
    'CentOS',
    'Arch',
    'Kali',
    'macOS',
    'Windows',
    'Linux',
    'AWS',
    'Jenkins',
    'MongoDB',
    'Nginx',
    'PostgreSQL',
    'MySql',
];

const THEMES = [
    { id: '', label: 'Default', color: 'bg-app-surface border-app-border' },
    { id: 'red', label: 'Pro', color: 'bg-red-500/20 border-red-500' },
    { id: 'blue', label: 'Dev', color: 'bg-blue-500/20 border-blue-500' },
    { id: 'green', label: 'Test', color: 'bg-emerald-500/20 border-emerald-500' },
    { id: 'orange', label: 'Stg', color: 'bg-orange-500/20 border-orange-500' },
    { id: 'purple', label: 'App', color: 'bg-purple-500/20 border-purple-500' },
];

const CUSTOM_ICON_PREFIX = 'icon:';
const AUTOMATIC = 'automatic';
/** Picker labels provide the accessible name for each option. */
function iconPreview(icon: string) {
    return (
        <span aria-hidden="true">
            <OSIcon
                icon={icon}
                className="h-4 w-4"
            />
        </span>
    );
}

const ICON_OPTIONS = ICONS.map((icon) => ({
    value: CUSTOM_ICON_PREFIX + icon.toLowerCase(),
    label: icon,
    icon: iconPreview(icon),
}));

interface HostAppearanceFieldsProps {
    name: string;
    icon?: string;
    detectedOs?: string;
    theme?: string;
    onIconChange: (icon: string | undefined) => void;
    onThemeChange: (theme: string) => void;
}

/** Preview the host appearance and let users restore OS-based icon selection. */
export function HostAppearanceFields({
    name,
    icon,
    detectedOs,
    theme,
    onIconChange,
    onThemeChange,
}: HostAppearanceFieldsProps) {
    const selected = icon ? CUSTOM_ICON_PREFIX + icon.toLowerCase() : AUTOMATIC;
    const options = [
        {
            value: AUTOMATIC,
            label: 'Automatic',
            icon: iconPreview(resolveHostIcon({ detectedOs })),
        },
        ...ICON_OPTIONS,
    ];
    if (icon && !options.some((option) => option.value === selected)) {
        options.push({ value: selected, label: icon, icon: iconPreview(icon) });
    }
    const detectedLabel =
        ICON_OPTIONS.find((option) => option.value === CUSTOM_ICON_PREFIX + detectedOs)?.label ??
        detectedOs;
    const color = THEMES.find((option) => option.id === theme) ?? THEMES[0];

    return (
        <div className="space-y-3 px-4 pb-4">
            <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-app-border bg-app-bg px-3 py-2">
                <span className="shrink-0">
                    {iconPreview(resolveHostIcon({ icon, detectedOs }))}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-app-text">{name}</span>
                {color.id && (
                    <span
                        title={color.label}
                        className={cn('size-2.5 shrink-0 rounded-full border', color.color)}
                    />
                )}
            </div>
            <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                <div className="min-w-0">
                    <Select
                        label="Icon"
                        ariaLabel="Icon"
                        value={selected}
                        options={options}
                        onChange={(value) =>
                            onIconChange(
                                value === AUTOMATIC
                                    ? undefined
                                    : value.slice(CUSTOM_ICON_PREFIX.length),
                            )
                        }
                        portal
                    />
                    {selected === AUTOMATIC && (
                        <p className="mt-1.5 text-xs text-app-muted">
                            {detectedLabel
                                ? 'Detected OS: ' + detectedLabel
                                : 'Detects the OS when you connect.'}
                        </p>
                    )}
                </div>
                <fieldset className="min-w-0">
                    <legend className="mb-1.5 text-xs font-medium text-app-muted">
                        Color label
                    </legend>
                    <div className="flex flex-wrap gap-1.5">
                        {THEMES.map((option) => (
                            <button
                                key={option.id}
                                type="button"
                                title={option.label}
                                aria-label={option.label}
                                aria-pressed={color.id === option.id}
                                onClick={() => onThemeChange(option.id)}
                                className={cn(
                                    'flex h-8 w-8 items-center justify-center rounded-md border hover:brightness-125',
                                    option.color,
                                    color.id === option.id && 'outline outline-1 outline-app-text',
                                )}
                            >
                                {color.id === option.id && (
                                    <span className="size-1.5 rounded-full bg-app-text" />
                                )}
                            </button>
                        ))}
                    </div>
                </fieldset>
            </div>
        </div>
    );
}
