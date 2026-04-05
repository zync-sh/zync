import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';

import {
  loadContextEngineIntelligence,
  type LightEditorCompletionItem,
  type LightEditorDefinitionEntry,
  type LightEditorHoverEntry,
} from './contextEngine';
import { findWordRange } from './text';

interface UseLightEditorCompletionParams {
  content: string;
  currentWord: string;
  languageId: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  updateCursorPosition: () => void;
}

export function useLightEditorCompletion({
  content,
  currentWord,
  languageId,
  textareaRef,
  setContent,
  updateCursorPosition,
}: UseLightEditorCompletionParams) {
  const [completionItems, setCompletionItems] = useState<LightEditorCompletionItem[]>([]);
  const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<LightEditorHoverEntry | null>(null);
  const [definitionInfo, setDefinitionInfo] = useState<LightEditorDefinitionEntry | null>(null);
  const [bundleVersion, setBundleVersion] = useState(0);
  const intelligenceRef = useRef<Awaited<ReturnType<typeof loadContextEngineIntelligence>> | null>(null);
  const deferredWord = useDeferredValue(currentWord);

  useEffect(() => {
    let cancelled = false;

    const loadBundle = async () => {
      const bundle = await loadContextEngineIntelligence(languageId);
      if (cancelled) return;
      intelligenceRef.current = bundle;
      setBundleVersion((version) => version + 1);
      if (!bundle) {
        setCompletionItems([]);
        setHoverInfo(null);
        setDefinitionInfo(null);
      }
    };

    intelligenceRef.current = null;
    void loadBundle();
    return () => {
      cancelled = true;
    };
  }, [languageId]);

  useEffect(() => {
    const bundle = intelligenceRef.current;
    if (!bundle) {
      setCompletionItems([]);
      setHoverInfo(null);
      setDefinitionInfo(null);
      return;
    }

    const key = deferredWord.toLowerCase();
    setHoverInfo(key ? bundle.hovers[key] ?? null : null);
    setDefinitionInfo(key ? bundle.definitions[key] ?? null : null);

    if (!key) {
      setCompletionItems([]);
      return;
    }

    const matches = bundle.completions
      .filter((item) => item.label.toLowerCase().startsWith(key))
      .slice(0, 8);
    setCompletionItems(matches);
  }, [bundleVersion, deferredWord]);

  useEffect(() => {
    if (completionItems.length === 0) {
      setSelectedCompletionIndex(0);
      return;
    }
    setSelectedCompletionIndex((prev) => Math.min(prev, completionItems.length - 1));
  }, [completionItems]);

  const clearCompletion = useCallback(() => {
    setCompletionItems([]);
    setSelectedCompletionIndex(0);
    setHoverInfo(null);
    setDefinitionInfo(null);
  }, []);

  const applyCompletion = useCallback((item: LightEditorCompletionItem) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const offset = textarea.selectionStart;
    const range = findWordRange(content, offset);
    const nextText = item.insertText ?? item.label;
    const nextContent = `${content.slice(0, range.start)}${nextText}${content.slice(range.end)}`;
    const nextOffset = range.start + nextText.length;

    setContent(nextContent);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextOffset, nextOffset);
      updateCursorPosition();
    });
  }, [content, setContent, textareaRef, updateCursorPosition]);

  return {
    completionItems,
    selectedCompletionIndex,
    setSelectedCompletionIndex,
    hoverInfo,
    definitionInfo,
    clearCompletion,
    applyCompletion,
  };
}
