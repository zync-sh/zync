import type { RegistryPlugin } from '../types';

export function compareVersion(left: string, right: string): number {
    const parse = (value: string) => {
        const withoutBuild = value.split('+', 1)[0];
        const separator = withoutBuild.indexOf('-');
        const core = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator);
        const pre = separator < 0 ? '' : withoutBuild.slice(separator + 1);
        return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
    };
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < 3; index++) {
        if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
    }
    if (!a.pre[0] && !b.pre[0]) return 0;
    if (!a.pre[0]) return 1;
    if (!b.pre[0]) return -1;
    for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
        if (a.pre[index] === undefined) return -1;
        if (b.pre[index] === undefined) return 1;
        if (a.pre[index] === b.pre[index]) continue;
        const aNumber = /^\d+$/.test(a.pre[index]);
        const bNumber = /^\d+$/.test(b.pre[index]);
        if (aNumber && bNumber) return Number(a.pre[index]) - Number(b.pre[index]);
        if (aNumber !== bNumber) return aNumber ? -1 : 1;
        return a.pre[index].localeCompare(b.pre[index]);
    }
    return 0;
}

export function selectMarketplaceReleases(
    releases: RegistryPlugin[],
    betaPluginIds: ReadonlySet<string>,
): RegistryPlugin[] {
    const byPlugin = new Map<string, RegistryPlugin>();
    for (const release of releases) {
        if (release.channel === 'beta' && !betaPluginIds.has(release.id)) continue;
        const current = byPlugin.get(release.id);
        if (!current || (current.revokedReason && !release.revokedReason)
            || (Boolean(current.revokedReason) === Boolean(release.revokedReason)
                && compareVersion(release.version, current.version) > 0)) {
            byPlugin.set(release.id, release);
        }
    }
    return [...byPlugin.values()];
}
