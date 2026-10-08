import { CONTROL_BASE_CLASSES } from './controlStyles.js';

/** Shared popup appearance only. Each owner retains placement, portals and stacking. */
export const POPUP_SURFACE_CLASSES = 'bg-app-panel text-app-text border border-app-border rounded-[var(--zync-popup-radius)] shadow-[var(--zync-popup-shadow)]';

/** Dialog appearance is independent of dismissal policy, focus management and dragging. */
export const DIALOG_SURFACE_CLASSES = 'bg-app-panel text-app-text border border-app-border rounded-[var(--zync-dialog-radius)] shadow-[var(--zync-dialog-shadow)]';

/** Menu rows use inset focus rings to remain visible inside clipped popup surfaces. */
export const MENU_ITEM_CLASSES = `${CONTROL_BASE_CLASSES} flex items-center gap-2.5 min-h-[var(--zync-menu-item-height)] px-3 py-1.5 text-left focus-visible:ring-inset`;
