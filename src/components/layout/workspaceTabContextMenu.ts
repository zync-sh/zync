import type { Tab } from '../../features/connections/domain/types';
import {
    isMainTabPinned,
    parseMainTabPresentation,
} from '../../features/workspace/domain/mainTabPresentation';
import type { ContextMenuItem } from '../ui/ContextMenu';

interface TabMenuActions {
    rename: () => void;
    appearance?: () => void;
    pin?: (pinned: boolean) => boolean;
    close: () => void;
    disconnect?: () => void;
    contentItems?: readonly ContextMenuItem[];
    onError?: () => void;
}

/** Tab chrome actions only; callers revalidate IDs and own saving and guarded close. */
export function workspaceTabContextMenu(tab: Tab, actions: TabMenuActions): ContextMenuItem[] {
    const editable = parseMainTabPresentation(tab.presentation).ok;
    const pinned = isMainTabPinned(tab);
    const apply = (action: () => boolean | void) => {
        try {
            if (action() !== false) {
                return;
            }
        } catch {
            /* Feature owner reports storage details. */
        }
        actions.onError?.();
    };
    return [
        { label: 'Rename…', shortcut: 'F2', action: actions.rename },
        {
            label: pinned ? 'Unpin tab' : 'Pin tab',
            disabled: !editable || !actions.pin,
            action: () => apply(() => actions.pin?.(!pinned)),
        },
        {
            label: 'Appearance…',
            disabled: !editable || !actions.appearance,
            action: () => actions.appearance?.(),
        },
        { separator: true },
        ...(actions.contentItems ?? []),
        ...(actions.disconnect ? [{ label: 'Disconnect', action: actions.disconnect }] : []),
        { label: 'Close tab', action: actions.close },
    ];
}
