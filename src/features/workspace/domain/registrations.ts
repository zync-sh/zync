import { SPLIT_FEATURE_IDS, type SplitFeatureId, type PaneContent } from '../../../lib/paneLayout/types';
import { isPaneRegion, PANE_REGIONS, type PaneRegion } from '../../../lib/paneLayout/regions';

/** Metadata budgets, not limits on live panes (the layout owner retains its four-pane cap). */
export const WORKSPACE_VIEW_LIMITS = Object.freeze({
    registrations: 256,
    labelCodePoints: 120,
    pluginIdLength: 160,
    panelIdLength: 320,
});

export type WorkspaceFeatureView = SplitFeatureId;
export type WorkspaceBuiltinView = 'terminal' | WorkspaceFeatureView;
export type WorkspaceViewLocation = PaneRegion;
export type WorkspaceViewCapability = 'rename' | 'reorder' | 'pin' | 'hide';
export type WorkspaceViewSource =
    | { readonly kind: 'terminal' }
    | { readonly kind: 'feature'; readonly featureId: WorkspaceFeatureView }
    | { readonly kind: 'plugin'; readonly pluginId: string; readonly panelId: string };

/**
 * Presentation metadata only: no renderer, instance identity, permission or lifecycle owner.
 * Multiplicity describes whether another independent instance is supported; callers still
 * enforce authorization, unsaved-work guards and the layout cap through existing services.
 */
export interface WorkspaceViewRegistration {
    readonly id: string;
    readonly source: WorkspaceViewSource;
    readonly label: string;
    readonly allowedLocations: readonly WorkspaceViewLocation[];
    readonly multiplicity: 'single' | 'multiple';
    readonly capabilities: readonly WorkspaceViewCapability[];
}

export type WorkspaceRegistrationError = 'registration' | 'source' | 'id' | 'label'
    | 'locations' | 'multiplicity' | 'capabilities';
export type WorkspaceRegistrationResult =
    | { readonly ok: true; readonly registration: WorkspaceViewRegistration }
    | { readonly ok: false; readonly reason: WorkspaceRegistrationError };

export interface WorkspaceViewRegistry {
    readonly registrations: readonly WorkspaceViewRegistration[];
    readonly issues: readonly {
        readonly index: number | null;
        readonly reason: WorkspaceRegistrationError | 'not-array' | 'duplicate' | 'limit';
    }[];
}

/** Host-validated plugin views with unambiguous complete panel ownership. No runtime authority. */
export function pluginNavigationViews(registry: WorkspaceViewRegistry) {
    return registry.registrations.filter((view): view is WorkspaceViewRegistration & {
        id: `plugin:${string}`; source: Extract<WorkspaceViewSource, { kind: 'plugin' }>;
    } => view.source.kind === 'plugin' && isPluginWorkspaceViewId(view.id)
        && registry.registrations.filter(other => other.source.kind === 'plugin'
            && view.source.kind === 'plugin' && other.source.panelId === view.source.panelId).length === 1);
}

const CAPABILITIES: readonly WorkspaceViewCapability[] = ['rename', 'reorder', 'pin', 'hide'];
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069]/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFeatureView(value: unknown): value is WorkspaceFeatureView {
    return SPLIT_FEATURE_IDS.some(id => id === value);
}

function isCapability(value: unknown): value is WorkspaceViewCapability {
    return CAPABILITIES.some(capability => capability === value);
}

function hasUnpairedSurrogate(value: string): boolean {
    return Array.from(value).some(character => character.length === 1
        && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);
}

function isOpaqueIdentifier(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        && !/\s/.test(value) && !UNSAFE_TEXT.test(value) && !hasUnpairedSurrogate(value);
}

/** Built-in view identity is independent of labels and of connection/content instance IDs. */
export function builtinWorkspaceViewId(view: WorkspaceBuiltinView): string {
    return view === 'terminal' ? 'builtin:terminal' : `builtin:feature:${view}`;
}

