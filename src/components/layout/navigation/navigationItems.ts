import { Server, PanelsTopLeft, Link2, Network, Code, Search, Shield, Puzzle, type LucideIcon } from 'lucide-react';
import type { NavigationId } from '../../../features/workspace/domain/navigation';
import type { GlobalNavigationAction } from '../../../features/workspace/application/globalNavigation';
import { builtinWorkspaceViewLabel } from '../../../features/workspace/domain/registrations';
import { HardeningAuditIcon } from '../../icons/HardeningAuditIcon';

export interface NavigationEntry {
    id: NavigationId;
    label: string;
    detail?: string;
    /** Catalog command supplies the displayed hint, including user overrides. */
    shortcutId?: string;
    icon: LucideIcon;
    requiresWorkspace?: boolean;
    action: { kind: 'command'; commandId: string }
        | { kind: 'global'; id: GlobalNavigationAction }
        | { kind: 'plugin'; viewId: string };
}

/** App-wide destinations only. Host tools remain in the movable host tab bar. */
export const GLOBAL_NAVIGATION_ENTRIES: readonly NavigationEntry[] = [
    { id: 'hosts', label: 'Hosts', icon: Server, shortcutId: 'toggleSidebar', action: { kind: 'global', id: 'hosts' } },
    { id: 'workspace', label: 'Host workspace', icon: PanelsTopLeft, shortcutId: 'navigationWorkspace', requiresWorkspace: true, action: { kind: 'global', id: 'workspace' } },
    { id: 'public-urls', label: 'Public URLs', icon: Link2, shortcutId: 'navigationPublicUrls', action: { kind: 'global', id: 'public-urls' } },
    { id: 'tunnels', label: 'Port Forwarding', icon: Network, shortcutId: 'navigationTunnels', action: { kind: 'global', id: 'tunnels' } },
    { id: 'security-audits', label: builtinWorkspaceViewLabel('security'), icon: HardeningAuditIcon, shortcutId: 'navigationSecurityAudits', action: { kind: 'global', id: 'security-audits' } },
    { id: 'snippets', label: 'Snippets', icon: Code, shortcutId: 'navigationSnippets', action: { kind: 'global', id: 'snippets' } },
    { id: 'commands', label: 'Command Palette', icon: Search, action: { kind: 'command', commandId: 'commandPaletteMode' } },
    { id: 'vaults', label: 'Vaults', icon: Shield, shortcutId: 'navigationVaults', action: { kind: 'global', id: 'vaults' } },
    { id: 'plugins', label: 'Plugins', icon: Puzzle, shortcutId: 'navigationPlugins', action: { kind: 'global', id: 'plugins' } },
];
