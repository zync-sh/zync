import { useMemo } from 'react';

import type { LineModel } from '../core/lineModel.js';
import { getLineText } from '../core/lineModel.js';
import type { LightEditorDiagnostic } from './types.js';

function createDiagnostic(id: string, severity: LightEditorDiagnostic['severity'], line: number, column: number, message: string): LightEditorDiagnostic {
  return { id, severity, line, column, message };
}

function isJavaScriptLike(languageId: string) {
  return languageId === 'javascript' || languageId === 'typescript';
}

const DIRECTIVE_REGEX = /^(['"])\s*(?:use strict|use asm)\1\s*;?\s*$/;

export function getLightEditorDiagnostics(lineModel: LineModel, languageId: string): LightEditorDiagnostic[] {
  const diagnostics: LightEditorDiagnostic[] = [];
  const jsLike = isJavaScriptLike(languageId);

  for (let lineNumber = 1; lineNumber <= lineModel.lineCount; lineNumber++) {
    const line = getLineText(lineModel, lineNumber);
    const trimmed = line.trim();

    if (jsLike && /console\.log\(/.test(line)) {
      diagnostics.push(createDiagnostic(`console-log-${lineNumber}`, 'warning', lineNumber, line.indexOf('console.log') + 1, 'Remove console.log before committing.'));
    }

    if (/TODO\b/i.test(line)) {
      diagnostics.push(createDiagnostic(`todo-${lineNumber}`, 'warning', lineNumber, line.toUpperCase().indexOf('TODO') + 1, 'Outstanding TODO left in file.'));
    }

    if (jsLike && /^\s*["'`].*["'`]\s*;?\s*$/.test(trimmed) && !DIRECTIVE_REGEX.test(trimmed)) {
      diagnostics.push(createDiagnostic(`stray-string-${lineNumber}`, 'warning', lineNumber, 1, 'Standalone string literal has no effect.'));
    }
  }

  return diagnostics;
}

export function useLightEditorDiagnostics(lineModel: LineModel, languageId: string) {
  return useMemo(() => getLightEditorDiagnostics(lineModel, languageId), [languageId, lineModel]);
}
