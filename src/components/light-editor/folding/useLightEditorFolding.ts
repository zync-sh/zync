import { useEffect, useMemo, useState } from 'react';

import type { LineModel } from '../core/lineModel.js';
import { getLineText } from '../core/lineModel.js';
import { getContextEngineKey } from '../contextEngine.js';
import type { LightEditorFoldRange } from './types.js';

interface FoldingRule {
  kind?: string;
  startPattern: string;
  endPattern?: string;
  description?: string;
  groupConsecutive?: boolean;
}

interface FoldingData {
  language: string;
  foldingRules: FoldingRule[];
}

const foldingCache = new Map<string, Promise<FoldingData | null>>();

async function loadFoldingData(languageId: string): Promise<FoldingData | null> {
  const key = getContextEngineKey(languageId);
  if (!key) return null;

  if (!foldingCache.has(key)) {
    foldingCache.set(
      key,
      (async () => {
        try {
          const mod = await import(/* @vite-ignore */ `@enjoys/context-engine/data/foldingRange/${key}.json`);
          return mod.default ?? mod;
        } catch {
          return null;
        }
      })(),
    );
  }

  return foldingCache.get(key)!;
}

function detectFallbackFoldRanges(lineModel: LineModel, languageId: string, seedId = 10_000): LightEditorFoldRange[] {
  const ranges: LightEditorFoldRange[] = [];
  const lang = languageId.toLowerCase();
  const braceLanguages = new Set(['javascript', 'typescript', 'go', 'rust', 'java', 'c', 'cpp', 'csharp']);
  const stack: Array<{ line: number; kind: string }> = [];
  let idCounter = seedId;

  let importStart = -1;
  let importEnd = -1;

  for (let lineNumber = 1; lineNumber <= lineModel.lineCount; lineNumber++) {
    const line = getLineText(lineModel, lineNumber);

    if (/^\s*(import|require|use|include|from)\b/.test(line)) {
      if (importStart < 0) importStart = lineNumber;
      importEnd = lineNumber;
    } else if (importStart > 0) {
      if (importEnd > importStart) {
        ranges.push({
          id: `fold-${idCounter++}`,
          startLine: importStart,
          endLine: importEnd,
          kind: 'imports',
          description: 'Import group folding',
        });
      }
      importStart = -1;
      importEnd = -1;
    }

    if (!braceLanguages.has(lang)) continue;

    let kind = 'region';
    if (/\bfn\b.*\{\s*$/.test(line) || /\bfunction\b.*\{\s*$/.test(line)) kind = 'function';
    else if (/\b(class|struct|enum|impl|trait|interface)\b.*\{\s*$/.test(line)) kind = 'region';

    for (const ch of line) {
      if (ch === '{') {
        stack.push({ line: lineNumber, kind });
      } else if (ch === '}') {
        const open = stack.pop();
        if (open && lineNumber > open.line) {
          ranges.push({
            id: `fold-${idCounter++}`,
            startLine: open.line,
            endLine: lineNumber,
            kind: open.kind,
          });
        }
      }
    }
  }

  if (importStart > 0 && importEnd > importStart) {
    ranges.push({
      id: `fold-${idCounter++}`,
      startLine: importStart,
      endLine: importEnd,
      kind: 'imports',
      description: 'Import group folding',
    });
  }

  return ranges;
}

export function getFoldRanges(lineModel: LineModel, foldingData: FoldingData | null, languageId = 'plaintext'): LightEditorFoldRange[] {
  const ranges: LightEditorFoldRange[] = [];
  let idCounter = 0;

  if (foldingData) {
    for (const rule of foldingData.foldingRules) {
      const startRegex = new RegExp(rule.startPattern);
      const endRegex = rule.endPattern ? new RegExp(rule.endPattern) : null;

      if (rule.groupConsecutive) {
        let startLine = -1;
        let lastLine = -1;
        for (let lineNumber = 1; lineNumber <= lineModel.lineCount; lineNumber++) {
          const line = getLineText(lineModel, lineNumber);
          if (startRegex.test(line)) {
            if (startLine < 0) startLine = lineNumber;
            lastLine = lineNumber;
          } else if (startLine > 0) {
            if (lastLine > startLine) {
              ranges.push({
                id: `fold-${idCounter++}`,
                startLine,
                endLine: lastLine,
                kind: rule.kind ?? 'region',
                description: rule.description,
              });
            }
            startLine = -1;
            lastLine = -1;
          }
        }
        if (startLine > 0 && lastLine > startLine) {
          ranges.push({
            id: `fold-${idCounter++}`,
            startLine,
            endLine: lastLine,
            kind: rule.kind ?? 'region',
            description: rule.description,
          });
        }
        continue;
      }

      const stack: number[] = [];
      for (let lineNumber = 1; lineNumber <= lineModel.lineCount; lineNumber++) {
        const line = getLineText(lineModel, lineNumber);
        if (startRegex.test(line)) {
          stack.push(lineNumber);
        }
        if (endRegex && endRegex.test(line) && stack.length > 0) {
          const startLine = stack.pop()!;
          if (lineNumber > startLine) {
            ranges.push({
              id: `fold-${idCounter++}`,
              startLine,
              endLine: lineNumber,
              kind: rule.kind ?? 'region',
              description: rule.description,
            });
          }
        }
      }
    }
  }

  ranges.push(...detectFallbackFoldRanges(lineModel, foldingData?.language ?? languageId, idCounter + 1));

  const deduped = new Map<string, LightEditorFoldRange>();
  for (const range of ranges) {
    const key = `${range.startLine}:${range.endLine}`;
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, range);
      continue;
    }
    if (current.kind === 'region' && range.kind !== 'region') {
      deduped.set(key, range);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

export function useLightEditorFolding(lineModel: LineModel, languageId: string) {
  const [foldingData, setFoldingData] = useState<FoldingData | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setFoldingData(null);
      const data = await loadFoldingData(languageId);
      if (!cancelled) setFoldingData(data);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [languageId]);

  return useMemo(() => getFoldRanges(lineModel, foldingData, languageId), [foldingData, languageId, lineModel]);
}
