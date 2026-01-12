import Store from 'electron-store';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  category?: string;
  tags?: string[];
  connectionId?: string;
}

interface SnippetStorage {
  snippets: Snippet[];
}

import { appConfigManager } from './app-config-manager';

class SnippetManager {
  private store!: Store<SnippetStorage>;

  constructor() {
    this.initStore();
  }

  private initStore() {
    const cwd = appConfigManager.getDataPath();
    this.store = new Store<SnippetStorage>({
      name: 'snippets',
      cwd: cwd,
      defaults: { snippets: [] },
    });
  }

  public reload() {
    this.initStore();
  }

  getAll(): Snippet[] {
    return this.store.get('snippets');
  }

  save(snippet: Snippet): Snippet {
    const snippets = this.store.get('snippets');
    const index = snippets.findIndex((s) => s.id === snippet.id);

    if (index >= 0) {
      snippets[index] = snippet;
    } else {
      snippets.push(snippet);
    }

    this.store.set('snippets', snippets);
    return snippet;
  }

  delete(id: string): void {
    const snippets = this.store.get('snippets');
    const newSnippets = snippets.filter((s) => s.id !== id);
    this.store.set('snippets', newSnippets);
  }
}

export const snippetManager = new SnippetManager();
