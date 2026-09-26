import permissionCatalogJson from '../../../plugin-api/permissions.json' with { type: 'json' };

export type PluginPermissionRisk =
    | 'declarative'
    | 'low'
    | 'personal-data'
    | 'system-changing'
    | 'command-execution'
    | 'high-risk-transient';

export interface PluginPermissionDefinition {
    id: string;
    risk: PluginPermissionRisk;
    title: string;
    description: string;
}

export interface PluginPermissionRequest {
    id: string;
    reason: string;
    scope?: string;
    hosts?: string[];
}

export interface PluginPermissionDeclarations {
    required?: PluginPermissionRequest[];
    optional?: PluginPermissionRequest[];
}

export interface PluginEngineRequirements {
    zync?: string;
    pluginApi?: string;
}

export interface PluginRuntimeManifest {
    entry?: string;
}

export interface EditorProviderManifest {
    entry?: string;
    displayName?: string;
    priority?: number;
    defaultFor?: string[];
    supports?: string[];
    fileExtensions?: string[];
    largeFileLimitMb?: number;
}

export interface PluginCommandContribution {
    id: string;
    title: string;
}

export interface PluginSurfaceContribution {
    id: string;
    title: string;
    entry: string;
    allowMultiple?: boolean;
}

export interface PluginContributions {
    commands?: PluginCommandContribution[];
    paneKinds?: PluginSurfaceContribution[];
    dashboardCards?: PluginSurfaceContribution[];
}

export interface PluginManifest {
    manifestVersion?: number;
    id: string;
    name: string;
    version: string;
    description?: string;
    publisher?: string;
    license?: string;
    homepage?: string;
    support?: string;
    privacyPolicy?: string;
    engines?: PluginEngineRequirements;
    runtime?: PluginRuntimeManifest;
    contributes?: PluginContributions;
    permissions?: PluginPermissionDeclarations;
    main?: string;
    style?: string;
    mode?: 'light' | 'dark';
    preview_bg?: string;
    preview_accent?: string;
    icon?: string;
    type?: string;
    iconsPath?: string;
    icons_path?: string;
    editor?: EditorProviderManifest;
}

export interface InstalledPlugin {
    path: string;
    manifest: PluginManifest;
    script?: string;
    style?: string;
    editorHtml?: string;
    enabled: boolean;
}

export interface PluginInstallInspection {
    inspectionId: string;
    packageDigest: string;
    sourceLabel: string;
    trustLabel: string;
    signatureStatus?: PluginSignatureStatus | null;
    registryVersion?: number | null;
    publisherVerified?: boolean;
    previousVersion?: string | null;
    previousPackageDigest?: string | null;
    previousPermissions?: PluginPermissionDeclarations | null;
    previouslyGrantedOptional?: string[];
    manifest: PluginManifest;
}

export interface PluginActivationTransaction {
    activationId: string;
    pluginId: string;
    previousVersion?: string | null;
}

export interface PluginSignatureStatus {
    publisher: string;
    keyId: string;
    publishedAtMs: number;
    integrityRoot: string;
    verified: boolean;
}

export interface RegistryPlugin {
    id: string;
    name: string;
    version: string;
    channel?: 'stable' | 'beta';
    description: string;
    author?: string;
    publisher?: string;
    downloadUrl: string;
    thumbnailUrl?: string;
    icon?: string;
    mode?: 'dark' | 'light';
    type?: 'theme' | 'tool' | 'editor-provider' | 'icon-theme';
    editor?: Pick<EditorProviderManifest, 'displayName' | 'supports'>;
    packageDigest?: string;
    publisherKeyId?: string;
    publisherPublicKey?: string;
    publisherVerified?: boolean;
    registryVerified?: boolean;
    revokedReason?: string;
}

export interface RegistryRevocation {
    kind: 'publisherKey' | 'pluginRelease';
    publisher: string;
    keyId?: string;
    pluginId?: string;
    version?: string;
    packageDigest?: string;
    revokedAtMs: number;
    reason: string;
}

export interface TrustedPluginRegistrySnapshot {
    version: number;
    expiresAtMs: number;
    plugins: RegistryPlugin[];
    revocations: RegistryRevocation[];
}

export const PLUGIN_PERMISSION_CATALOG = permissionCatalogJson as PluginPermissionDefinition[];

const permissionById = new Map(
    PLUGIN_PERMISSION_CATALOG.map((definition) => [definition.id, definition]),
);

export function getPluginPermissionDefinition(id: string): PluginPermissionDefinition | undefined {
    return permissionById.get(id);
}

export function getDeclaredPluginPermissions(
    manifest: PluginManifest,
): Array<PluginPermissionRequest & { required: boolean }> {
    const required = manifest.permissions?.required ?? [];
    const optional = manifest.permissions?.optional ?? [];
    return [
        ...required.map((permission) => ({ ...permission, required: true })),
        ...optional.map((permission) => ({ ...permission, required: false })),
    ];
}

export function isLegacyPluginManifest(manifest: PluginManifest): boolean {
    return (manifest.manifestVersion ?? 1) < 2;
}

export type Plugin = InstalledPlugin;
