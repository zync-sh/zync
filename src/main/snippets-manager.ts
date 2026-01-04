import Store from 'electron-store';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  category?: string;
  tags?: string[];
}

interface SnippetStorage {
  snippets: Snippet[];
}

class SnippetManager {
  private store = new Store<SnippetStorage>({
    name: 'snippets',
    defaults: { snippets: [] },
  });

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
