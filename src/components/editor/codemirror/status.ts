export function formatCodeMirrorStatus(
  filename: string,
  line: number,
  column: number,
  languageLabel: string,
  isDirty: boolean,
) {
  return `${filename}  Ln ${line}, Col ${column}  UTF-8  ${languageLabel}${isDirty ? '  • Modified' : ''}`;
}
