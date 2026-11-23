import type { Connection } from './types';

/** Legacy host forms stored the exact value 'Server' as the automatic default. */
export function hostIconOverride(icon?: string | null): string | undefined {
    return icon && icon !== 'Server' ? icon : undefined;
}

/** Resolve the saved preference and detected identity against the existing icon catalog. */
export function resolveHostIcon(host?: Pick<Connection, 'icon' | 'detectedOs'> | null): string {
    return hostIconOverride(host?.icon) || host?.detectedOs || 'Server';
}

/** Cached OS metadata belongs to the endpoint and jump route that produced it. */
export function isSameHostAppearanceTarget(
    previous: Partial<Connection>,
    next: Partial<Connection>,
): boolean {
    return (
        previous.host?.trim() === next.host?.trim() &&
        previous.port === next.port &&
        previous.jumpServerId === next.jumpServerId
    );
}
