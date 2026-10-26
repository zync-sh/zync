export type AppAddGroup = 'create' | 'go';

export type AppAddKind =
    | 'new-host'
    | 'new-folder'
    | 'new-tunnel'
    | 'port-forwarding'
    | 'security-audits'
    | 'public-urls'
    | 'local'
    | 'host';

export type AppAddCloseSource = 'keyboard';

export type AppAddHost = {
    id: string;
    name: string;
    host: string;
    port?: number;
    username?: string;
    folder?: string;
    isFavorite?: boolean;
    icon?: string;
};

export type AppAddItem = {
    id: string;
    group: AppAddGroup;
    kind: AppAddKind;
    label: string;
    keywords: string[];
    hint?: string;
    /** Right-side muted text (host address only when privacy setting allows). */
    detail?: string;
    hostId?: string;
};

export type AppAddOpenState = {
    portForwardingOpen?: boolean;
    securityAuditsOpen?: boolean;
    publicUrlsOpen?: boolean;
    localOpen?: boolean;
    openHostIds?: ReadonlySet<string>;
};
