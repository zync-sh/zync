/** Only the focused dialog owns Escape. Busy dialogs consume it without dismissing.
 * Portalled child dialogs, help tooltips and local Select/ColorPicker popups keep their own handlers.
 */
export function consumeDialogEscape(
    event: KeyboardEvent,
    dialog: HTMLElement | null,
    canDismiss: boolean,
    dismiss: () => void,
): boolean {
    if (!dialog || event.key !== 'Escape' || event.isComposing || event.defaultPrevented) {
        return false;
    }
    const root = dialog.ownerDocument;
    if (
        root.querySelector(
            '[data-zync-select-open="true"], [data-zync-color-picker-open="true"], [data-zync-shortcut-recording="true"], [data-zync-tooltip][data-state="delayed-open"], [data-zync-tooltip][data-state="instant-open"]',
        )
    ) {
        return false;
    }
    const target = event.target as Element | null;
    const focused = target && typeof target.closest === 'function' ? target : root.activeElement;
    if (focused?.closest('[role="dialog"], [role="alertdialog"]') !== dialog) {
        return false;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (canDismiss) {
        dismiss();
    }
    return true;
}
