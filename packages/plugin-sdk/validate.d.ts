export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export declare const knownPermissionIds: readonly string[];
export declare const pluginApiVersion: string;

export interface CompatibilityTarget {
  zyncVersion?: string;
  pluginApiVersion?: string;
}

/** Authoring preflight. Native install validation remains authoritative. */
export function validateManifest(manifest: unknown, target?: CompatibilityTarget): ValidationResult;

/** Checks manifest.json, referenced assets, and basic package limits without modifying the directory. */
export function validatePackageDirectory(directory: string, target?: CompatibilityTarget): ValidationResult;
