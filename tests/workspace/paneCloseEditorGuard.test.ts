import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const manager = read('src/components/FileManager.tsx');
const store = read('src/store/terminalSlice.ts');
const connections = read('src/store/connectionSlice.ts');
const layout = read('src/components/layout/MainLayout.tsx');
const tabs = read('src/components/layout/WorkspaceTabBar.tsx');

assert.match(
    manager,
    /registerPaneCloseBlocker\(scope, editorCloseToken\.current\)/,
    'a dirty file editor must register a close blocker for its pane',
);
const terminalGroupClose = store.match(
    /closeTerminalGroup: \(connectionId, termId\) => \{[\s\S]*?\n    \},/,
)?.[0];
assert.ok(terminalGroupClose, 'terminal group close handler must exist');
assert.match(
    terminalGroupClose,
    /if \(owned && isPaneLayoutCloseBlocked\(connectionId, owned\)\) \{[\s\S]*?showToast\('warning', 'Close the unsaved editor before closing this pane\.'\);[\s\S]*?return;/,
    'closing a terminal group must stop when its layout contains an unsaved editor',
);
assert.ok(
    terminalGroupClose.indexOf('isPaneLayoutCloseBlocked(connectionId, owned)') <
        terminalGroupClose.indexOf("ipc.send('terminal:kill'"),
    'the guard must run before any terminal is killed',
);
assert.match(
    store,
    /closePaneGroup:[\s\S]*?isPaneLayoutCloseBlocked\(connectionId, layout\)/,
    'closing a group must respect every contained pane blocker',
);
assert.match(
    store,
    /closePaneInSplit:[\s\S]*?isPaneCloseBlocked\(paneCloseScope\(connectionId, node\.content\)\)/,
    'closing one split pane must check only that pane for unsaved content',
);
assert.match(
    layout,
    /if \(!store\.closePaneInSplit\(tab\.connectionId, pane\.id\)\)\s*(?:\{\s*return;\s*\}|return;)/,
    'feature tabs must remain open when pane close is blocked',
);
assert.match(
    layout,
    /const featureTabs = useMemo\(\(\) => featureTabsFromPaneGroups\(paneGroups\), \[paneGroups\]\)/,
    'feature tabs must derive from canonical groups so a blocked close cannot remove the tab independently',
);
const groupClose = layout.match(
    /const handlePaneGroupClose = useCallback\([\s\S]*?\n\s*\},\s*\[/,
)?.[0];
assert.ok(groupClose, 'group close callback must exist');
const groupGuard = groupClose.search(
    /if \(!store\.closePaneGroup\(tab\.connectionId, owner\)\)\s*(?:\{\s*return;\s*\}|return;)/,
);
assert.ok(groupGuard >= 0, 'a refused group close must return immediately');
for (const effect of [
    'const groupsAfterClose =',
    'toggleConnectionFeature(',
    'setActiveFeatureTabId(',
    'setTabView(',
    'handlePluginTabSelect(',
]) {
    assert.ok(
        groupClose.indexOf(effect) > groupGuard,
        `${effect} must run only after the guarded close succeeds`,
    );
}
const undock = tabs.match(/const handleUnsplit = \([\s\S]*?\n    \};/)?.[0];
assert.ok(undock, 'undocking must have an explicit release handler');
assert.match(
    undock,
    /if \(!releasePaneFromSplit\(connectionId, \{ contentId: paneContentKey\(focused\.content, focused\.id\) \}\)\) return;/,
    'undocking moves the existing content through the non-destructive release path',
);
assert.doesNotMatch(
    undock,
    /closePaneInSplit|closePaneGroup/,
    'undocking must not close a dirty editor or invoke close guards',
);
assert.match(
    connections,
    /closeTab:[\s\S]*?isPaneLayoutCloseBlocked\(connectionId, layout\)/,
    'closing a connection tab must respect its unsaved pane editors',
);

console.log('Pane close editor guard test passed.');
