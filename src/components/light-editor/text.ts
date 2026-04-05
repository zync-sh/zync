export function getLineStartOffset(content: string, lineNumber: number): number {
  if (lineNumber <= 1) return 0;
  let currentLine = 1;
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') {
      currentLine += 1;
      if (currentLine === lineNumber) {
        return index + 1;
      }
    }
  }
  return content.length;
}

export function findWordRange(content: string, offset: number) {
  const isWord = (char: string) => /[A-Za-z0-9_-]/.test(char);
  let start = offset;
  let end = offset;

  while (start > 0 && isWord(content[start - 1])) start -= 1;
  while (end < content.length && isWord(content[end])) end += 1;

  return { start, end, word: content.slice(start, end) };
}
