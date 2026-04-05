import type { LineModel } from './lineModel.js';
import { getOffsetPosition } from './lineModel.js';

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const MATCH: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  ')': '(',
  ']': '[',
  '}': '{',
};

export interface BracketHighlight {
  key: string;
  line: number;
  column: number;
}

export function findMatchingBracket(content: string, offset: number): number | null {
  const ch = content[offset];
  if (!ch || (!OPEN.has(ch) && !CLOSE.has(ch))) return null;

  const isOpen = OPEN.has(ch);
  const target = MATCH[ch];
  let depth = 0;
  const step = isOpen ? 1 : -1;

  for (let index = offset; index >= 0 && index < content.length; index += step) {
    if (content[index] === ch) depth += 1;
    else if (content[index] === target) depth -= 1;
    if (depth === 0) return index;
  }

  return null;
}

export function getBracketHighlights(lineModel: LineModel, cursorOffset: number): BracketHighlight[] {
  const content = lineModel.content;

  for (const offset of [cursorOffset, cursorOffset - 1]) {
    if (offset < 0 || offset >= content.length) continue;
    const match = findMatchingBracket(content, offset);
    if (match !== null) {
      const start = getOffsetPosition(lineModel, offset);
      const end = getOffsetPosition(lineModel, match);
      return [
        { key: `bracket-${offset}`, line: start.line, column: start.column },
        { key: `bracket-${match}`, line: end.line, column: end.column },
      ];
    }
  }

  return [];
}
