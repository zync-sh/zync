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

function parsePortStrict(token: string): number | null {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    return parsed;
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
        if (trailing === '') {
            // no-op
        } else if (trailing.startsWith(':')) {
            const possiblePort = parsePortStrict(trailing.slice(1));
            if (possiblePort === null) return null;
            parsedPort = possiblePort;
        } else {
            return null;
        }
    } else {
        const colonCount = (hostPort.match(/:/g) || []).length;
        if (colonCount <= 1) {
            const colonIndex = hostPort.lastIndexOf(':');
            if (colonIndex > -1 && colonIndex === hostPort.length - 1) {
                return null;
            } else if (colonIndex > -1 && colonIndex < hostPort.length - 1) {
                const possibleHost = hostPort.slice(0, colonIndex).trim();
                const possiblePort = parsePortStrict(hostPort.slice(colonIndex + 1));
                if (!possibleHost || possiblePort === null) return null;
                host = possibleHost;
                parsedPort = possiblePort;
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

    let finalPort = parsed.parsedPort;
    if (params.portOverride?.trim()) {
        const overridePort = parsePortStrict(params.portOverride);
        if (overridePort === null) return null;
        finalPort = overridePort;
    }

    return {
        id: params.id,
        name: (() => {
            const hostForName = parsed.host.includes(':') && !parsed.host.startsWith('[')
                ? `[${parsed.host}]`
                : parsed.host;
            return `${parsed.username}@${hostForName}${finalPort !== 22 ? `:${finalPort}` : ''}`;
        })(),
        host: parsed.host,
        username: parsed.username,
        port: finalPort,
        password: params.password === '' ? undefined : params.password,
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
