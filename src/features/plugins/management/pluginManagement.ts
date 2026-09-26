import { ipcRenderer } from '../../../lib/tauri-ipc';
import type { PluginSignatureStatus } from '../types';

export interface PluginGrantSummary {
    requiredPermissions: string[];
    optionalPermissions: string[];
    legacyAccess: boolean;
    approvedAtMs: number;
    sourceLabel?: string;
    trustLabel?: string;
    registryVersion?: number;
    publisherVerified: boolean;
}

export interface PluginManagementDetails {
    pluginId: string;
    publisher?: string;
    version: string;
    manifestVersion: number;
    sourceLabel: string;
    trustLabel: string;
    packageDigest?: string;
    signatureStatus?: PluginSignatureStatus | null;
    grant?: PluginGrantSummary;
    storage: {
        bytes: number;
        keyCount: number;
    };
    rollback?: {
        version: string;
        packageDigest: string;
        retainedAtMs: number;
    } | null;
}

export interface PluginRollbackResult {
    pluginId: string;
    restoredVersion: string;
    replacedVersion: string;
}

export interface PluginUninstallResult {
    dataDeleted: boolean;
    dataDeleteError?: string;
}

export function getPluginManagementDetails(pluginId: string): Promise<PluginManagementDetails> {
    return ipcRenderer.invoke('plugins:management_details', { pluginId });
}

export function setPluginOptionalPermissions(
    pluginId: string,
    optionalPermissionIds: string[],
): Promise<PluginGrantSummary> {
    return ipcRenderer.invoke('plugins:management_set_optional_permissions', {
        pluginId,
        optionalPermissionIds,
    });
}

export function clearPluginStorage(pluginId: string): Promise<boolean> {
    return ipcRenderer.invoke('plugins:management_clear_storage', { pluginId });
}

export function rollbackPluginVersion(pluginId: string): Promise<PluginRollbackResult> {
    return ipcRenderer.invoke('plugins:rollback_version', { pluginId });
}

export function uninstallPlugin(
    pluginId: string,
    deleteData: boolean,
): Promise<PluginUninstallResult> {
    return ipcRenderer.invoke('plugins:uninstall', {
        id: pluginId,
        deleteData,
    });
}
