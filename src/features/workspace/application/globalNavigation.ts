export type GlobalSidebarSection = 'hosts' | 'workspace' | 'vaults' | 'plugins' | null;
export type GlobalNavigationAction = 'hosts' | 'workspace' | 'public-urls' | 'tunnels' | 'security-audits' | 'snippets' | 'vaults' | 'plugins';

interface GlobalNavigationPort {
    workspaceDocked?: boolean;
    showSection(section: GlobalSidebarSection): void;
    selectWorkspace(): boolean;
    openPublicUrls(): void;
    openForwarding(): void;
    openSecurityAudits(): void;
    openSnippets(): void;
}

/** Navigation selects existing surfaces only. Connection, execution and authorization stay with their owners. */
export function activateGlobalNavigation(action: GlobalNavigationAction, port: GlobalNavigationPort): boolean {
    switch (action) {
        case 'hosts': case 'vaults': case 'plugins': port.showSection(action); return true;
        case 'workspace':
            if (!port.selectWorkspace()) return false;
            port.showSection(port.workspaceDocked ? 'workspace' : null); return true;
        case 'public-urls': port.openPublicUrls(); port.showSection(null); return true;
        case 'tunnels': port.openForwarding(); port.showSection(null); return true;
        case 'security-audits': port.openSecurityAudits(); port.showSection(null); return true;
        case 'snippets': port.openSnippets(); port.showSection(null); return true;
        default: return false;
    }
}
