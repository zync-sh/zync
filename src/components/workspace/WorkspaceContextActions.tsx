import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { registrationForContent } from '../../features/workspace/application/viewRegistrationAdapters';
import { deriveWorkspaceContentInventory } from '../../features/workspace/domain/contentInventory';
import { sortContentPresentation } from '../../features/workspace/domain/contentPresentation';
import { parseWorkspaceDocking } from '../../features/workspace/domain/docking';
import {
    parseWorkspaceNavigation,
    resolveWorkspaceNavigation,
} from '../../features/workspace/domain/navigation';
import { resolveDisplayTitle } from '../../features/workspace/domain/presentation';
import { useAppStore } from '../../store/useAppStore';
import { workspaceTabsMenu } from '../layout/navigation/workspaceTabsMenu';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { DisplayAliasDialog } from './DisplayAliasDialog';
import { type WorkspaceActions, WorkspaceActionsContext } from './workspaceActionsContext';

const EMPTY_TERMINALS: readonly { id: string; title: string }[] = [];
export type ContentMenuItems = ReadonlyMap<string, readonly ContextMenuItem[]>;
const EMPTY_CONTENT_MENU_ITEMS: ContentMenuItems = new Map();

/** Scope live actions to the chrome that owns the corresponding retained content. */
export function useContentMenuItems() {
    const [itemsById, setItemsById] = useState(EMPTY_CONTENT_MENU_ITEMS);
    const register = useMemo<WorkspaceActions['registerContentMenuItems']>(
        () => (id, items) => {
            setItemsById((current) => new Map(current).set(id, items));
            return () =>
                setItemsById((current) => {
                    if (current.get(id) !== items) {
                        return current;
                    }
                    const next = new Map(current);
                    next.delete(id);
                    return next;
                });
        },
        [],
    );
    return [itemsById, register] as const;
}

/** Contextual chrome only. One owner per connection reuses the existing guarded
 * presentation actions and selection callbacks; no second content list or resource
 * lifecycle is introduced. Hidden instances remain recoverable from the strip and
 * the existing command ID (whose saved keybindings remain compatible).
 */
