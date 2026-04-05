import type { LineModel } from './core/lineModel.js';
import { getOffsetPosition } from './core/lineModel.js';
import { findWordRange } from './text.js';

export interface LightEditorOccurrence {
  key: string;
  line: number;
  startColumn: number;
  endColumn: number;
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveOccurrenceTarget(content: string, selectionStart: number, selectionEnd: number) {
  if (selectionEnd > selectionStart) {
    const rawSelection = content.slice(selectionStart, selectionEnd);
    const leadingWhitespace = rawSelection.match(/^\s*/)?.[0].length ?? 0;
    const trailingWhitespace = rawSelection.match(/\s*$/)?.[0].length ?? 0;
    const trimmedStart = selectionStart + leadingWhitespace;
    const trimmedEnd = selectionEnd - trailingWhitespace;
    const selectedText = content.slice(trimmedStart, trimmedEnd);
    if (selectedText && !selectedText.includes('\n')) {
      return {
        text: selectedText,
        isExplicitSelection: true,
        selectionStart: trimmedStart,
        selectionEnd: trimmedEnd,
      };
    }
  }

  const wordRange = findWordRange(content, selectionStart);
  const word = wordRange.word;
  if (!word || word.length < 2) return null;

  return {
    text: word,
    isExplicitSelection: false,
    selectionStart: wordRange.start,
    selectionEnd: wordRange.end,
  };
}

export function findOccurrences(
  lineModel: LineModel,
  content: string,
  selectionStart: number,
  selectionEnd: number,
) {
  const target = resolveOccurrenceTarget(content, selectionStart, selectionEnd);
  if (!target) return [];

  const escaped = escapeRegex(target.text);
  const regex = new RegExp(`\\b${escaped}\\b`, 'g');
  const occurrences: LightEditorOccurrence[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (start === target.selectionStart && end === target.selectionEnd) {
      continue;
    }

    const position = getOffsetPosition(lineModel, start);
    occurrences.push({
      key: `${start}-${end}`,
      line: position.line,
      startColumn: position.column,
      endColumn: position.column + match[0].length,
    });
  }

  return occurrences;
}
