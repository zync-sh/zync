import { useMemo } from 'react';

import { buildProjection } from '../core/projection.js';
import type { LineModel } from '../core/lineModel.js';
import type { LightEditorFoldRange } from './types.js';

export function useLightEditorProjection(
  lineModel: LineModel,
  foldRanges: LightEditorFoldRange[],
  collapsedLines: Set<number>,
) {
  return useMemo(
    () => buildProjection(lineModel, foldRanges, collapsedLines),
    [collapsedLines, foldRanges, lineModel],
  );
}
