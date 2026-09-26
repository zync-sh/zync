export interface ZyncPaneApi {
  pane: {
    postMessage(message: unknown): void;
    onMessage(callback: (message: unknown) => void): () => void;
  };
}
