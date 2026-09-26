export interface PluginMessageEvent {
    source: unknown;
    data: unknown;
}

export interface PanelPluginCommandDeps {
    event: PluginMessageEvent;
    pluginId: string;
    connectionId: string | null;
    getRequester: () => unknown;
    isCurrent: (requester: unknown) => boolean;
    confirm: (pluginId: string, action: string, command: string) => Promise<boolean>;
    confirmUi: (options: PanelUiConfirmOptions) => Promise<boolean>;
    dispatch: (type: string, detail: Record<string, unknown>) => void;
    post: (requester: unknown, message: Record<string, unknown>) => void;
    loadSshInvoker: () => Promise<(connectionId: string, command: string) => Promise<unknown>>;
}

export interface PanelUiConfirmOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'primary' | 'danger';
}

export interface WorkerTerminalCommandDeps {
    type: string;
    payload: unknown;
    pluginId: string;
    requester: unknown;
    isCurrent: (requester: unknown) => boolean;
    confirm: (pluginId: string, action: string, command: string) => Promise<boolean>;
    getActiveConnectionId: () => string | null;
    dispatch: (type: string, detail: Record<string, unknown>) => void;
}

interface PluginDescriptor {
    path?: string;
    manifest: { id: string; type?: string };
}

interface WorkerResponseTarget {
    postMessage: (message: Record<string, unknown>) => void;
}

/** Host theme selection is available even when plugin Workers are stopped. */
export function getBuiltinThemeChoices(plugins: Array<PluginDescriptor & { manifest: { id: string; type?: string; name?: string; mode?: string } }>): Array<{ id: string; label: string; description?: string }> {
    const choices = new Map<string, { id: string; label: string; description?: string }>([
        ['system', { id: 'system', label: 'System Default' }],
        ['dark', { id: 'dark', label: 'Dark (Default)', description: 'dark' }],
    ]);
    for (const plugin of plugins) {
        if (!isTrustedBuiltinTheme(plugin) || plugin.manifest.id === 'com.zync.theme.manager') continue;
        const id = plugin.manifest.id.replace('com.zync.theme.', '');
        if (choices.has(id)) continue;
        choices.set(id, { id, label: (plugin.manifest.name || id).replace(/ Theme$/, ''), description: plugin.manifest.mode });
    }
    return [...choices.values()];
}

/** Only app-owned built-ins may provide host theme CSS. Filesystem plugins stay sandboxed. */
export function isTrustedBuiltinTheme(plugin: PluginDescriptor): boolean {
    return plugin.path?.startsWith('builtin://') === true && (
        plugin.manifest.type === 'theme'
        || plugin.manifest.id.startsWith('com.zync.theme.')
    );
}

/** Host-global third-party theme CSS is unsupported; editor providers style their iframe. */
export function filterUnsupportedHostThemes<P extends PluginDescriptor>(plugins: P[]): P[] {
    return plugins.filter((plugin) => isTrustedBuiltinTheme(plugin) || plugin.manifest.type === 'editor-provider' || (
        plugin.manifest.type !== 'theme'
        && !plugin.manifest.id.startsWith('com.zync.theme.')
    ));
}

/** Removes stale/hard-coded choices that have no enabled app-owned theme package. */
export function filterTrustedBuiltinThemeChoices<P extends PluginDescriptor, I extends Record<string, unknown>>(
    items: I[],
    plugins: P[],
): I[] {
    const allowed = new Set(['system', 'dark']);
    plugins.filter(isTrustedBuiltinTheme).forEach((plugin) => {
        if (plugin.manifest.id !== 'com.zync.theme.manager') {
            allowed.add(plugin.manifest.id.replace('com.zync.theme.', ''));
        }
    });
    return items.filter(item => item.kind === 'separator' || (
        typeof item.id === 'string' && allowed.has(item.id)
    ));
}

/** Posts only to the Worker generation that originated an asynchronous request. */
export function postCurrentWorkerResponse<T extends WorkerResponseTarget>(
    requester: T,
    isCurrent: (candidate: T) => boolean,
    type: string,
    payload: Record<string, unknown>,
): boolean {
    if (!isCurrent(requester)) return false;
    requester.postMessage({ type: `${type}:response`, payload });
    return true;
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object'
        ? value as Record<string, unknown>
        : null;
}

