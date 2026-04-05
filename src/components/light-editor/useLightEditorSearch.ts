import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  findMatches,
  replaceAllMatches,
  replaceMatch,
  type SearchMatch,
  type SearchOptions,
} from './search';

interface UseLightEditorSearchParams {
  content: string;
  utilityMode: 'find' | 'goto' | null;
  charWidth: number;
  scrollTop: number;
  scrollLeft: number;
  focusMatch: (index: number, matches: SearchMatch[]) => void;
  setContent: React.Dispatch<React.SetStateAction<string>>;
}

export function useLightEditorSearch({
  content,
  utilityMode,
  charWidth,
  scrollTop,
  scrollLeft,
  focusMatch,
  setContent,
}: UseLightEditorSearchParams) {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findWholeWord, setFindWholeWord] = useState(false);
  const [findUseRegex, setFindUseRegex] = useState(false);
  const [findMatchIndex, setFindMatchIndex] = useState(-1);
  const [findMatchesState, setFindMatchesState] = useState<SearchMatch[]>([]);

  const searchOptions = useMemo<SearchOptions>(
    () => ({
      caseSensitive: findCaseSensitive,
      wholeWord: findWholeWord,
      useRegex: findUseRegex,
    }),
    [findCaseSensitive, findUseRegex, findWholeWord],
  );

  useEffect(() => {
    if (utilityMode !== 'find' || !findText) {
      setFindMatchesState([]);
      setFindMatchIndex(-1);
      return;
    }

    const matches = findMatches(content, findText, searchOptions);
    setFindMatchesState(matches);
    setFindMatchIndex(matches.length > 0 ? 0 : -1);
    if (matches.length > 0) {
      focusMatch(0, matches);
    }
  }, [content, findText, focusMatch, searchOptions, utilityMode]);

  const lineStartOffsets = useMemo(() => {
    const offsets = [0];
    for (let index = 0; index < content.length; index++) {
      if (content[index] === '\n') offsets.push(index + 1);
    }
    return offsets;
  }, [content]);

  const searchHighlights = useMemo(() => {
    if (utilityMode !== 'find' || findMatchesState.length === 0) return [];

    return findMatchesState
      .map((match, index) => {
        const lineIndex = lineStartOffsets.findIndex((offset, i) => {
          const next = lineStartOffsets[i + 1] ?? Number.MAX_SAFE_INTEGER;
          return match.start >= offset && match.start < next;
        });
        if (lineIndex === -1) return null;

        const lineStart = lineStartOffsets[lineIndex];
        const nextLineStart = lineStartOffsets[lineIndex + 1] ?? content.length + 1;
        if (match.end > nextLineStart - 1) return null;

        return {
          key: `${match.start}-${match.end}`,
          top: 12 + lineIndex * 24 - scrollTop,
          left: 16 + (match.start - lineStart) * charWidth - scrollLeft,
          width: Math.max(charWidth, (match.end - match.start) * charWidth),
          active: index === findMatchIndex,
        };
      })
      .filter(Boolean) as Array<{ key: string; top: number; left: number; width: number; active: boolean }>;
  }, [charWidth, content.length, findMatchIndex, findMatchesState, lineStartOffsets, scrollLeft, scrollTop, utilityMode]);

  const handleFindNext = useCallback(() => {
    if (findMatchesState.length === 0) return;
    const nextIndex = (findMatchIndex + 1) % findMatchesState.length;
    setFindMatchIndex(nextIndex);
    focusMatch(nextIndex, findMatchesState);
  }, [findMatchIndex, findMatchesState, focusMatch]);

  const handleFindPrevious = useCallback(() => {
    if (findMatchesState.length === 0) return;
    const prevIndex = (findMatchIndex - 1 + findMatchesState.length) % findMatchesState.length;
    setFindMatchIndex(prevIndex);
    focusMatch(prevIndex, findMatchesState);
  }, [findMatchIndex, findMatchesState, focusMatch]);

  const handleReplaceOne = useCallback(() => {
    if (findMatchIndex < 0 || !findMatchesState[findMatchIndex]) return;
    setContent((prev) => replaceMatch(prev, findMatchesState[findMatchIndex], replaceText));
  }, [findMatchIndex, findMatchesState, replaceText, setContent]);

  const handleReplaceAll = useCallback(() => {
    if (findMatchesState.length === 0) return;
    setContent((prev) => replaceAllMatches(prev, findMatchesState, replaceText));
  }, [findMatchesState, replaceText, setContent]);

  const matchLabel = findText
    ? (findMatchesState.length > 0 ? `${findMatchIndex + 1}/${findMatchesState.length}` : '0/0')
    : '';

  const resetSearch = useCallback(() => {
    setFindText('');
    setReplaceText('');
    setFindCaseSensitive(false);
    setFindWholeWord(false);
    setFindUseRegex(false);
    setFindMatchIndex(-1);
    setFindMatchesState([]);
  }, []);

  return {
    findText,
    setFindText,
    replaceText,
    setReplaceText,
    searchOptions,
    findCaseSensitive,
    setFindCaseSensitive,
    findWholeWord,
    setFindWholeWord,
    findUseRegex,
    setFindUseRegex,
    findMatchIndex,
    findMatchesState,
    searchHighlights,
    matchLabel,
    handleFindNext,
    handleFindPrevious,
    handleReplaceOne,
    handleReplaceAll,
    resetSearch,
  };
}
