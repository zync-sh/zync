import type { Connection } from './types.js';

/** Default for new installs: label-first lists (Termius-style), not endpoint-first. */
export const DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS = false;

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function isLikelyIpAddress(host: string): boolean {
    const trimmed = host.trim();
    if (!trimmed) return false;
    if (IPV4_RE.test(trimmed)) return true;
    // Basic IPv6 heuristic (contains multiple colons).
    return trimmed.includes(':') && /^[0-9a-f:.]+$/i.test(trimmed);
}

function formatUserHostPair(username: string, host: string): string {
    if (username && host) return `${username}@${host}`;
    return username || host;
}

export function formatConnectionEndpoint(conn: Pick<Connection, 'username' | 'host' | 'port'>): string {
    const host = conn.host?.trim() ?? '';
    const username = conn.username?.trim() ?? '';
    const portSuffix = conn.port !== 22 ? `:${conn.port}` : '';
    return `${formatUserHostPair(username, host)}${portSuffix}`;
}

/** Endpoint string for browse lists (no port suffix). */
export function formatConnectionListEndpoint(conn: Pick<Connection, 'username' | 'host'>): string {
    const host = conn.host?.trim() ?? '';
    const username = conn.username?.trim() ?? '';
    return formatUserHostPair(username, host);
}

/**
 * Primary line for browse surfaces (sidebar, welcome, palette, tabs).
 * Prefers custom name; endpoint is optional via settings.
 */
export function getConnectionPrimaryLabel(
    conn: Connection,
    showHostAddressesInLists: boolean = DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
): string {
    const name = conn.name?.trim();
    if (name) return name;

    const host = conn.host?.trim() ?? '';
    const username = conn.username?.trim() ?? '';

    if (showHostAddressesInLists) {
        if (host) return host;
        if (username) return username;
        return 'Untitled connection';
    }

    // Unnamed: keep hostnames that are not literal IPs (often already aliases).
    if (host && !isLikelyIpAddress(host)) {
        return host;
    }

    if (username) return username;

    return 'SSH connection';
}

/**
 * Secondary line for browse surfaces.
 * Privacy mode: compact `SSH, username`. Full mode: `user@host` (no port in lists).
 */
export function getConnectionSecondaryLabel(
    conn: Connection,
    showHostAddressesInLists: boolean = DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
): string {
    if (showHostAddressesInLists) {
        return formatConnectionListEndpoint(conn);
    }

    const username = conn.username?.trim();
    if (!username) return 'SSH';

    const primary = getConnectionPrimaryLabel(conn, false);
    if (primary === username) return 'SSH';

    return `SSH, ${username}`;
}

/** Search text for command palette / quick connect (always includes endpoint fields). */
export function getConnectionSearchText(conn: Connection): string {
    return [
        conn.name,
        conn.username,
        conn.host,
        conn.folder,
        ...(conn.tags ?? []),
        conn.port !== 22 ? String(conn.port) : '',
    ]
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .join(' ');
}

export function getConnectionBrowseAriaLabel(
    conn: Connection,
    showHostAddressesInLists: boolean = DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
): string {
    const primary = getConnectionPrimaryLabel(conn, showHostAddressesInLists);
    const secondary = getConnectionSecondaryLabel(conn, showHostAddressesInLists);
    return `Connection ${primary}, ${secondary}`;
}

export interface ConnectionDisplayLabels {
    primary: string;
    secondary: string;
    searchText: string;
    ariaLabel: string;
    endpoint: string;
}

export function getConnectionDisplayLabels(
    conn: Connection,
    showHostAddressesInLists: boolean = DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
): ConnectionDisplayLabels {
    return {
        primary: getConnectionPrimaryLabel(conn, showHostAddressesInLists),
        secondary: getConnectionSecondaryLabel(conn, showHostAddressesInLists),
        searchText: getConnectionSearchText(conn),
        ariaLabel: getConnectionBrowseAriaLabel(conn, showHostAddressesInLists),
        endpoint: formatConnectionEndpoint(conn),
    };
}