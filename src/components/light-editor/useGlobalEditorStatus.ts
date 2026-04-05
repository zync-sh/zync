import { useEffect } from 'react';

export function useGlobalEditorStatus(statusText: string) {
  useEffect(() => {
    const element = document.getElementById('global-editor-status');
    if (element) element.textContent = statusText;

    return () => {
      const next = document.getElementById('global-editor-status');
      if (next) next.textContent = '';
    };
  }, [statusText]);
}
