import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { EditorContentProvider } from './types.js';

interface UseEditorContentParams {
  provider: EditorContentProvider;
  resetKey: string;
}

export function useEditorContent({
  provider,
  resetKey,
}: UseEditorContentParams) {
  const initialContent = useMemo(() => provider.getInitialContent(), [provider, resetKey]);
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);
  const initialContentRef = useRef(initialContent);

  useEffect(() => {
    setContent(initialContent);
    initialContentRef.current = initialContent;
    setIsSaving(false);
  }, [initialContent, resetKey]);

  const hasChanges = content !== initialContentRef.current;

  const saveContent = useCallback(async () => {
    if (!hasChanges || isSaving) {
      return false;
    }

    setIsSaving(true);
    try {
      const result = await provider.saveContent(content);
      const nextContent = typeof result?.content === 'string' ? result.content : content;
      initialContentRef.current = nextContent;
      setContent(nextContent);
      return true;
    } catch (error) {
      console.error('[useEditorContent] save failed', error);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [content, hasChanges, isSaving, provider]);

  return {
    content,
    setContent,
    isSaving,
    hasChanges,
    saveContent,
  };
}
