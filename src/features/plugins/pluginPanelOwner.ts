/** Runtime registrations take precedence; installed definitions survive a stopped worker. */
export function resolvePluginPanelOwner(
    panelId: string,
    panels: readonly { id: string; pluginId: string }[],
    plugins: readonly { manifest: { id: string; contributes?: { paneKinds?: readonly { id: string }[] } } }[],
): string {
    return panels.find(panel => panel.id === panelId)?.pluginId
        ?? plugins.find(plugin => plugin.manifest.contributes?.paneKinds?.some(
            pane => `${plugin.manifest.id}:${pane.id}` === panelId,
        ))?.manifest.id
        ?? panelId;
}