/**
 * Keep the owning plugin separate from its opaque complete panel ID. V2 panel IDs already
 * contain an owner prefix; legacy IDs need not. Encoding both fields avoids delimiter collisions.
 */
export function pluginWorkspaceViewId(pluginId: unknown, panelId: unknown): string | undefined {
    if (!isOpaqueIdentifier(pluginId, WORKSPACE_VIEW_LIMITS.pluginIdLength)
        || !isOpaqueIdentifier(panelId, WORKSPACE_VIEW_LIMITS.panelIdLength)) return undefined;
    return `plugin:${encodeURIComponent(pluginId)}:${encodeURIComponent(panelId)}`;
}

/** Recognize only canonical, bounded encoded identities, including dormant preferences. */
export function isPluginWorkspaceViewId(value: unknown): value is `plugin:${string}` {
    if (typeof value !== 'string' || value.length > 4328) return false;
    const parts = value.split(':');
    if (parts.length !== 3 || parts[0] !== 'plugin') return false;
    try { return pluginWorkspaceViewId(decodeURIComponent(parts[1]), decodeURIComponent(parts[2])) === value; }
    catch { return false; }
}

function parseSource(value: unknown): WorkspaceViewSource | undefined {
    if (!isRecord(value)) return undefined;
    if (value.kind === 'terminal') return Object.freeze({ kind: 'terminal' });
    if (value.kind === 'feature' && isFeatureView(value.featureId)) {
        return Object.freeze({ kind: 'feature', featureId: value.featureId });
    }
    if (value.kind === 'plugin' && isOpaqueIdentifier(value.pluginId, WORKSPACE_VIEW_LIMITS.pluginIdLength)
        && isOpaqueIdentifier(value.panelId, WORKSPACE_VIEW_LIMITS.panelIdLength)) {
        return Object.freeze({ kind: 'plugin', pluginId: value.pluginId, panelId: value.panelId });
    }
    return undefined;
}

/** Validate untrusted metadata and copy only supported fields; malformed IDs are never repaired. */
export function parseWorkspaceViewRegistration(value: unknown): WorkspaceRegistrationResult {
    if (!isRecord(value)) return { ok: false, reason: 'registration' };
    const source = parseSource(value.source);
    if (!source) return { ok: false, reason: 'source' };
    const expectedId = source.kind === 'plugin' ? pluginWorkspaceViewId(source.pluginId, source.panelId)
        : builtinWorkspaceViewId(source.kind === 'terminal' ? 'terminal' : source.featureId);
    if (typeof expectedId !== 'string' || value.id !== expectedId) return { ok: false, reason: 'id' };
    if (typeof value.label !== 'string' || value.label.length > WORKSPACE_VIEW_LIMITS.labelCodePoints * 2
        || UNSAFE_TEXT.test(value.label) || hasUnpairedSurrogate(value.label)) return { ok: false, reason: 'label' };
    const label = value.label.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!label || Array.from(label).length > WORKSPACE_VIEW_LIMITS.labelCodePoints) return { ok: false, reason: 'label' };
    if (!Array.isArray(value.allowedLocations) || value.allowedLocations.length === 0
        || value.allowedLocations.length > PANE_REGIONS.length || !value.allowedLocations.includes('workspace')
        || new Set(value.allowedLocations).size !== value.allowedLocations.length
        || !value.allowedLocations.every(isPaneRegion)) return { ok: false, reason: 'locations' };
    if (value.multiplicity !== 'single' && value.multiplicity !== 'multiple') return { ok: false, reason: 'multiplicity' };
    if (!Array.isArray(value.capabilities) || value.capabilities.length > CAPABILITIES.length
        || new Set(value.capabilities).size !== value.capabilities.length) return { ok: false, reason: 'capabilities' };
    const capabilities: WorkspaceViewCapability[] = [];
    for (const capability of value.capabilities) {
        if (!isCapability(capability)) return { ok: false, reason: 'capabilities' };
        capabilities.push(capability);
    }
    return {
        ok: true,
        registration: Object.freeze({
            id: expectedId, source, label,
            allowedLocations: Object.freeze([...value.allowedLocations]),
            multiplicity: value.multiplicity,
            capabilities: Object.freeze(capabilities),
        }),
    };
}

