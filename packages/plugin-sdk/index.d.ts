export interface PermissionRequest {
  id: string;
  reason: string;
  scope?: string;
  hosts?: string[];
}

export interface SurfaceContribution {
  id: string;
  title: string;
  entry: string;
  allowMultiple?: boolean;
}

export interface ManifestV2 {
  manifestVersion: 2;
  id: string;
  name: string;
  version: string;
  publisher: string;
  description?: string;
  license?: string;
  homepage?: string;
  support?: string;
  privacyPolicy?: string;
  engines: { zync: string; pluginApi: string };
  runtime?: { entry?: string };
  contributes?: {
    commands?: Array<{ id: string; title: string }>;
    paneKinds?: SurfaceContribution[];
    dashboardCards?: SurfaceContribution[];
  };
  permissions?: {
    required?: PermissionRequest[];
    optional?: PermissionRequest[];
  };
  icon?: string;
  type?: string;
}

/** Type-checks the manifest; the native host remains the final validator. */
export function defineManifest<T extends ManifestV2>(manifest: T): T;
