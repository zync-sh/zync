export interface EditorSaveResult {
  content?: string;
}

export interface EditorContentProvider {
  getInitialContent(): string;
  saveContent(content: string): Promise<EditorSaveResult | void>;
}