/**
 * Build a bounded snapshot in input order. The first valid duplicate wins; a malformed entry
 * never reserves an ID. Diagnostics identify rejected input without retaining arbitrary data.
 */
export function buildWorkspaceViewRegistry(input: unknown): WorkspaceViewRegistry {
    const registrations: WorkspaceViewRegistration[] = [];
    const issues: Array<WorkspaceViewRegistry['issues'][number]> = [];
    if (!Array.isArray(input)) issues.push({ index: null, reason: 'not-array' });
    else {
        const seen = new Set<string>();
        for (let index = 0; index < Math.min(input.length, WORKSPACE_VIEW_LIMITS.registrations); index++) {
            const parsed = parseWorkspaceViewRegistration(input[index]);
            if (!parsed.ok) issues.push({ index, reason: parsed.reason });
            else if (seen.has(parsed.registration.id)) issues.push({ index, reason: 'duplicate' });
            else {
                seen.add(parsed.registration.id);
                registrations.push(parsed.registration);
            }
        }
        if (input.length > WORKSPACE_VIEW_LIMITS.registrations) issues.push({ index: WORKSPACE_VIEW_LIMITS.registrations, reason: 'limit' });
    }
    return Object.freeze({ registrations: Object.freeze(registrations), issues: Object.freeze(issues.map(issue => Object.freeze(issue))) });
}

/** Missing registrations retain their requested ID; never substitute another installed view. */
export function resolveWorkspaceViewRegistration(registry: WorkspaceViewRegistry, id: string):
    { readonly status: 'found'; readonly registration: WorkspaceViewRegistration }
    | { readonly status: 'missing'; readonly id: string } {
    const registration = registry.registrations.find(entry => entry.id === id);
    return registration ? { status: 'found', registration } : { status: 'missing', id };
}

/** Historical PaneContent.pluginId contains the complete panel ID, not its owner. */
export function registrationForContent(registry: WorkspaceViewRegistry, content: PaneContent): WorkspaceViewRegistration | undefined {
    if (content.kind === 'plugin') {
        const matches = registry.registrations.filter(registration => registration.source.kind === 'plugin'
            && registration.source.panelId === content.pluginId);
        return matches.length === 1 ? matches[0] : undefined;
    }
    const id = builtinWorkspaceViewId(content.kind === 'term' ? 'terminal' : content.featureId);
    const resolved = resolveWorkspaceViewRegistration(registry, id);
    return resolved.status === 'found' ? resolved.registration : undefined;
}

const BUILTIN_LABELS: Readonly<Record<WorkspaceBuiltinView, string>> = {
    terminal: 'Terminal', files: 'Files', 'port-forwarding': 'Port Forwarding',
    dashboard: 'Dashboard', snippets: 'Snippets', security: 'Security hardening audit',
};
const BUILTIN_VIEWS: readonly WorkspaceBuiltinView[] = ['terminal', ...SPLIT_FEATURE_IDS];

/** Canonical host label shared by view registrations and their existing UI adapters. */
export function builtinWorkspaceViewLabel(view: WorkspaceBuiltinView): string {
    return BUILTIN_LABELS[view];
}

/** Stable host metadata; presentation capability declarations do not imply UI is implemented. */
export const BUILTIN_WORKSPACE_VIEW_REGISTRATIONS: readonly WorkspaceViewRegistration[] = Object.freeze(BUILTIN_VIEWS.map(view => Object.freeze({
    id: builtinWorkspaceViewId(view),
    source: Object.freeze(view === 'terminal' ? { kind: 'terminal' as const }
        : { kind: 'feature' as const, featureId: view }),
    label: BUILTIN_LABELS[view],
    allowedLocations: Object.freeze([...PANE_REGIONS]),
    multiplicity: 'multiple' as const,
    capabilities: Object.freeze([...CAPABILITIES]),
})));
