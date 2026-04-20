export interface QuickConnectParseResult {
    username: string;
    host: string;
    parsedPort: number;
}

export interface QuickConnectConnectionDraft {
    id: string;
    name: string;
    host: string;
    username: string;
    port: number;
    password?: string;
    privateKeyPath?: string;
    status: 'disconnected';
    createdAt: number;
}

export function parseQuickConnectInput(rawInput: string): QuickConnectParseResult | null {
    const trimmed = rawInput.trim();
    if (!trimmed) return null;

    let username = 'root';
    let hostPort = trimmed;

    if (hostPort.includes('@')) {
        const atIndex = hostPort.indexOf('@');
        const nextUsername = hostPort.slice(0, atIndex).trim();
        const nextHostPort = hostPort.slice(atIndex + 1).trim();
        if (!nextUsername || !nextHostPort) return null;
        username = nextUsername;
        hostPort = nextHostPort;
    }

    let host = hostPort;
    let parsedPort = 22;

    if (hostPort.startsWith('[')) {
        const bracketCloseIndex = hostPort.indexOf(']');
        if (bracketCloseIndex <= 1) return null;

        host = hostPort.slice(1, bracketCloseIndex).trim();
        const trailing = hostPort.slice(bracketCloseIndex + 1).trim();
        if (trailing.startsWith(':')) {
            const possiblePort = parseInt(trailing.slice(1).trim(), 10);
            if (Number.isInteger(possiblePort) && possiblePort > 0 && possiblePort <= 65535) {
                parsedPort = possiblePort;
            }
        }
    } else {
        const colonCount = (hostPort.match(/:/g) || []).length;
        if (colonCount <= 1) {
            const colonIndex = hostPort.lastIndexOf(':');
            if (colonIndex > -1 && colonIndex === hostPort.length - 1) {
                const possibleHost = hostPort.slice(0, colonIndex).trim();
                if (possibleHost) {
                    host = possibleHost;
                }
            } else if (colonIndex > -1 && colonIndex < hostPort.length - 1) {
                const possibleHost = hostPort.slice(0, colonIndex).trim();
                const possiblePort = parseInt(hostPort.slice(colonIndex + 1).trim(), 10);
                if (
                    possibleHost
                    && Number.isInteger(possiblePort)
                    && possiblePort > 0
                    && possiblePort <= 65535
                ) {
                    host = possibleHost;
                    parsedPort = possiblePort;
                }
            }
        }
    }

    host = host.trim();
    if (!host) return null;

    return { username, host, parsedPort };
}

export function buildQuickConnectDraft(params: {
    id: string;
    input: string;
    portOverride?: string;
    password?: string;
    privateKeyPath?: string;
    createdAt?: number;
}): QuickConnectConnectionDraft | null {
    const parsed = parseQuickConnectInput(params.input);
    if (!parsed) return null;

    const overridePort = params.portOverride?.trim()
        ? parseInt(params.portOverride.trim(), 10)
        : undefined;
    const finalPort = overridePort !== undefined
        && Number.isInteger(overridePort)
        && overridePort > 0
        && overridePort <= 65535
        ? overridePort
        : parsed.parsedPort;

    return {
        id: params.id,
        name: `${parsed.username}@${parsed.host}`,
        host: parsed.host,
        username: parsed.username,
        port: finalPort,
        password: params.password?.trim() || undefined,
        privateKeyPath: params.privateKeyPath?.trim() || undefined,
        status: 'disconnected',
        createdAt: params.createdAt ?? Date.now(),
    };
}

export function filterConnectionSuggestions<T extends { id: string; name?: string; host: string; username: string }>(
    input: string,
    connections: T[],
    limit = 5,
): T[] {
    const query = input.trim().toLowerCase();
    if (!query) return [];

    return connections
        .filter(connection =>
            connection.name?.toLowerCase().includes(query) ||
            connection.host.toLowerCase().includes(query) ||
            connection.username.toLowerCase().includes(query),
        )
        .slice(0, limit);
}
