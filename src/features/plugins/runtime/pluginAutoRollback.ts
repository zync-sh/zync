import type { PluginRollbackResult } from '../management/pluginManagement';

export interface PluginAutoRollbackDependencies {
    rollback: (pluginId: string) => Promise<PluginRollbackResult>;
    clearFailures: (pluginId: string) => Promise<void>;
    clearQuarantine: (pluginId: string) => void;
    reloadAndCheck: (pluginId: string) => Promise<boolean>;
}

export type PluginAutoRollbackResult =
    | {
        status: 'restored';
        restoredVersion: string;
        replacedVersion: string;
    }
    | {
        status: 'reverted';
        failedVersion: string;
        restoredVersion: string;
        runtimeHealthy: boolean;
    };

/**
 * Swaps to the retained package and proves that its Worker can start. A failed
 * retained version is swapped back immediately so recovery never strands the
 * user on a second broken package.
 */
export async function autoRollbackPlugin(
    pluginId: string,
    dependencies: PluginAutoRollbackDependencies,
): Promise<PluginAutoRollbackResult> {
    const firstSwap = await dependencies.rollback(pluginId);
    try {
        await dependencies.clearFailures(pluginId);
        dependencies.clearQuarantine(pluginId);
        if (await dependencies.reloadAndCheck(pluginId)) {
            return {
                status: 'restored',
                restoredVersion: firstSwap.restoredVersion,
                replacedVersion: firstSwap.replacedVersion,
            };
        }
    } catch (error) {
        console.error('[Plugins] Retained version recovery failed:', error);
    }

    const secondSwap = await dependencies.rollback(pluginId);
    await dependencies.clearFailures(pluginId);
    dependencies.clearQuarantine(pluginId);
    const runtimeHealthy = await dependencies.reloadAndCheck(pluginId);
    return {
        status: 'reverted',
        failedVersion: firstSwap.restoredVersion,
        restoredVersion: secondSwap.restoredVersion,
        runtimeHealthy,
    };
}
