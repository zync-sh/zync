import type { LightEditorFoldRange } from '../folding/types.js';
import type { LineModel } from './lineModel.js';
import { getLineText } from './lineModel.js';

export interface VisibleLineRow {
  kind: 'line';
  visibleRow: number;
  realLine: number;
}

export interface VisibleFoldRow {
  kind: 'fold';
  visibleRow: number;
  realLine: number;
  realEndLine: number;
  range: LightEditorFoldRange;
  label: string;
}

export type VisibleRow = VisibleLineRow | VisibleFoldRow;

export interface ProjectionModel {
  rows: VisibleRow[];
  visibleLineCount: number;
  realToVisibleLine: Map<number, number>;
}

function buildFoldLabel(lineModel: LineModel, range: LightEditorFoldRange) {
  const line = getLineText(lineModel, range.startLine).trim();
  if (range.kind === 'imports') return 'import ...';
  if (line.length === 0) return '{ ... }';

  const compact = line
    .replace(/\s+/g, ' ')
    .replace(/\{\s*$/, '')
    .trim();

  if (/^(pub\s+)?fn\b/.test(compact) || /\bfunction\b/.test(compact) || /=>\s*$/.test(compact)) {
    return `${compact} { ... }`;
  }

  if (range.kind === 'function') {
    return `${compact} { ... }`;
  }

  if (/(^|\s)(class|struct|enum|impl|trait|interface|mod)\b/.test(compact)) {
    return `${compact} { ... }`;
  }

  const hiddenLines = Math.max(1, range.endLine - range.startLine);
  return `${compact} ... ${hiddenLines === 1 ? '1 line' : `${hiddenLines} lines`}`;
}

export function buildProjection(
  lineModel: LineModel,
  foldRanges: LightEditorFoldRange[],
  collapsedLines: Set<number>,
): ProjectionModel {
  const rows: VisibleRow[] = [];
  const realToVisibleLine = new Map<number, number>();
  const collapsedByStart = new Map<number, LightEditorFoldRange>();

  for (const range of foldRanges) {
    if (collapsedLines.has(range.startLine)) {
      collapsedByStart.set(range.startLine, range);
    }
  }

  let visibleRow = 0;
  for (let realLine = 1; realLine <= lineModel.lineCount; realLine++) {
    const collapsedRange = collapsedByStart.get(realLine);
    if (collapsedRange) {
      const row: VisibleFoldRow = {
        kind: 'fold',
        visibleRow,
        realLine,
        realEndLine: collapsedRange.endLine,
        range: collapsedRange,
        label: buildFoldLabel(lineModel, collapsedRange),
      };
      rows.push(row);
      for (let hiddenLine = realLine; hiddenLine <= collapsedRange.endLine; hiddenLine++) {
        realToVisibleLine.set(hiddenLine, visibleRow);
      }
      visibleRow += 1;
      realLine = collapsedRange.endLine;
      continue;
    }

    const row: VisibleLineRow = {
      kind: 'line',
      visibleRow,
      realLine,
    };
    rows.push(row);
    realToVisibleLine.set(realLine, visibleRow);
    visibleRow += 1;
  }

  return {
    rows,
    visibleLineCount: rows.length,
    realToVisibleLine,
  };
}

export function realLineToVisibleRow(projection: ProjectionModel, realLine: number) {
  return projection.realToVisibleLine.get(realLine) ?? null;
}

export function visibleRowToRealLine(projection: ProjectionModel, visibleRow: number) {
  const row = projection.rows[visibleRow];
  return row ? row.realLine : null;
}

export function getProjectionWindow(
  projection: ProjectionModel,
  realStartLine: number,
  realEndLine: number,
) {
  const startVisibleRow = realLineToVisibleRow(projection, realStartLine) ?? 0;
  const endVisibleRow = (realLineToVisibleRow(projection, realEndLine) ?? projection.visibleLineCount - 1) + 1;
  return {
    startVisibleRow,
    endVisibleRow: Math.min(projection.visibleLineCount, endVisibleRow),
  };
}

export function getProjectionDisplayRows(
  projection: ProjectionModel,
  startVisibleRow: number,
  endVisibleRow: number,
) {
  return projection.rows.slice(startVisibleRow, endVisibleRow);
}

export function projectionToText(projection: ProjectionModel, lineModel: LineModel) {
  return projection.rows
    .map((row) => (row.kind === 'fold' ? row.label : getLineText(lineModel, row.realLine)))
    .join('\n');
}

export function getProjectionRows(
  projection: ProjectionModel,
  startVisibleRow: number,
  endVisibleRow: number,
) {
  return projection.rows.slice(startVisibleRow, endVisibleRow);
}
