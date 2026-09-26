export interface PluginBrokerWorker {
    postMessage(message: Record<string, unknown>): void;
}

export interface PluginCommandContribution {
    id: string;
    title: string;
    pluginId: string;
}

export interface PluginPanelContribution {
    id: string;
    title: string;
    html: string;
    pluginId: string;
    allowMultiple: boolean;
    legacyAccess: boolean;
}

export interface PluginPaneMessageTarget {
    panelId: string;
    post(message: unknown): void;
}

export interface PluginBrokerRuntime<W extends PluginBrokerWorker> {
    getRuntimeInstanceId(pluginId: string): string | undefined;
    isCurrentWorker(pluginId: string, worker: W): boolean;
    isCurrentRuntime(pluginId: string, runtimeInstanceId: string): boolean;
}

export interface PluginMessageBrokerDependencies<W extends PluginBrokerWorker> {
    runtime: PluginBrokerRuntime<W>;
    getPaneMessageTarget(pluginId: string, paneInstanceId: string): PluginPaneMessageTarget | undefined;
    registerCommand(command: PluginCommandContribution): void;
    registerPanel(panel: PluginPanelContribution): void;
    dispatch(type: string, detail: Record<string, unknown>): void;
}
