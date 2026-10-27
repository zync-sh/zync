import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

/** Match production call arguments exactly while allowing formatter whitespace and trailing commas. */
function hasCall(source: string, name: string, expected: readonly string[]): boolean {
    const tree = ts.createSourceFile(
        'contract.tsx',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    let found = false;
    function visit(node: ts.Node): void {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === name
        ) {
            const args = node.arguments.map((argument) =>
                argument.getText(tree).replace(/\s+/g, ''),
            );
            found ||=
                args.length === expected.length &&
                args.every((argument, index) => argument === expected[index]);
        }
        ts.forEachChild(node, visit);
    }
    visit(tree);
    return found;
}

const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'store', 'terminalSlice.ts'),
    'utf8',
);

const termDockStart = source.indexOf("if (payload.kind === 'term')");
const termDockEnd = source.indexOf('const detached', termDockStart);
assert.ok(termDockStart >= 0 && termDockEnd > termDockStart, 'term dock branch not found');
const termDock = source.slice(termDockStart, termDockEnd);

assert.match(
    termDock,
    /sameGroupTermDock\(groups, owner, payload\.termId\)/,
    'same-group shell dock must use the tested helper',
);
assert.match(termDock, /if \(selfDock\)/, 'same-group shell dock must take the split-on-self path');
assert.match(
    termDock,
    /term-\$\{crypto\.randomUUID\(\)\}/,
    'split-on-self must create a distinct shell session',
);
assert.ok(
    hasCall(termDock, 'dockIntoLayout', [
        'targetLayout',
        'termPaneContent(duplicateId)',
        'edge',
        'undefined',
        'paneId',
    ]),
    'split-on-self must dock at the hovered pane',
);
assert.match(
    termDock,
    /tabVisible: false/,
    'the sibling shell must stay off the tab bar until unsplit',
);