export function WorkspaceContextActions({
    connectionId,
    tabId,
    active,
    openRequest,
    onSetHidden,
    onSelectContent,
    onRevealAll,
    children,
}: {
    connectionId: string;
    tabId: string;
    active: boolean;
    openRequest: number;
    onSetHidden: (id: string, hidden: boolean) => boolean;
    onSelectContent: (id: string) => boolean;
    onRevealAll: () => boolean;
    children: ReactNode;
}) {
    const terminals = useAppStore((state) => state.terminals[connectionId] ?? EMPTY_TERMINALS);
    const groups = useAppStore((state) => state.paneLayouts[connectionId]);
    const presentation = useAppStore((state) => state.contentPresentation[connectionId]);
    const dockingRaw = useAppStore((state) => state.workspaceDocking);
    const docking = useMemo(() => parseWorkspaceDocking(dockingRaw), [dockingRaw]);
    const registry = useAppStore((state) => state.workspaceViewRegistry);
    const navigationRaw = useAppStore((state) => state.settings.workspaceNavigation);
    const settingsReady = useAppStore(
        (state) => !state.isLoadingSettings && !state.isReloadingSettings,
    );
    const ready = useAppStore(
        (state) => state.sessionLoaded && !state.isRestoring && !state.sessionPersistenceBlocked,
    );
    const inventory = useMemo(
        () =>
            sortContentPresentation(
                deriveWorkspaceContentInventory(terminals, groups),
                presentation,
            ),
        [terminals, groups, presentation],
    );
    const [menu, setMenu] = useState<{
        x: number;
        y: number;
        ids: readonly string[];
        extra: ContextMenuItem[];
        strip: boolean;
    } | null>(null);
    const [contentMenuItems, registerContentMenuItems] = useContentMenuItems();
    const [renaming, setRenaming] = useState<string | null>(null);
    const opener = useRef<HTMLElement | null>(null);
    const openerStrip = useRef<HTMLElement | null>(null);
    const recoverFocus = useRef(false);
    const returnFocus = useRef<{ id: string; source: Element | null } | null>(null);
    const lastRequest = useRef(openRequest);
    const permitted = () => active && useAppStore.getState().activeTabId === tabId;
    const run = (action: () => boolean | void) => {
        if (!permitted()) {
            return;
        }
        if (action() === false) {
            useAppStore
                .getState()
                .showToast(
                    'error',
                    'This pane action is unavailable now. Its content has been kept unchanged.',
                );
        }
    };
    const label = (id: string) => {
        const item = inventory.find((item) => item.id === id);
        return resolveDisplayTitle(
            item?.title ??
                (item && registrationForContent(registry, item.content)?.label) ??
                'Unavailable panel',
            presentation?.items[id]?.displayAlias,
        );
    };
    const rename = (id: string) => {
        if (permitted() && ready && inventory.some((item) => item.id === id)) {
            setRenaming(id);
        }
    };
    // Header and contextual recovery share one exact-identity action. Read fresh
    // guards so a stale button cannot accidentally unsplit a now-undocked group.
    const canReturnToTabs = (id: string) => {
        const state = useAppStore.getState();
        const parsed = parseWorkspaceDocking(state.workspaceDocking);
        return (
            permitted() &&
            state.sessionLoaded &&
            !state.isRestoring &&
            !state.sessionPersistenceBlocked &&
            parsed.ok &&
            !!parsed.value[connectionId]?.placements[id] &&
            !state.contentPresentation[connectionId]?.items[id]?.hidden &&
            deriveWorkspaceContentInventory(
                state.terminals[connectionId] ?? [],
                state.paneLayouts[connectionId],
            ).some((item) => item.id === id)
        );
    };
    const returnToTabs = (id: string) =>
        run(() => {
            const source = document.activeElement;
            if (
                !canReturnToTabs(id) ||
                !useAppStore.getState().releasePaneFromSplit(connectionId, { contentId: id })
            ) {
                return false;
            }
            returnFocus.current = { id, source };
            if (!onSelectContent(id)) {
                useAppStore
                    .getState()
                    .showToast(
                        'info',
                        'Pane returned to tabs, but could not be selected. Select it from the workspace.',
                    );
            }
            return true;
        });
    const recoveryItems: ContextMenuItem[] = inventory
        .filter((item) => presentation?.items[item.id]?.hidden)
        .map((item) => ({
            label: `Show ${label(item.id)}`,
            disabled: !ready,
            action: () =>
                run(() => {
                    if (!onSetHidden(item.id, false)) {
                        return false;
                    }
                    if (!onSelectContent(item.id)) {
                        useAppStore
                            .getState()
                            .showToast(
                                'info',
                                'Pane shown, but it could not be selected. Select it from the workspace.',
                            );
                    }
                    return true;
                }),
        }));
    const recovery: ContextMenuItem[] = [
        {
            label: 'Show hidden panes',
            disabled: !recoveryItems.length || !ready,
            children: recoveryItems.length
                ? recoveryItems
                : [{ label: 'No hidden panes', disabled: true, action: () => {} }],
        },
        ...(recoveryItems.length
            ? [{ label: 'Show all panes', disabled: !ready, action: () => run(onRevealAll) }]
            : []),
    ];
    const contentItems = (id: string): ContextMenuItem[] => {
        const item = inventory.find((item) => item.id === id);
        if (!item) {
            return [];
        }
        const store = useAppStore.getState();
        const pinned = presentation?.items[id]?.pinned === true;
        const hidden = presentation?.items[id]?.hidden === true;
        return [
            ...(contentMenuItems.get(id) ?? []),
            { label: 'Rename…', disabled: !ready, action: () => rename(id) },
            {
                label: pinned ? 'Unpin' : 'Pin',
                disabled: !ready,
                action: () => run(() => store.setContentPinned(connectionId, id, !pinned)),
            },
            {
                label: hidden ? 'Show' : 'Hide',
                disabled: !ready,
                action: () => run(() => onSetHidden(id, !hidden)),
            },
            ...(docking.ok && docking.value[connectionId]?.placements[id]
                ? [
                      {
                          label: 'Return to tabs',
                          disabled: !canReturnToTabs(id),
                          action: () => returnToTabs(id),
                      },
                  ]
                : []),
        ];
    };
    const open: WorkspaceActions['open'] = (event, ids = [], extra = []) => {
        if (!permitted()) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        returnFocus.current = null;
        opener.current =
            event.currentTarget.querySelector<HTMLElement>('[data-workspace-tab-trigger]') ??
            event.currentTarget;
        openerStrip.current =
            event.currentTarget.closest<HTMLElement>('[data-workspace-tab-strip]') ??
            document.querySelector<HTMLElement>(
                `[data-workspace-tab-strip][data-workspace-scope="${CSS.escape(connectionId)}"]`,
            );
        opener.current.focus();
        const rect = event.currentTarget.getBoundingClientRect();
        const pointer = 'clientX' in event && (event.type !== 'click' || event.detail !== 0);
        setMenu({
            x: pointer ? event.clientX : rect.left,
            y: pointer ? event.clientY : rect.bottom,
            ids,
            extra,
            strip: !!event.currentTarget.closest('[data-workspace-tab-strip]'),
        });
    };
    const closeMenu = () => {
        // Do not steal focus from a control clicked outside the menu.
        if (
            document.activeElement?.closest(
                '.context-menu-container, .context-menu-submenu-portal',
            ) &&
            opener.current?.isConnected
        ) {
            opener.current.focus();
        }
        recoverFocus.current = true;
        setMenu(null);
    };
    // One post-commit owner handles both a removed header action and menu dismissal.
    // Exact return identity wins over generic menu fallback; consume requests even
    // when focus moved elsewhere, so a later dismissal cannot replay them.
    useLayoutEffect(() => {
        if (menu) {
            return;
        }
        const returned = returnFocus.current;
        const recoverMenu = recoverFocus.current;
        returnFocus.current = null;
        recoverFocus.current = false;
        if (!permitted() || document.activeElement !== document.body) {
            return;
        }
        if (returned?.source?.isConnected === false) {
            const strip = document.querySelector<HTMLElement>(
                `[data-workspace-tab-strip][data-workspace-scope="${CSS.escape(connectionId)}"]`,
            );
            const tab = Array.from(
                strip?.querySelectorAll<HTMLElement>('[data-workspace-tab-contents]') ?? [],
            ).find((element) => {
                try {
                    return JSON.parse(element.dataset.workspaceTabContents ?? '[]').includes(
                        returned.id,
                    );
                } catch {
                    return false;
                }
            });
            const trigger = tab?.querySelector<HTMLElement>('[data-workspace-tab-trigger]');
            if (trigger) {
                trigger.focus({ preventScroll: true });
                return;
            }
        }
        if (!recoverMenu || opener.current?.isConnected) {
            return;
        }
        const strip = openerStrip.current;
        // Tab wrappers are not focusable; recover to a real selection control,
        // or the existing keyboard-reachable strip when all panes are hidden.
        if (strip?.isConnected) {
            (
                strip.querySelector<HTMLElement>(
                    '[data-workspace-tab-contents] [data-workspace-tab-trigger]',
                ) ?? strip
            ).focus({ preventScroll: true });
        }
    });
    useEffect(() => {
        if (!active) {
            setMenu(null);
            setRenaming(null);
        }
    }, [active]);
    useEffect(() => {
        if (renaming && !inventory.some((item) => item.id === renaming)) {
            setRenaming(null);
        }
        if (menu?.ids.some((id) => !inventory.some((item) => item.id === id))) {
            setMenu(null);
        }
    }, [inventory, menu, renaming]);
    useEffect(() => {
        if (lastRequest.current === openRequest) {
            return;
        }
        lastRequest.current = openRequest;
        if (!active) {
            return;
        }
        const strip = document.querySelector<HTMLElement>(
            `[data-workspace-tab-strip][data-workspace-scope="${CSS.escape(connectionId)}"]`,
        );
        if (!strip) {
            return;
        }
        opener.current = strip;
        strip.focus();
        openerStrip.current = strip;
        const rect = strip.getBoundingClientRect();
        setMenu({ x: rect.left, y: rect.bottom, ids: [], extra: [], strip: true });
    }, [openRequest, active, connectionId]);
    const editing = inventory.find((item) => item.id === renaming);
    const placement: ContextMenuItem[] = menu?.strip
        ? [
              {
                  label: 'Pane tab position',
                  children: workspaceTabsMenu(
                      resolveWorkspaceNavigation(navigationRaw).workspaceTabsPosition ?? 'default',
                      (value) => {
                          if (!permitted()) {
                              return;
                          }
                          const restore =
                              document.activeElement?.closest(
                                  '.context-menu-container, .context-menu-submenu-portal',
                              ) != null;
                          void useAppStore
                              .getState()
                              .updateWorkspaceNavigation({ type: 'workspace-tabs', value })
                              .then(() => {
                                  if (restore && permitted()) {
                                      requestAnimationFrame(() => {
                                          if (
                                              document.activeElement === document.body ||
                                              document.activeElement === opener.current
                                          ) {
                                              document
                                                  .querySelector<HTMLElement>(
                                                      `[data-workspace-strip-handle="${CSS.escape(tabId)}"]`,
                                                  )
                                                  ?.focus();
                                          }
                                      });
                                  }
                              })
                              .catch(() =>
                                  useAppStore
                                      .getState()
                                      .showToast(
                                          'error',
                                          'Could not move pane tabs. Please retry or reload settings.',
                                      ),
                              );
                      },
                      !settingsReady || !parseWorkspaceNavigation(navigationRaw),
                  ),
              },
          ]
        : [];
    const selectedItems: ContextMenuItem[] =
        menu?.ids.length === 1
            ? contentItems(menu.ids[0])
            : (menu?.ids ?? []).map((id) => ({ label: label(id), children: contentItems(id) }));
    return (
        <WorkspaceActionsContext.Provider
            value={{ rename, open, registerContentMenuItems, canReturnToTabs, returnToTabs }}
        >
            {children}
            {active && menu && menu.ids.every((id) => inventory.some((item) => item.id === id)) && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    autoFocus
                    onClose={closeMenu}
                    items={[
                        ...selectedItems,
                        ...menu.extra,
                        ...(selectedItems.length || menu.extra.length
                            ? [{ separator: true as const }]
                            : []),
                        ...placement,
                        ...recovery,
                    ]}
                />
            )}
            {active && editing && (
                <DisplayAliasDialog
                    key={editing.id}
                    isOpen
                    title="Rename pane"
                    defaultTitle={
                        editing.title ??
                        registrationForContent(registry, editing.content)?.label ??
                        'Unavailable panel'
                    }
                    displayAlias={presentation?.items[editing.id]?.displayAlias}
                    onClose={() => setRenaming(null)}
                    onSave={(alias) => {
                        if (
                            !permitted() ||
                            !useAppStore
                                .getState()
                                .setContentDisplayAlias(connectionId, editing.id, alias)
                        ) {
                            throw Error('Pane unavailable');
                        }
                    }}
                />
            )}
        </WorkspaceActionsContext.Provider>
    );
}
