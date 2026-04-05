import type { EditorContentProvider } from './types.js';

export function createInlineEditorContentProvider(
  initialContent: string,
  onSave: (content: string) => Promise<void>,
): EditorContentProvider {
  return {
    getInitialContent() {
      return initialContent;
    },
    async saveContent(content) {
      await onSave(content);
      return { content };
    },
  };
}
