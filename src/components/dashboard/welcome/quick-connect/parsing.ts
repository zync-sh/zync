/** Removes matching leading and trailing quotes from a tokenized value. */
export function stripSurroundingQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
        return value.slice(1, -1);
    }
    return value;
}

/** Parses and validates a TCP port from user input. */
export function parsePort(value: string): number | null {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const port = Number.parseInt(trimmed, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseHostAndPort(raw: string): { host: string; port: number } | null {
    const rest = raw.trim();
    if (!rest) return null;

    if (rest.startsWith('[') && rest.includes(']')) {
        const closeIdx = rest.indexOf(']');
        const host = rest.slice(1, closeIdx).trim();
        if (!host) return null;
        const suffix = rest.slice(closeIdx + 1).trim();
        if (!suffix) return { host, port: 22 };
        if (!suffix.startsWith(':')) return null;
        const parsedPort = parsePort(suffix.slice(1));
        if (parsedPort === null) return null;
        return { host, port: parsedPort };
    }

    if ((rest.match(/:/g) ?? []).length > 1) {
        return { host: rest, port: 22 };
    }

    if (rest.includes(':')) {
        const idx = rest.lastIndexOf(':');
        const host = rest.slice(0, idx).trim();
        const parsedPort = parsePort(rest.slice(idx + 1));
        if (!host || parsedPort === null) return null;
        return { host, port: parsedPort };
    }

    return { host: rest, port: 22 };
}

function tokenizeSSH(rest: string): string[] {
    return rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

const SSH_FLAGS_REQUIRING_VALUE = new Set([
    '-B', '-b', '-c', '-D', '-E', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
    '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w',
]);

function extractSSHHostToken(tokens: string[]): { hostToken: string | null; usernameFromFlag: string | null } {
    const cleaned: string[] = [];
    let usernameFromFlag: string | null = null;

    for (let i = 0; i < tokens.length; i += 1) {
        const token = stripSurroundingQuotes(tokens[i]);

        if (token === '-l') {
            usernameFromFlag = stripSurroundingQuotes(tokens[i + 1] ?? '').trim() || null;
            i += 1;
            continue;
        }
        if (token.startsWith('-l') && token.length > 2) {
            usernameFromFlag = token.slice(2).trim() || null;
            continue;
        }

        if (token === '-p' || token === '-i') {
            i += 1;
            continue;
        }
        if ((token.startsWith('-p') || token.startsWith('-i')) && token.length > 2) {
            continue;
        }

        if (SSH_FLAGS_REQUIRING_VALUE.has(token)) {
            i += 1;
            continue;
        }

        if (/^-[a-zA-Z]+$/.test(token)) continue;
        if (token.startsWith('-')) continue;
        cleaned.push(token);
    }

    return {
        hostToken: cleaned.find(token => token && !token.startsWith('-')) ?? null,
        usernameFromFlag,
    };
}

/** Parses shorthand connection input in the form `[user@]host[:port]`. */
export function parseConnectionString(raw: string): { username: string; host: string; port: number } | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    let username = 'root';
    let rest = trimmed;

    const userSplitIndex = rest.indexOf('@');
    if (userSplitIndex >= 0 && userSplitIndex !== rest.lastIndexOf('@')) {
        return null;
    }
    if (userSplitIndex >= 0) {
        username = rest.slice(0, userSplitIndex);
        rest = rest.slice(userSplitIndex + 1);
    }
    username = username.trim() || 'root';

    const parsed = parseHostAndPort(rest);
    if (!parsed) return null;
    const { host, port } = parsed;

    return host ? { username, host, port } : null;
}

/** Parses a full `ssh [-i key] [-p port] [user@]host` command string. */
export function parseSSHCommand(raw: string): { username: string; host: string; port: number; privateKeyPath?: string } | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('ssh ')) return null;

    const rest = trimmed.slice(4);
    const tokens = tokenizeSSH(rest);
    let explicitPort: number | undefined;
    let privateKeyPath: string | undefined;

    for (let i = 0; i < tokens.length; i += 1) {
        const token = stripSurroundingQuotes(tokens[i]);

        if (token === '-p') {
            const next = stripSurroundingQuotes(tokens[i + 1] ?? '');
            const parsed = parsePort(next);
            if (parsed === null) return null;
            explicitPort = parsed;
            i += 1;
            continue;
        }
        if (token.startsWith('-p') && token.length > 2) {
            const parsed = parsePort(token.slice(2));
            if (parsed === null) return null;
            explicitPort = parsed;
            continue;
        }

        if (token === '-i') {
            const next = stripSurroundingQuotes(tokens[i + 1] ?? '');
            if (next) privateKeyPath = next;
            i += 1;
            continue;
        }
        if (token.startsWith('-i') && token.length > 2) {
            const inlineValue = token.slice(2).trim();
            if (inlineValue) privateKeyPath = inlineValue;
        }
    }

    const { hostToken, usernameFromFlag } = extractSSHHostToken(tokens);
    if (!hostToken) return null;

    let username = 'root';
    let host = hostToken;
    const userSplitIndex = hostToken.indexOf('@');
    if (userSplitIndex >= 0 && userSplitIndex !== hostToken.lastIndexOf('@')) {
        return null;
    }
    if (userSplitIndex >= 0) {
        username = hostToken.slice(0, userSplitIndex);
        host = hostToken.slice(userSplitIndex + 1);
    } else if (usernameFromFlag) {
        username = usernameFromFlag;
    }
    username = username.trim() || 'root';

    const parsed = parseHostAndPort(host);
    if (!parsed) return null;
    // Use -p if specified, otherwise host-suffix port, otherwise default 22.
    const port = explicitPort ?? parsed.port ?? 22;
    return { username, host: parsed.host, port, privateKeyPath };
}
