import { parseConnectionString, parsePort } from './quick-connect/parsing';

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
    const parsed = parseConnectionString(rawInput);
    if (!parsed) return null;
    return { username: parsed.username, host: parsed.host, parsedPort: parsed.port };
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
        const overridePort = parsePort(params.portOverride);
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
    const normalizedLimit = Math.floor(Number(limit));
    if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) return [];
    const query = input.trim().toLowerCase();
    if (!query) return [];

    return connections
        .filter(connection =>
            connection.name?.toLowerCase().includes(query) ||
            connection.host.toLowerCase().includes(query) ||
            connection.username.toLowerCase().includes(query),
        )
        .slice(0, normalizedLimit);
}
