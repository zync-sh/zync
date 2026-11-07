import {
    Braces,
    Cable,
    FolderOpen,
    LayoutDashboard,
    type LucideIcon,
    Monitor,
    Waypoints,
} from 'lucide-react';

import { builtinWorkspaceViewLabel } from '../../features/workspace/domain/registrations';
import type { SplitFeatureId } from '../../lib/paneLayout/types';
import { HardeningAuditIcon } from '../icons/HardeningAuditIcon';

export type FeatureId = SplitFeatureId;

export interface WorkspaceFeatureTab {
    id: string;
    featureId: FeatureId;
    /** Stable content identity; Files uses this as its independent listing key. */
    instanceId: string;
}

export interface FeatureMeta {
    icon: LucideIcon;
    label: string;
    keys: string[];
}

export const FEATURE_META: Record<FeatureId, FeatureMeta> = {
    serial: { icon: Cable, label: builtinWorkspaceViewLabel('serial'), keys: [] },
    vnc: { icon: Monitor, label: builtinWorkspaceViewLabel('vnc'), keys: [] },
    security: { icon: HardeningAuditIcon, label: builtinWorkspaceViewLabel('security'), keys: [] },
    files: {
        icon: FolderOpen,
        label: builtinWorkspaceViewLabel('files'),
        keys: ['mod', 'shift', 'f'],
    },
    'port-forwarding': {
        icon: Waypoints,
        label: builtinWorkspaceViewLabel('port-forwarding'),
        keys: ['mod', 'shift', 'n'],
    },
    snippets: {
        icon: Braces,
        label: builtinWorkspaceViewLabel('snippets'),
        keys: ['mod', 'shift', 's'],
    },
    dashboard: {
        icon: LayoutDashboard,
        label: builtinWorkspaceViewLabel('dashboard'),
        keys: ['mod', 'shift', 'd'],
    },
};

let cachedIsMac: boolean | null = null;

function isMacPlatform(): boolean {
    if (cachedIsMac !== null) {
        return cachedIsMac;
    }
    if (typeof navigator === 'undefined') {
        return false;
    }
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
            if (token === 'mod') {
                return isMac ? '⌘' : 'Ctrl';
            }
            if (token === 'shift') {
                return isMac ? '⇧' : 'Shift';
            }
            if (token === 'alt' || token === 'option') {
                return isMac ? '⌥' : 'Alt';
            }
            if (token === 'ctrl' || token === 'control') {
                return isMac ? '⌃' : 'Ctrl';
            }
            return key.length === 1 ? key.toUpperCase() : key;
        })
        .join(separator);
}
