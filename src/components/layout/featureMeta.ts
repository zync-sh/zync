import { Braces, FolderOpen, LayoutDashboard, Waypoints, type LucideIcon } from 'lucide-react';

export type FeatureId = 'files' | 'port-forwarding' | 'snippets' | 'dashboard';

export interface FeatureMeta {
    icon: LucideIcon;
    label: string;
    keys: string[];
}

export const FEATURE_META: Record<FeatureId, FeatureMeta> = {
    'files': { icon: FolderOpen, label: 'Files', keys: ['mod', 'shift', 'f'] },
    'port-forwarding': { icon: Waypoints, label: 'Port Forwarding', keys: ['mod', 'shift', 'n'] },
    'snippets': { icon: Braces, label: 'Snippets', keys: ['mod', 'shift', 's'] },
    'dashboard': { icon: LayoutDashboard, label: 'Dashboard', keys: ['mod', 'shift', 'd'] },
};

let cachedIsMac: boolean | null = null;

function isMacPlatform(): boolean {
    if (cachedIsMac !== null) return cachedIsMac;
    if (typeof navigator === 'undefined') return false;
    const platform = navigator.platform || '';
    const userAgent = navigator.userAgent || '';
    cachedIsMac = /Mac|iPhone|iPad|iPod/i.test(`${platform} ${userAgent}`);
    return cachedIsMac;
}

export function formatFeatureShortcut(keys: string[]): string {
    const isMac = isMacPlatform();
    const separator = isMac ? '' : '+';
    return keys
        .map((key) => {
            const token = key.toLowerCase();
            if (token === 'mod') return isMac ? '⌘' : 'Ctrl';
            if (token === 'shift') return isMac ? '⇧' : 'Shift';
            if (token === 'alt' || token === 'option') return isMac ? '⌥' : 'Alt';
            if (token === 'ctrl' || token === 'control') return isMac ? '⌃' : 'Ctrl';
            return key.length === 1 ? key.toUpperCase() : key;
        })
        .join(separator);
}
