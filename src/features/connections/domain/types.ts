export type CoreTabView = 'dashboard' | 'files' | 'port-forwarding' | 'snippets' | 'terminal';
export type PluginTabView = `plugin:${string}`;
export type TabView = CoreTabView | PluginTabView;

export interface Connection {
    id: string;
    name: string;
    host: string;
    username: string;
    port: number;
    password?: string;
    privateKeyPath?: string;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    jumpServerId?: string;
    lastConnected?: number;
    icon?: string;
    folder?: string;
    theme?: string;
    tags?: string[];
    createdAt?: number;
    isFavorite?: boolean;
    pinnedFeatures?: string[];
    homePath?: string;
}

export interface Folder {
    name: string;
    tags?: string[];
}

export interface Tab {
    id: string;
    type: 'connection' | 'settings' | 'port-forwarding' | 'release-notes';
    title: string;
    connectionId?: string;
    view: TabView;
}
