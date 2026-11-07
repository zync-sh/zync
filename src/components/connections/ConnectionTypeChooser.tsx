import { Cable, ChevronRight, Files, FileText, Laptop, Monitor } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { CONTROL_INSET_FOCUS_CLASSES } from '../ui/controlStyles';

interface ConnectionTypeChooserProps {
    onSsh: () => void;
    onVnc: () => void;
    onSerial: () => void;
    onImportSsh: () => void;
    onImportFile: () => void;
}

/** Separate new connection types from imports while leaving each existing workflow with its owner. */
export function ConnectionTypeChooser({
    onSsh,
    onVnc,
    onSerial,
    onImportSsh,
    onImportFile,
}: ConnectionTypeChooserProps) {
    const connections = [
        { label: 'SSH connection', description: 'Remote shell', icon: Laptop, action: onSsh },
        { label: 'VNC connection', description: 'Remote desktop', icon: Monitor, action: onVnc },
        {
            label: 'Serial connection',
            description: 'Device console',
            icon: Cable,
            action: onSerial,
        },
    ];
    const imports = [
        {
            label: 'Import SSH config',
            description: 'Hosts from an SSH configuration',
            icon: FileText,
            action: onImportSsh,
        },
        {
            label: 'Import file',
            description: 'Zync, JSON or CSV export',
            icon: Files,
            action: onImportFile,
        },
    ];

    return (
        <div className="space-y-6 p-5 sm:p-6">
            <fieldset className="min-w-0">
                <legend className="text-sm font-semibold text-app-text">Connection type</legend>
                <p className="mt-1 text-xs text-app-muted">Choose how you want to connect.</p>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {connections.map(({ label, description, icon: Icon, action }, index) => (
                        <button
                            key={label}
                            type="button"
                            autoFocus={index === 0}
                            onClick={action}
                            className={cn(
                                'group flex min-w-0 items-center gap-3 rounded-lg border border-app-border bg-app-surface/25 p-4 text-left transition-colors hover:border-app-accent/60 hover:bg-app-surface/60 sm:flex-col sm:items-start',
                                CONTROL_INSET_FOCUS_CLASSES,
                            )}
                        >
                            <Icon
                                aria-hidden
                                className="h-5 w-5 shrink-0 text-app-accent"
                            />
                            <span className="min-w-0">
                                <span className="block text-[13px] font-semibold text-app-text">
                                    {label}
                                </span>
                                <span className="mt-1 block text-xs text-app-muted">
                                    {description}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            </fieldset>
            <fieldset className="min-w-0 border-t border-app-border/60 pt-5">
                <legend className="text-xs font-medium text-app-muted">Import connections</legend>
                <div className="mt-2 space-y-1">
                    {imports.map(({ label, description, icon: Icon, action }) => (
                        <Button
                            key={label}
                            type="button"
                            variant="ghost"
                            onClick={action}
                            className="h-auto w-full justify-start gap-3 px-3 py-2.5 text-left"
                        >
                            <Icon
                                aria-hidden
                                className="h-4 w-4 shrink-0 text-app-muted"
                            />
                            <span className="min-w-0 flex-1">
                                <span className="block text-xs font-medium text-app-text">
                                    {label}
                                </span>
                                <span className="mt-0.5 block text-[11px] font-normal text-app-muted">
                                    {description}
                                </span>
                            </span>
                            <ChevronRight
                                aria-hidden
                                className="h-3.5 w-3.5 shrink-0 text-app-muted"
                            />
                        </Button>
                    ))}
                </div>
            </fieldset>
        </div>
    );
}
