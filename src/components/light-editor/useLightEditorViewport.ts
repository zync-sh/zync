import { useEffect, useState } from 'react';

import { getHighlightViewport, LIGHT_EDITOR_LINE_HEIGHT } from './highlight';

interface LightEditorViewport {
  scrollTop: number;
  viewportHeight: number;
  visibleStartLine: number;
  visibleEndLine: number;
  visibleOffset: number;
  startLine: number;
  endLine: number;
}

export function useLightEditorViewport(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  lineCount: number,
): LightEditorViewport {
  const [viewport, setViewport] = useState<LightEditorViewport>({
    scrollTop: 0,
    viewportHeight: 0,
    visibleStartLine: 0,
    visibleEndLine: Math.min(lineCount, 40),
    visibleOffset: 0,
    startLine: 0,
    endLine: Math.min(lineCount, 40),
  });

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    let frame = 0;

    const updateViewport = () => {
      const nextScrollTop = textarea.scrollTop;
      const nextHeight = textarea.clientHeight;
      const visibleLines = Math.max(1, Math.ceil((nextHeight || LIGHT_EDITOR_LINE_HEIGHT) / LIGHT_EDITOR_LINE_HEIGHT));
      const visibleStartLine = Math.max(0, Math.floor(nextScrollTop / LIGHT_EDITOR_LINE_HEIGHT));
      const visibleEndLine = Math.min(lineCount, visibleStartLine + visibleLines);
      const visibleOffset = nextScrollTop - visibleStartLine * LIGHT_EDITOR_LINE_HEIGHT;
      const range = getHighlightViewport(nextScrollTop, nextHeight || LIGHT_EDITOR_LINE_HEIGHT, lineCount);

      setViewport((prev) => {
        if (
          prev.scrollTop === nextScrollTop &&
          prev.viewportHeight === nextHeight &&
          prev.visibleStartLine === visibleStartLine &&
          prev.visibleEndLine === visibleEndLine &&
          prev.visibleOffset === visibleOffset &&
          prev.startLine === range.startLine &&
          prev.endLine === range.endLine
        ) {
          return prev;
        }

        return {
          scrollTop: nextScrollTop,
          viewportHeight: nextHeight,
          visibleStartLine,
          visibleEndLine,
          visibleOffset,
          startLine: range.startLine,
          endLine: range.endLine,
        };
      });
    };

    const scheduleUpdate = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateViewport);
    };

    textarea.addEventListener('scroll', scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(textarea);
    updateViewport();

    return () => {
      textarea.removeEventListener('scroll', scheduleUpdate);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [lineCount, textareaRef]);

  return viewport;
}
