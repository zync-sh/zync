import { LIGHT_EDITOR_LINE_HEIGHT, LIGHT_EDITOR_VERTICAL_PADDING } from './highlight.js';

export function getCompletionPanelTopOffset(
  utilityMode: 'find' | 'goto' | null,
  showReplace: boolean,
) {
  if (utilityMode === 'find') {
    return showReplace ? 116 : 68;
  }
  if (utilityMode === 'goto') {
    return 68;
  }
  return 16;
}

export function getActiveLineOverlay(
  cursorLine: number,
  startLine: number,
  endLine: number,
  scrollTop: number,
) {
  const visible = cursorLine >= startLine + 1 && cursorLine <= endLine;
  if (!visible) {
    return { visible: false, top: 0, height: LIGHT_EDITOR_LINE_HEIGHT };
  }

  return {
    visible: true,
    top: LIGHT_EDITOR_VERTICAL_PADDING + (cursorLine - 1) * LIGHT_EDITOR_LINE_HEIGHT - scrollTop,
    height: LIGHT_EDITOR_LINE_HEIGHT,
  };
}
