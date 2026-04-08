export const EDITOR_OVERLAY_OPEN_ATTR = 'data-editor-overlay-open';

function readOverlayCount() {
  const raw = document.body.getAttribute(EDITOR_OVERLAY_OPEN_ATTR);
  const parsed = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function markEditorOverlayOpen() {
  const count = readOverlayCount() + 1;
  document.body.setAttribute(EDITOR_OVERLAY_OPEN_ATTR, String(count));
}

export function clearEditorOverlayOpen() {
  const next = Math.max(0, readOverlayCount() - 1);
  if (next === 0) {
    document.body.removeAttribute(EDITOR_OVERLAY_OPEN_ATTR);
    return;
  }
  document.body.setAttribute(EDITOR_OVERLAY_OPEN_ATTR, String(next));
}

export function isEditorOverlayOpen() {
  return readOverlayCount() > 0;
}