function sshResponse(requestId: unknown, fields: Record<string, unknown>): Record<string, unknown> {
    return {
        type: 'zync:ssh:exec:response',
        payload: { requestId, ...fields },
    };
}

/** Handles only panel commands that can create terminal or SSH side effects. */
export async function handlePanelPluginCommand(deps: PanelPluginCommandDeps): Promise<boolean> {
    const requester = deps.getRequester();
    if (!requester || deps.event.source !== requester || !deps.isCurrent(requester)) return false;

    const data = record(deps.event.data);
    const type = data?.type;
    if (typeof type !== 'string') return false;
    const payload = record(data?.payload);
    const current = () => deps.isCurrent(requester);

    if (type === 'zync:ui:confirm') {
        const options = payload ?? {};
        const confirmed = await deps.confirmUi({
            title: typeof options.title === 'string' ? options.title : 'Confirm',
            message: typeof options.message === 'string' ? options.message : 'Are you sure?',
            confirmText: typeof options.confirmText === 'string' ? options.confirmText : undefined,
            cancelText: typeof options.cancelText === 'string' ? options.cancelText : undefined,
            variant: options.variant === 'danger' ? 'danger' : options.variant === 'primary' ? 'primary' : undefined,
        });
        if (current()) {
            deps.post(requester, {
                type: 'zync:ui:confirm:response',
                payload: { requestId: options.requestId, confirmed },
            });
        }
        return true;
    }

    if (type === 'zync:terminal:send') {
        const text = payload?.text;
        if (typeof text !== 'string' || !text) return true;
        const confirmed = await deps.confirm(deps.pluginId, 'send terminal input', text);
        if (!current() || !confirmed) return true;
        deps.dispatch(type, { text, connectionId: deps.connectionId });
        return true;
    }

    if (type === 'zync:terminal:opentab') {
        if (!payload) return true;
        const command = payload.command;
        if (command !== undefined && typeof command !== 'string') return true;
        if (command) {
            const confirmed = await deps.confirm(deps.pluginId, 'open a terminal and run', command);
            if (!current() || !confirmed) return true;
        }
        if (current()) {
            deps.dispatch('ssh-ui:new-terminal-tab', { connectionId: deps.connectionId, command });
        }
        return true;
    }

    if (type !== 'zync:ssh:exec') return false;

    const requestId = payload?.requestId;
    if (!deps.connectionId) {
        deps.post(requester, sshResponse(requestId, { error: 'No active connection' }));
        return true;
    }

    const command = payload?.command;
    if (typeof command !== 'string') {
        deps.post(requester, sshResponse(requestId, {
            error: { code: 'SSH_EXEC_INVALID_COMMAND', message: 'SSH command must be a string.' },
        }));
        return true;
    }

    const confirmed = await deps.confirm(
        deps.pluginId,
        `run an SSH command on connection "${deps.connectionId}"`,
        command,
    );
    if (!current()) return true;
    if (!confirmed) {
        deps.post(requester, sshResponse(requestId, {
            error: { code: 'SSH_EXEC_DENIED', message: 'SSH command was not approved by the user.' },
        }));
        return true;
    }

    try {
        const invoke = await deps.loadSshInvoker();
        if (!current()) return true;
        const result = await invoke(deps.connectionId, command);
        if (!current()) return true;
        deps.post(requester, sshResponse(requestId, { result }));
    } catch (error) {
        if (current()) {
            deps.post(requester, sshResponse(requestId, { error: String(error) }));
        }
    }
    return true;
}

/** Handles the Worker's privileged terminal-input request. */
export async function handleWorkerTerminalCommand(deps: WorkerTerminalCommandDeps): Promise<boolean> {
    if (deps.type !== 'api:terminal:send' || !deps.isCurrent(deps.requester)) return false;
    const payload = record(deps.payload);
    const text = payload?.text;
    if (typeof text !== 'string' || !text) return true;

    const confirmed = await deps.confirm(deps.pluginId, 'send terminal input', text);
    if (!confirmed || !deps.isCurrent(deps.requester)) return true;
    deps.dispatch('zync:terminal:send', {
        text,
        connectionId: deps.getActiveConnectionId(),
    });
    return true;
}
