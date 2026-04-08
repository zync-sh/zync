export interface CommentRange {
  from: number;
  to: number;
}

export interface CommentChange {
  from: number;
  to: number;
  insert: string;
}

function getIndent(lineText: string): string {
  return lineText.match(/^\s*/)?.[0] ?? '';
}

function getLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n' && i + 1 < text.length) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function getLineEnd(text: string, start: number): number {
  const nextBreak = text.indexOf('\n', start);
  return nextBreak === -1 ? text.length : nextBreak;
}

export function buildLineCommentChanges(
  text: string,
  ranges: CommentRange[],
  token: string,
): CommentChange[] {
  const lineStarts = getLineStarts(text);
  const lineNumbers = new Set<number>();

  for (const range of ranges) {
    for (let i = 0; i < lineStarts.length; i += 1) {
      const start = lineStarts[i];
      const end = getLineEnd(text, start);
      const overlaps =
        (range.from >= start && range.from <= end) ||
        (range.to >= start && range.to <= end) ||
        (range.from <= start && range.to >= end);
      if (overlaps) {
        lineNumbers.add(i);
      }
    }
  }

  const lines = Array.from(lineNumbers)
    .sort((a, b) => a - b)
    .map((index) => {
      const start = lineStarts[index];
      const end = getLineEnd(text, start);
      const lineText = text.slice(start, end);
      return { start, end, lineText };
    });

  const nonEmpty = lines.filter((line) => line.lineText.trim().length > 0);
  const allCommented = nonEmpty.length > 0 && nonEmpty.every((line) => {
    const indent = getIndent(line.lineText);
    return line.lineText.slice(indent.length).startsWith(token);
  });

  const changes: CommentChange[] = [];
  if (allCommented) {
    for (const line of lines) {
      const indent = getIndent(line.lineText);
      const offset = line.start + indent.length;
      if (line.lineText.slice(indent.length).startsWith(token)) {
        const withSpace = line.lineText.slice(indent.length + token.length).startsWith(' ');
        changes.push({
          from: offset,
          to: offset + token.length + (withSpace ? 1 : 0),
          insert: '',
        });
      }
    }
  } else {
    for (const line of lines) {
      if (line.lineText.trim().length === 0) continue;
      const indent = getIndent(line.lineText);
      const offset = line.start + indent.length;
      changes.push({
        from: offset,
        to: offset,
        insert: `${token} `,
      });
    }
  }

  return changes;
}
