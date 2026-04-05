export interface LineModel {
  content: string;
  lineStarts: number[];
  lineCount: number;
}

export function createLineModel(content: string): LineModel {
  const lineStarts = [0];

  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return {
    content,
    lineStarts,
    lineCount: lineStarts.length,
  };
}

export function getLineStartOffset(lineModel: LineModel, lineNumber: number): number {
  if (lineNumber <= 1) return 0;
  return lineModel.lineStarts[Math.min(lineNumber - 1, lineModel.lineCount - 1)] ?? lineModel.content.length;
}

export function getLineEndOffset(lineModel: LineModel, lineNumber: number): number {
  const lineIndex = Math.min(Math.max(0, lineNumber - 1), lineModel.lineCount - 1);
  return lineModel.lineStarts[lineIndex + 1] ?? lineModel.content.length;
}

export function getLineSlice(lineModel: LineModel, startLine: number, endLine: number) {
  const safeStart = Math.max(0, Math.min(startLine, lineModel.lineCount - 1));
  const safeEnd = Math.max(safeStart, Math.min(endLine, lineModel.lineCount));
  const startOffset = lineModel.lineStarts[safeStart] ?? 0;
  const endOffset = lineModel.lineStarts[safeEnd] ?? lineModel.content.length;
  let visibleContent = lineModel.content.slice(startOffset, endOffset);
  if (visibleContent.endsWith('\n')) {
    visibleContent = visibleContent.slice(0, -1);
  }

  return {
    totalLines: lineModel.lineCount,
    visibleContent,
    visibleLineCount: safeEnd - safeStart,
  };
}

export function getLineText(lineModel: LineModel, lineNumber: number): string {
  const start = getLineStartOffset(lineModel, lineNumber);
  const end = getLineEndOffset(lineModel, lineNumber);
  const text = lineModel.content.slice(start, end);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export function getOffsetPosition(lineModel: LineModel, offset: number) {
  const clampedOffset = Math.max(0, Math.min(offset, lineModel.content.length));

  let low = 0;
  let high = lineModel.lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineModel.lineStarts[mid];
    const nextLineStart = lineModel.lineStarts[mid + 1] ?? Number.MAX_SAFE_INTEGER;

    if (clampedOffset < lineStart) {
      high = mid - 1;
    } else if (clampedOffset >= nextLineStart) {
      low = mid + 1;
    } else {
      return {
        line: mid + 1,
        column: clampedOffset - lineStart + 1,
      };
    }
  }

  return {
    line: 1,
    column: 1,
  };
}