const paneMoveStart = source.indexOf('// Dropping onto another pane relocates that exact pane.');
const paneMoveEnd = source.indexOf("if (payload.kind === 'term')", paneMoveStart);
assert.ok(paneMoveStart >= 0 && paneMoveEnd > paneMoveStart, 'pane-header move branch not found');
const paneMove = source.slice(paneMoveStart, paneMoveEnd);
assert.match(
    paneMove,
    /!selfTarget/,
    'self detection must use stable content identity, not a colliding local leaf ID',
);
assert.match(
    paneMove,
    /unsplitPane\(sourceLayout, sourcePaneId\)/,
    'moving must detach the exact source pane',
);
assert.match(
    paneMove,
    /sourceOwner\s*===\s*owner\s*\?\s*withoutSource\s*:\s*\(?groups\?\.\[owner\]/,
    'cross-group moves must resolve the hovered layout',
);
assert.ok(
    hasCall(paneMove, 'dockIntoLayout', [
        'targetLayout',
        'sourceNode.content',
        'edge',
        'undefined',
        'paneId',
        'incomingPaneId',
    ]),
    'moving must preserve original content and resolve container collisions at the hovered pane',
);
assert.match(
    paneMove,
    /if \(sourceOwner !== owner\)/,
    'pane moves between Split tabs must update both layouts',
);
assert.match(
    paneMove,
    /isKeepableRemainder\(withoutSource\)/,
    'source remainders use the same retention policy as session persistence',
);
assert.match(
    paneMove,
    /ownerForLayout\(withoutSource, sourceOwner\)/,
    'surviving content determines the new owner',
);
assert.match(
    paneMove,
    /commitDockPlan\(\s*nextGroups,\s*nextTabs,\s*owner/,
    'cross-group movement must share atomic allocation and focus publication',
);

const activateGroupStart = source.indexOf('activatePaneGroup: (connectionId, owner) =>');
const activateGroupEnd = source.indexOf('closePaneGroup:', activateGroupStart);
assert.ok(
    activateGroupStart >= 0 && activateGroupEnd > activateGroupStart,
    'pane-group activation branch not found',
);
assert.doesNotMatch(
    source.slice(activateGroupStart, activateGroupEnd),
    /!isSplitLayout\(layout\)/,
    'standalone feature panes must become the active owner just like split groups',
);

const genericDockStart = source.indexOf('const existingLayout = groups?.[owner]', termDockEnd);
const genericDockEnd =
    source.slice(genericDockStart).search(/if \(!layout\)\s*\{?\s*return/) + genericDockStart;
assert.ok(
    genericDockStart >= 0 && genericDockEnd > genericDockStart,
    'generic dock base-layout branch not found',
);
const genericDock = source.slice(genericDockStart, genericDockEnd);

assert.match(
    genericDock,
    /owner !== WORKSPACE_PANE_OWNER && tabs\.some\(\(tab\) => tab\.id === owner\)/,
    'feature/plugin splits launched from a shell must retain the shell as the base pane',
);
const shellBaseIndex = genericDock.indexOf('layout = singlePane(owner)');
const pluginBranchIndex = genericDock.indexOf("payload.kind === 'plugin'");
assert.ok(shellBaseIndex >= 0, 'shell base-pane construction must be present');
assert.ok(pluginBranchIndex >= 0, 'plugin dock branch must be present');
assert.ok(
    shellBaseIndex < pluginBranchIndex,
    'the shell base pane must be chosen before constructing a feature/plugin-only canvas',
);
assert.match(
    source,
    /let seededFromPluginPayload = false;[\s\S]*?layout = singlePluginPane\(payload\.pluginId, undefined, payload\.instanceId\);[\s\S]*?seededFromPluginPayload = true;/,
    'a plugin-seeded canvas must record that its first pane already owns the payload identity',
);
assert.match(
    source,
    /const duplicatePlugin\s*=\s*payload\.kind === 'plugin' &&\s*\([\s\S]*?seededFromPluginPayload/,
    'docking into a plugin-seeded canvas must allocate a distinct pane instance',
);

const resolveOwnerStart = source.indexOf('function resolveDockOwner(');
const resolveOwnerEnd = source.indexOf('function writeConnectionGroups(', resolveOwnerStart);
assert.ok(
    resolveOwnerStart >= 0 && resolveOwnerEnd > resolveOwnerStart,
    'dock-owner resolver not found',
);
const resolveOwner = source.slice(resolveOwnerStart, resolveOwnerEnd);
assert.match(
    resolveOwner,
    /activeGroupOwner\?: string \| null/,
    'dock-owner resolution must accept the explicitly active pane group',
);
assert.match(
    resolveOwner,
    /activeGroupOwner && groups\?\.\[activeGroupOwner\]/,
    'dock-owner resolution must prefer an existing active pane group before the active shell',
);

const ensureFeatureStart = source.indexOf(
    'ensureFeaturePane: (connectionId, featureId, instanceId) =>',
);
const ensureFeatureEnd = source.indexOf('ensurePluginPane:', ensureFeatureStart);
assert.ok(
    ensureFeatureStart >= 0 && ensureFeatureEnd > ensureFeatureStart,
    'feature-pane ensure branch not found',
);
assert.doesNotMatch(
    source.slice(ensureFeatureStart, ensureFeatureEnd),
    /activePaneGroupOwner/,
    'ensuring inventory panes must not steal the active pane group',
);

const tabBarSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'layout', 'CombinedTabBar.tsx'),
    'utf8',
);
assert.match(
    tabBarSource,
    /const splitGroups = Object\.entries\(paneGroups \?\? \{\}\)/,
    'every persisted split group must have a top-level inventory entry',
);
assert.match(
    tabBarSource,
    /return renderSplitTab\(term\.id, ownedSplit\)/,
    'a shell-owned split must replace that shell tab in place',
);
assert.match(
    tabBarSource,
    /describePaneGroup\(members, leaves\.length - members\.length\)/,
    'split tab chrome must describe visible members without changing canonical group membership',
);
assert.match(
    tabBarSource,
    /featureAnchorOwnerByTabId\.set\(featureAnchor\.id, owner\)/,
    'every feature-owned split must retain its exact inventory anchor',
);
assert.match(
    tabBarSource,
    /const anchoredOwner = featureAnchorOwnerByTabId\.get\(featureTab\.id\)/,
    'a feature-owned split must replace that feature tab in place',
);
assert.match(
    tabBarSource,
    /instanceId: featureTab\.instanceId/,
    'feature tab drags must preserve the exact feature instance',
);
assert.match(
    tabBarSource,
    /leaf\.content\.featureId === featureId[\s\S]*?leaf\.content\.instanceId === featureTab\.instanceId/,
    'feature tab drags must resolve a source pane by both kind and instance',
);
assert.match(
    tabBarSource,
    /duplicateCount > 1[\s\S]*?standaloneFeatureOrdinals\.get\(featureTab\.id\)/,
    'duplicate standalone feature tabs must have stable numbered labels',
);

const paneViewSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'terminal', 'PaneLeafView.tsx'),
    'utf8',
);
assert.match(
    paneViewSource,
    /state\.terminals\[connectionId\] \|\| EMPTY_TERMINAL_TABS/,
    'Files-only layouts must use a stable empty terminal snapshot',
);
assert.doesNotMatch(
    paneViewSource,
    /inert=\{!focused/,
    'inactive panes must remain pointer-scrollable without requiring a click first',
);
assert.match(
    paneViewSource,
    /onWheelCapture=\{\(\) => \{[\s\S]*?if \(!focused\) onFocus\(\)/,
    'wheel input over feature content must activate and scroll the pane under the pointer',
);
assert.match(
    paneViewSource,
    /onWheelCapture=\{\(\) => \{[\s\S]*?if \(!focused\) requestFocus\(\)/,
    'wheel input over terminal content must activate and scroll the pane under the pointer',
);
assert.match(
    paneViewSource,
    /const requestFocus = onFocusContent \?\? \(\(\) => focusPane\(connectionId, node\.id\)\)/,
    'exact content-key focus overrides legacy local-pane focus when supplied by the host',
);

const workspaceTabBarSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'layout', 'WorkspaceTabBar.tsx'),
    'utf8',
);
assert.match(
    workspaceTabBarSource,
    /handleUnsplit\(paneId, owner\)/,
    'unsplit of a named split must resolve that group, not only the active canvas',
);
assert.match(
    workspaceTabBarSource,
    /onPaneGroupClose=\{onPaneGroupClose\}/,
    'the Split-tab close button must close the whole group',
);
assert.match(
    workspaceTabBarSource,
    /onSplitUnsplit=\{\(owner, paneId\) => handleUnsplit\(paneId, owner\)\}/,
    'unsplitting a focused pane must remain separate from closing the Split tab',
);
assert.match(
    workspaceTabBarSource,
    /state\.activePaneGroupOwner\[connectionId\]/,
    'canvas unsplit must use the active Files-only split owner when no shell is focused',
);
assert.match(
    workspaceTabBarSource,
    /item\.instanceId === released\.instanceId/,
    'unsplit must restore the exact released feature instance',
);
assert.match(
    workspaceTabBarSource,
    /activeView\.startsWith\('plugin:'\)/,
    'the Split button must split a full-view plugin just like built-in panes',
);
assert.match(
    workspaceTabBarSource,
    /onOpenSplitPlugin=\{handleOpenSplitPlugin\}/,
    'plugin tabs must expose the shared split placements',
);
assert.match(
    tabBarSource,
    /onContextMenu=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?target: \{ type: 'split', owner, paneId: interactivePaneId \}/,
    'generic split tabs must suppress the WebView menu and open the Zync split menu for its visible interaction target',
);
assert.match(
    tabBarSource,
    /const dockPayload = activePane && isPaneLeaf\(activePane\) \? paneDockPayload\(activePane\) : null/,
    'a generic Split tab must resolve its focused pane into a drag payload',
);
assert.match(
    tabBarSource,
    /if \(dockPayload\) beginDockPointer\(event, dockPayload\)/,
    'dragging a generic Split tab must drag its focused pane',
);
assert.match(
    tabBarSource,
    /if \(consumeClickIfDragged\(\)\) return;[\s\S]*?onSplitSelect\?\.\(owner\)/,
    'a completed Split-tab drag must not also activate the clicked group',
);

const mainLayoutSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'layout', 'MainLayout.tsx'),
    'utf8',
);
assert.doesNotMatch(
    mainLayoutSource,
    /splitTermBesideFeature|splitTermBesidePlugin/,
    'drag completion must use one generic dock path for overlays and canvas panes',
);
assert.match(
    mainLayoutSource,
    /usePluginPaneNavigation\(\{ connectionId: tab\.connectionId, view: tab\.view, pinnedFeatures, isActive,[\s\S]*?groups: paneGroups, getState: useAppStore\.getState/,
    'plugin navigation must reconcile the canonical canvas inventory through the shared hook',
);
const pluginNavigationSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'layout', 'usePluginPaneNavigation.ts'),
    'utf8',
);
assert.match(
    pluginNavigationSource,
    /layoutForPlugin\(currentGroups, view\.slice\('plugin:'\.length\), state\.activePaneGroupOwner\[connectionId\]\)/,
    'plugin canvas resolution must prefer the explicitly active instance owner',
);
assert.match(
    pluginNavigationSource,
    /else if \(state\.activePaneGroupOwner\[connectionId\] !== owner\) state\.activatePaneGroup\(connectionId, owner\)/,
    'navigation must activate the resolved existing owner only when it changes',
);
assert.match(
    mainLayoutSource,
    /store\.closePaneGroup\(tab\.connectionId, owner\)/,
    'closing a standalone feature tab or Split tab must remove its pane layout',
);
assert.match(
    mainLayoutSource,
    /const featureTabs = useMemo\(\(\) => featureTabsFromPaneGroups\(paneGroups\), \[paneGroups\]\)/,
    'Split-tab feature inventory must derive from canonical groups, with no independent removal before guarded close',
);
assert.match(
    mainLayoutSource,
    /if \(!store\.closePaneGroup\(tab\.connectionId, owner\)\) return;[\s\S]*?const groupsAfterClose = useAppStore\.getState\(\)\.paneLayouts\[tab\.connectionId\]/,
    'split-close fallback lookup must use pane layouts after the close mutation',
);

console.log('dockInSplit split-on-self contract tests passed.');
