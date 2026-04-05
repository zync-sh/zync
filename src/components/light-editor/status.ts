export function formatGlobalEditorStatus(
  filename: string,
  cursorLine: number,
  cursorColumn: number,
  languageId: string,
) {
  return `${filename} Ln ${cursorLine}, Col ${cursorColumn} UTF-8 Tab: 2 {} ${languageId.toUpperCase()}`;
}
