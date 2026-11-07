import { Settings } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

import { cn } from '../../../lib/utils';
import { ContextMenu } from '../../ui/ContextMenu';
import { CONTROL_INSET_FOCUS_CLASSES } from '../../ui/controlStyles';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';

interface ProfileConnectionItemProps {
    kindLabel: string;
    name: string;
    secondary?: string;
    icon: ReactNode;
    compactMode: boolean;
    active: boolean;
    onOpen: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

/** Match host row presentation without inheriting SSH connection or file-drop behavior. */
export function ProfileConnectionItem({
    kindLabel,
    name,
    secondary,
    icon,
    compactMode,
    active,
    onOpen,
    onEdit,
    onDelete,
}: ProfileConnectionItemProps) {
    const openRef = useRef<HTMLButtonElement>(null);
    const [menu, setMenu] = useState<{ x: number; y: number; keyboard: boolean } | null>(null);

    /** Restore keyboard ownership on dismissal without overriding an intentional outside focus move. */
    function closeMenu() {
        if (menu?.keyboard) {
            const focused = document.activeElement;
            if (focused === document.body || focused?.closest('[role="menu"]')) {
                openRef.current?.focus({ preventScroll: true });
            }
        }
        setMenu(null);
    }

    /** Give dialogs a persistent opener before the transient menu is removed. */
    function runMenuAction(action: () => void) {
        openRef.current?.focus({ preventScroll: true });
        action();
    }

    return (
        <div
            className={cn(
                'group relative select-none rounded-lg transition-colors hover:bg-app-surface/40',
                active ? 'bg-app-surface/65 text-app-text' : 'text-app-muted hover:text-app-text',
            )}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenu({ x: event.clientX, y: event.clientY, keyboard: false });
            }}
        >
            {active && (
                <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-app-accent/80"
                />
            )}
            <button
                ref={openRef}
                type="button"
                aria-label={`Open ${kindLabel} profile ${name}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                    'flex w-full min-w-0 items-center rounded-lg text-left',
                    CONTROL_INSET_FOCUS_CLASSES,
                    compactMode ? 'gap-2 py-1.5 pl-2 pr-8' : 'gap-2.5 py-2 pl-2.5 pr-9',
                )}
                onClick={onOpen}
                onKeyDown={(event) => {
                    if (
                        event.key === 'ContextMenu' ||
                        event.code === 'ContextMenu' ||
                        (event.shiftKey && event.key === 'F10')
                    ) {
                        event.preventDefault();
                        event.stopPropagation();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setMenu({
                            x: bounds.left + bounds.width / 2,
                            y: bounds.top + bounds.height / 2,
                            keyboard: true,
                        });
                    }
                }}
            >
                <span
                    aria-hidden
                    className={cn(
                        'flex shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4',
                        compactMode ? 'h-7 w-7' : 'h-8 w-8',
                        active ? 'text-app-text' : 'text-app-muted group-hover:text-app-text',
                    )}
                >
                    {icon}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
                    <span className="flex min-h-5 min-w-0 items-center">
                        <span
                            data-zync-color-label
                            className={cn(
                                'min-w-0 truncate text-[13px] font-medium leading-tight',
                                active
                                    ? 'text-app-text'
                                    : 'text-app-text/90 group-hover:text-app-text',
                            )}
                        >
                            {name}
                        </span>
                    </span>
                    {secondary && (
                        <span className="min-w-0 truncate text-[11px] leading-tight text-app-muted/50 group-hover:text-app-muted/65">
                            {secondary}
                        </span>
                    )}
                </span>
            </button>
            <Tooltip content="Edit connection">
                <IconButton
                    label={`Edit ${kindLabel} profile ${name}`}
                    icon={<Settings size={12} />}
                    className={cn(
                        'absolute h-5 w-5 rounded-md p-1 text-app-muted opacity-0 transition-opacity hover:bg-app-surface hover:text-app-text group-hover:opacity-100 group-focus-within:opacity-100',
                        CONTROL_INSET_FOCUS_CLASSES,
                        compactMode ? 'right-2' : 'right-2.5',
                        secondary
                            ? compactMode
                                ? 'top-1.5'
                                : 'top-2'
                            : 'top-1/2 -translate-y-1/2',
                    )}
                    onClick={onEdit}
                />
            </Tooltip>
            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    autoFocus={menu.keyboard}
                    ariaLabel={`${kindLabel} profile actions`}
                    onClose={closeMenu}
                    items={[
                        {
                            label: 'Open profile',
                            /** Open the saved profile without starting its transport. */
                            action: () => runMenuAction(onOpen),
                        },
                        {
                            label: 'Edit profile',
                            /** Give the editor a stable row to return focus to. */
                            action: () => runMenuAction(onEdit),
                        },
                        { separator: true },
                        {
                            label: 'Delete profile',
                            variant: 'danger',
                            /** Confirm removal through the profile owner's existing dialog. */
                            action: () => runMenuAction(onDelete),
                        },
                    ]}
                />
            )}
        </div>
    );
}
