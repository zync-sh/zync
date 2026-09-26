export interface PluginFileHandle {
  handle: string;
  kind: 'file' | 'directory';
  access: 'read' | 'write';
  name: string;
}

export interface PluginFileEntry {
  name: string;
  kind: 'file' | 'directory' | 'unavailable';
  size?: number;
}

export interface PluginNetworkResponse {
  status: number;
  finalUrl: string;
  contentType?: string;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
}

export interface PluginNotification {
  type?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message?: string;
  body?: string;
  duration?: number;
  persist?: boolean;
  silent?: boolean;
  history?: boolean;
  channel?: 'auto' | 'toast' | 'inbox' | 'both';
  id?: string;
  actions?: Array<{ id: string; label: string; dismiss?: boolean }>;
}

export interface ZyncWorkerApi {
  on(event: 'ready', callback: () => void | Promise<void>): () => void;
  ui: {
    notify(options: PluginNotification): Promise<{ ok: true }>;
    confirm(options: { title: string; message: string; confirmLabel?: string; cancelLabel?: string }): Promise<boolean>;
    onNotifyAction(callback: (event: { actionId: string; notificationId?: string }) => void | Promise<unknown>): () => void;
  };
  commands: {
    register(id: string, title: string, handler: () => void | Promise<void>): Promise<{ ok: boolean }>;
  };
  panel: {
    register(id: string): Promise<{ id: string; title: string }>;
    onMessage(callback: (event: { paneInstanceId: string; message: unknown }) => void): () => void;
    postMessage(paneInstanceId: string, message: unknown): Promise<boolean>;
  };
  storage: {
    get(key: string): Promise<string | null>;
    keys(): Promise<string[]>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
  network: {
    fetch(url: string, options?: { accept?: string }): Promise<PluginNetworkResponse>;
  };
  filesystem: {
    pickFile(): Promise<PluginFileHandle | null>;
    pickDirectory(): Promise<PluginFileHandle | null>;
    pickWriteFile(): Promise<PluginFileHandle | null>;
    readText(handle: string, relativePath?: string): Promise<string>;
    writeText(handle: string, content: string): Promise<void>;
    list(handle: string, relativePath?: string): Promise<PluginFileEntry[]>;
  };
  sshFilesystem: {
    list(paneInstanceId: string, relativePath?: string): Promise<PluginFileEntry[]>;
    readText(paneInstanceId: string, relativePath: string): Promise<string>;
  };
  /** Requires ssh.command.execute. Runs with the SSH account's full authority on POSIX servers.
   * Arguments are quoted individually; no shell expansion. One command per pane, 20s, 2 MiB output.
   * Closing/rebinding a pane cancels the channel, not necessarily remote side effects. */
  sshCommand: {
    execute(paneInstanceId: string, request: { program: string; args: string[]; expectedConnectionToken?: string }): Promise<{
      stdout: string; stderr: string; exitCode: number; connectionToken: string;
    }>;
  };
}
