import { LOCAL_TERMINAL_CONNECTION_ID } from '../../../lib/terminal/connectionIds';
import {
    DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
    formatConnectionListEndpoint,
    getConnectionPrimaryLabel,
} from '../../../features/connections/domain/connectionDisplay';
import type { Connection } from '../../../features/connections/domain/types';
import type { AppAddHost, AppAddItem, AppAddOpenState } from './types';
import { builtinWorkspaceViewLabel } from '../../../features/workspace/domain/registrations';

export const APP_ADD_GROUP_ORDER: AppAddItem['group'][] = ['create', 'go'];

export const APP_ADD_GROUP_LABEL: Record<AppAddItem['group'], string> = {
    create: 'Create',
    go: 'Go',
};

function uniqueKeywords(...parts: Array<string | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of parts) {
        const token = part?.trim().toLowerCase();
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
    }
    return out;
}

function sortHosts(hosts: readonly AppAddHost[]): AppAddHost[] {
    return [...hosts].sort((a, b) => {
        const fav = Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite));
        if (fav !== 0) return fav;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

function hostAsConnection(host: AppAddHost): Connection {
    return {
        id: host.id,
        name: host.name,
        host: host.host,
        username: host.username ?? '',
        port: host.port ?? 22,
        status: 'disconnected',
    };
}

export function buildAppAddItems(input: {
    hosts: readonly AppAddHost[];
    open?: AppAddOpenState;
    showHostAddressesInLists?: boolean;
}): AppAddItem[] {
    const open = input.open ?? {};
    const openHostIds = open.openHostIds ?? new Set<string>();
    const showHostAddresses = input.showHostAddressesInLists ?? DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS;

    const items: AppAddItem[] = [
        {
            id: 'create:host',
            group: 'create',
            kind: 'new-host',
            label: 'New Host',
            keywords: uniqueKeywords('new host', 'connection', 'ssh', 'add'),
        },
        {
            id: 'create:folder',
            group: 'create',
            kind: 'new-folder',
            label: 'New Folder',
            keywords: uniqueKeywords('new folder', 'group'),
        },
        {
            id: 'create:tunnel',
            group: 'create',
            kind: 'new-tunnel',
            label: 'New Tunnel',
            keywords: uniqueKeywords('new tunnel', 'port forward', 'forward'),
        },
        {
            id: 'go:port-forwarding',
            group: 'go',
            kind: 'port-forwarding',
            label: 'Port Forwarding',
            keywords: uniqueKeywords('port forwarding', 'tunnels', 'pf', 'global'),
            hint: open.portForwardingOpen ? 'Open' : undefined,
        },
        {
            id: 'go:public-urls',
            group: 'go',
            kind: 'public-urls',
            label: 'Public URLs',
            keywords: uniqueKeywords('public urls', 'share', 'https', 'beta', 'pu'),
            hint: open.publicUrlsOpen ? 'Open' : undefined,
        },
        {
            id: 'go:security-audits',
            group: 'go',
            kind: 'security-audits',
            label: builtinWorkspaceViewLabel('security'),
            keywords: uniqueKeywords('security hardening audit', 'reports', 'saved', 'global'),
            hint: open.securityAuditsOpen ? 'Open' : undefined,
        },
        {
            id: 'go:local',
            group: 'go',
            kind: 'local',
            label: 'Local',
            keywords: uniqueKeywords('local', 'terminal', LOCAL_TERMINAL_CONNECTION_ID),
            hint: open.localOpen ? 'Open' : undefined,
        },
    ];

    for (const host of sortHosts(input.hosts)) {
        const conn = hostAsConnection(host);
        const label = getConnectionPrimaryLabel(conn, showHostAddresses);
        items.push({
            id: `go:host:${host.id}`,
            group: 'go',
            kind: 'host',
            label,
            keywords: uniqueKeywords(host.name, host.host, host.username, host.folder, 'host'),
            hostId: host.id,
            hint: openHostIds.has(host.id) ? 'Open' : undefined,
            detail: showHostAddresses && formatConnectionListEndpoint(conn) !== label
                ? formatConnectionListEndpoint(conn)
                : undefined,
        });
    }

    return items;
}
