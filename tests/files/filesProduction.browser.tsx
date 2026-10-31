import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import builtinIconCatalog from '../../plugin-api/builtin-icon-themes.json';
import { FILE_LIST_LAYOUT_STORAGE_KEY } from '../../src/components/file-manager/fileListPresentation';
import type { FileEntry } from '../../src/components/file-manager/types';
import { SidebarChrome, SidebarContent } from '../../src/components/layout/sidebar/SidebarChrome';
import { LayoutMotionScope } from '../../src/components/ui/LayoutMotion';
import type { InstalledPlugin } from '../../src/features/plugins/types';
import { permissionTestEditor } from './fixtures/editorProvider';
import { createFolderSizeFixture } from './fixtures/folderSizes';
import { createPermissionFixture } from './fixtures/permissions';
import { createTransferSafetyFixture } from './fixtures/transferSafety';
import { runFileEditorSaveBrowserChecks } from './helpers/fileEditorSaveBrowserChecks';
import {
    runFileListingAccessBrowserChecks,
    runFilePermissionBrowserChecks,
} from './helpers/filePermissionBrowserChecks';
import {
    runFolderSizeBrowserChecks,
    runFolderSizeRenderChecks,
} from './helpers/folderSizeBrowserChecks';
import '../../src/index.css';

const accessTests = new URLSearchParams(location.search).get('access') === '1';
const windowsTests = new URLSearchParams(location.search).get('windows') === '1';
const administratorTests = new URLSearchParams(location.search).get('admin') === '1';
const host = accessTests || windowsTests ? 'local' : 'files-ui-fixture';
const editorTests = new URLSearchParams(location.search).get('editor') === '1';
const rootPath =
    new URLSearchParams(location.search).get('transferDottedPath') === '1'
        ? '/home/deploy/project.v1'
        : '/home/deploy/project';
const showWorkspaceChrome = new URLSearchParams(location.search).get('layout') === 'sidebars';
const transferSafety =
    new URLSearchParams(location.search).get('transferSafety') === '1'
        ? createTransferSafetyFixture(host, rootPath)
        : undefined;
const entry = (
    name: string,
    type: FileEntry['type'] = '-',
    size = 1234,
    minutesAgo = 0,
): FileEntry => ({
    name,
    type,
    path: `${rootPath}/${name}`,
    size: type === 'd' ? 0 : size,
    permissions: type === 'd' ? '755' : '644',
    owner: 'deploy',
    group: 'team',
    lastModified: Date.now() - minutesAgo * 60_000,
});
const sample = [
    entry('assets', 'd'),
    entry('config', 'd'),
    entry('docs', 'd'),
    entry('scripts', 'd'),
    entry('src', 'd'),
    entry('tests', 'd'),
    entry('docker-compose.yml', '-', 1200, 360),
    entry('index.ts', '-', 812, 90),
    entry('package.json', '-', 1800),
    entry('pnpm-lock.yaml', '-', 84_600),
    entry('README.md', '-', 3400, 180),
    entry('tsconfig.json', '-', 486, 120),
    entry('.env.example', '-', 642, 180),
];

// The approved sample palette is illustrative only. The real app keeps its selected theme/overrides.
for (const [key, value] of Object.entries({
    '--color-app-bg': '#20211f',
    '--color-app-panel': '#242522',
    '--color-app-surface': '#30332b',
    '--color-app-border': '#373a32',
    '--color-app-text': '#e8e9e3',
    '--color-app-muted': '#adb1a5',
    '--color-app-accent': '#f59c77',
})) {
    document.documentElement.style.setProperty(key, value);
}
const calls: string[] = [];
const layoutWrites: string[] = [];
const saveLocal = Storage.prototype.setItem;
Storage.prototype.setItem = function (key: string, value: string) {
    if (key === FILE_LIST_LAYOUT_STORAGE_KEY) {
        layoutWrites.push(value);
    }
    return saveLocal.call(this, key, value);
};
const folderSizeTests = new URLSearchParams(location.search).get('folderSizes') === '1';
const folderSizes = createFolderSizeFixture(folderSizeTests);
if (folderSizeTests) {
    Object.assign(window, {
        runFolderSizeBrowserChecks: () => runFolderSizeBrowserChecks(folderSizes.control),
        runFolderSizeRenderChecks: () => runFolderSizeRenderChecks(folderSizes.control),
    });
}
const permissionFixture = createPermissionFixture(
    new URLSearchParams(location.search).get('permissions') === '1',
    editorTests,
);
if (windowsTests) {
    permissionFixture.control.setModel('windows');
    permissionFixture.control.setSystemEditor(true);
}
const listingReads: string[] = [];
const settingsWrites: Partial<
    ReturnType<typeof useAppStore.getState>['settings']['fileManager']
>[] = [];
const pluginCalls: string[] = [];
let iconPlugins: InstalledPlugin[] = JSON.parse(JSON.stringify(builtinIconCatalog)).map(
    (plugin: InstalledPlugin) => ({ ...plugin, enabled: true }),
);
if (editorTests) {
    iconPlugins.push(
        {
            path: 'builtin://codemirror',
            enabled: true,
            manifest: {
                id: 'com.zync.editor.codemirror',
                name: 'CodeMirror',
                version: '1.0.0',
                type: 'editor-provider',
                editor: { supports: ['save', 'search', 'readonly'] },
            },
        },
        permissionTestEditor,
    );
}
const MATERIAL_ICON_THEME_ID = iconPlugins.find((plugin) => plugin.manifest.iconTheme)!.manifest.id;
let reloadIconPlugins: (() => Promise<boolean>) | undefined;
let remountFiles: (() => void) | undefined;
let setSurfaceActive: ((active: boolean) => void) | undefined;
let failNextListing: string | null = null;
let deferNextFolderRead = false;
let finishFolderRead: (() => void) | undefined;
let deferNextPathCheck = false;
let finishPathCheck: (() => void) | undefined;
const parentFolders = ['archive', 'project', 'release candidate  ', '.private'].map((name) => ({
    ...entry(name, 'd'),
    path: `/home/deploy/${name}`,
}));
const parentListing = [...parentFolders, entry('notes.txt')];

// The real component, real browsing slice and real hooks run against an isolated native boundary.
// No real native file operations, plugins, credentials, or persistence are available.
// Mutation simulation is explicitly opt-in; normal UI tests retain the deny-by-default boundary.
window.ipcRenderer = {
    invoke: async (command: string, args?: { path?: string }) => {
        if (command.startsWith('plugins:')) {
            pluginCalls.push(command);
            if (command === 'plugins:load') {
                return iconPlugins;
            }
            if (command === 'plugins:runtime_reset') {
                return;
            }
            if (command === 'plugins:recovery_status') {
                return { safeMode: false, diagnostics: [] };
            }
            throw new Error(`Unexpected plugin operation: ${command}`);
        }
        calls.push(command);
        if (folderSizes?.handles(command)) {
            return folderSizes.invoke(command, args ?? {});
        }
        if (permissionFixture.handles(command)) {
            return permissionFixture.invoke(command, args ?? {});
        }
        if (transferSafety?.handles(command)) {
            return transferSafety.invoke(command, args ?? {});
        }
        if (command === 'fs_list') {
            listingReads.push(args?.path ?? '');
            if (failNextListing) {
                const message = failNextListing;
                failNextListing = null;
                throw new Error(message);
            }
            if (args?.path === '/home/deploy') {
                if (deferNextFolderRead) {
                    deferNextFolderRead = false;
                    return new Promise<FileEntry[]>((resolve) => {
                        finishFolderRead = () => {
                            finishFolderRead = undefined;
                            resolve(parentListing);
                        };
                    });
                }
                return parentListing;
            }
            const path = args?.path?.replace(/\/+$/, '');
            if (path === `${rootPath}/config`) {
                return ['environments', 'nginx'].map((name) => ({
                    ...entry(name, 'd'),
                    path: `${path}/${name}`,
                }));
            }
            if (path === `${rootPath}/config/environments`) {
                return ['development', 'production'].map((name) => ({
                    ...entry(name, 'd'),
                    path: `${path}/${name}`,
                }));
            }
            return path === rootPath ? sample : [];
        }
        if (command === 'fs_exists') {
            if (deferNextPathCheck) {
                deferNextPathCheck = false;
                return new Promise<boolean>((resolve) => {
                    finishPathCheck = () => {
                        finishPathCheck = undefined;
                        resolve(true);
                    };
                });
            }
            return !args?.path?.endsWith('/missing');
        }
        if (command === 'fs_cwd') {
            return rootPath;
        }
        if (command === 'dialog:openFile' || command === 'dialog:openDirectory') {
            return { canceled: true, filePaths: [] };
        }
        throw new Error(`Unexpected native operation in Files UI fixture: ${command}`);
    },
} as unknown as typeof window.ipcRenderer;
const { useAppStore } = await import('../../src/store/useAppStore');
const { FileManager } = await import('../../src/components/FileManager');
const { TransferPanel } = await import('../../src/components/file-manager/TransferPanel');
const { filesStoreKey } = await import('../../src/store/fileSystemSlice');
const { PluginProvider, usePlugins } = await import('../../src/context/PluginContext');
const detachTransferSafety = transferSafety?.attach(useAppStore);
if (transferSafety) {
    Object.assign(window, { filesTransferSafety: transferSafety.control });
}
Object.assign(window, {
    runFilePermissionBrowserChecks: () =>
        runFilePermissionBrowserChecks(
            permissionFixture,
            (active) => setSurfaceActive?.(active),
            accessTests,
            calls,
            windowsTests,
            administratorTests,
        ),
});
Object.assign(window, {
    runFileListingAccessBrowserChecks: () =>
        runFileListingAccessBrowserChecks(
            host,
            rootPath,
            () => {
                failNextListing = 'Sample permission denied: Permission denied';
            },
            permissionFixture.control,
            (active) => setSurfaceActive?.(active),
            calls,
        ),
});
Object.assign(window, {
    runFileEditorSaveBrowserChecks: () =>
        runFileEditorSaveBrowserChecks(
            permissionFixture.control,
            {
                provider: (defaultProvider) =>
                    useAppStore.setState((state) => ({
                        settings: {
                            ...state.settings,
                            editor: { ...state.settings.editor, defaultProvider },
                        },
                    })),
                toasts: () => useAppStore.getState().toasts,
                clearToasts: () => useAppStore.setState({ toasts: [] }),
            },
            windowsTests,
        ),
});
useAppStore.setState((state) => ({
    ...(editorTests ? { showConfirmDialog: async () => true } : {}),
    activeConnectionId: host,
    connections: [
        {
            id: host,
            name: 'Test host',
            host: 'test.invalid',
            port: 22,
            username: 'deploy',
            status: 'connected',
            homePath: '/home/deploy',
        },
    ],
    files: { [host]: sample },
    currentPath: { [host]: rootPath },
    history: { [host]: [rootPath] },
    historyIndex: { [host]: 0 },
    recentPaths: { [host]: [`${rootPath}/src`, `${rootPath}/docs`] },
    settings: {
        ...state.settings,
        iconTheme: MATERIAL_ICON_THEME_ID,
        fileManager: {
            ...state.settings.fileManager,
            defaultView: showWorkspaceChrome ? 'grid' : 'list',
            listZoom: 0,
            gridZoom: 1,
            placesCollapsed: false,
            showHiddenFiles: false,
            bookmarksByConnection: { [host]: [rootPath, `${rootPath}/config`] },
        },
    },
    updateFileManagerSettings: async (updates) => {
        settingsWrites.push(updates);
        useAppStore.setState((current) => ({
            settings: {
                ...current.settings,
                fileManager: { ...current.settings.fileManager, ...updates },
            },
        }));
    },
    refreshConnectionFiles: async (connectionId) => {
        await permissionFixture.control.awaitListingRefresh();
        return state.refreshConnectionFiles(connectionId);
    },
}));

const filesUiTest = {
    editor: editorTests ? permissionFixture.control : undefined,
    calls,
    settingsWrites,
    layoutWrites,
    listingReads,
    pluginCalls,
    surfaceActive: (active: boolean) => setSurfaceActive?.(active),
    remount: () => remountFiles?.(),
    iconPluginEnabled: async (id: string, enabled: boolean) => {
        iconPlugins = iconPlugins.map((plugin) =>
            plugin.manifest.id === id ? { ...plugin, enabled } : plugin,
        );
        return reloadIconPlugins?.();
    },
    deferFolders: () => {
        deferNextFolderRead = true;
    },
    finishFolders: () => {
        finishFolderRead?.();
    },
    foldersPending: () => Boolean(finishFolderRead),
    deferPathCheck: () => {
        deferNextPathCheck = true;
    },
    finishPathCheck: () => {
        finishPathCheck?.();
    },
    pathCheckPending: () => Boolean(finishPathCheck),
    listingSnapshot: () => {
        const state = useAppStore.getState();
        return {
            path: state.currentPath[host],
            files: state.files[host],
            history: state.history[host],
            historyIndex: state.historyIndex[host],
            loading: state.isLoading[host],
            error: state.error[host],
        };
    },
    clipboard: () => useAppStore.getState().clipboard,
    savedSettings: () => useAppStore.getState().settings,
    path: () => useAppStore.getState().currentPath[host],
    iconTheme: (iconTheme: string) =>
        useAppStore.setState((state) => ({ settings: { ...state.settings, iconTheme } })),
    preference: (
        updates: Partial<ReturnType<typeof useAppStore.getState>['settings']['fileManager']>,
    ) =>
        useAppStore.setState((state) => ({
            settings: {
                ...state.settings,
                fileManager: { ...state.settings.fileManager, ...updates },
            },
        })),
    failListing: () => {
        failNextListing = 'Sample permission denied';
    },
    manyFiles: (count = 1000) =>
        useAppStore.setState({
            files: {
                [host]: Array.from({ length: count }, (_, i) =>
                    entry(`file-${String(i).padStart(4, '0')}.ts`),
                ),
            },
        }),
    gridAlignmentFiles: (count: number) =>
        useAppStore.setState({
            files: {
                [host]: Array.from({ length: count }, (_, index) =>
                    entry(
                        index === 0
                            ? 'antigravity-server'
                            : index % 3 === 0
                              ? `folder-${index}-with-a-long-name`
                              : `file-${index}-with-a-long-name.ts`,
                        index % 3 === 0 ? 'd' : '-',
                    ),
                ),
            },
        }),
    marqueeFiles: () =>
        useAppStore.setState({
            files: {
                [host]: Array.from({ length: 31 }, (_, i) =>
                    entry(`file-${String(i).padStart(4, '0')}.ts`),
                ),
            },
        }),
    restore: () =>
        useAppStore.setState((state) => ({
            files: { ...state.files, [host]: sample },
            currentPath: { ...state.currentPath, [host]: rootPath },
            error: { ...state.error, [host]: null },
        })),
    longNames: () =>
        useAppStore.setState({
            files: {
                [host]: [
                    entry(`project-${'long-filename-'.repeat(20)}.ts`),
                    entry('odd "quote" [draft] 🦄.txt'),
                ],
            },
        }),
    breadcrumbPath: (path: string) =>
        useAppStore.setState({ files: { [host]: [] }, currentPath: { [host]: path } }),
    twoPanes: () => {
        const key = filesStoreKey(host, 'peer');
        useAppStore.setState((state) => ({
            files: { ...state.files, [key]: sample },
            currentPath: { ...state.currentPath, [key]: rootPath },
        }));
        root.render(
            <FixtureProviders>
                {showWorkspaceChrome ? (
                    <FilesWorkspacePreview peer />
                ) : (
                    <main style={{ height: '100vh', display: 'flex' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <FileManager
                                connectionId={host}
                                surface="pane"
                                active
                            />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <FileManager
                                connectionId={host}
                                instanceId="peer"
                                surface="pane"
                                active
                            />
                        </div>
                    </main>
                )}
            </FixtureProviders>,
        );
    },
};
Object.assign(window, { filesUiTest });

declare global {
    interface Window {
        filesUiTest: typeof filesUiTest;
        filesTransferSafety: ReturnType<typeof createTransferSafetyFixture>['control'];
        runFolderSizeBrowserChecks: () => ReturnType<typeof runFolderSizeBrowserChecks>;
        runFolderSizeRenderChecks: () => ReturnType<typeof runFolderSizeRenderChecks>;
        runFilePermissionBrowserChecks: () => ReturnType<typeof runFilePermissionBrowserChecks>;
        runFileListingAccessBrowserChecks: () => ReturnType<
            typeof runFileListingAccessBrowserChecks
        >;
        runFileEditorSaveBrowserChecks: () => ReturnType<typeof runFileEditorSaveBrowserChecks>;
    }
}

const root = createRoot(document.getElementById('root')!);

/** Keep a real Files instance mounted when its workspace surface is hidden. */
function StandaloneFilesPreview() {
    const [active, setActive] = useState(true);
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
        remountFiles = () => setGeneration((value) => value + 1);
        setSurfaceActive = setActive;
        return () => {
            setSurfaceActive = undefined;
            remountFiles = undefined;
        };
    }, []);
    return (
        <main style={{ height: '100vh', display: 'flex' }}>
            <div
                className="flex min-h-0 min-w-0 flex-1"
                style={{ display: active ? 'flex' : 'none' }}
            >
                <FileManager
                    key={generation}
                    connectionId={transferSafety ? undefined : host}
                    surface="pane"
                    active={active}
                />
            </div>
            {transferSafety && <TransferReceiptPreview />}
        </main>
    );
}

/** Show the production receipt surface on demand without changing browsing test interactions. */
function TransferReceiptPreview() {
    const indicatorRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                ref={indicatorRef}
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="fixed bottom-4 right-4 z-30 rounded bg-app-panel p-2 text-xs"
            >
                Transfer receipts
            </button>
            {open && (
                <TransferPanel
                    indicatorRef={indicatorRef}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}

function RegistryProbe() {
    const registry = usePlugins();
    useEffect(() => {
        reloadIconPlugins = registry.reloadPlugins;
        return () => {
            reloadIconPlugins = undefined;
        };
    }, [registry.reloadPlugins]);
    return null;
}

function FixtureProviders({ children }: { children: ReactNode }) {
    return (
        <TooltipProvider>
            <PluginProvider>
                <RegistryProbe />
                {children}
            </PluginProvider>
        </TooltipProvider>
    );
}

/** Compose production sidebar shells and Files under the same boundary as MainLayout. */
function FilesWorkspacePreview({ peer = false }: { peer?: boolean }) {
    const [leftOpen, setLeftOpen] = useState(false);
    const [rightOpen, setRightOpen] = useState(false);
    const [leftMounted, setLeftMounted] = useState(true);
    const [leftWidth, setLeftWidth] = useState(288);
    const [rightWidth, setRightWidth] = useState(300);
    return (
        <main
            className="bg-app-bg text-app-text"
            style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
        >
            <nav
                aria-label="Preview layout controls"
                className="flex shrink-0 gap-4 border-b border-app-border px-3 py-2 text-xs"
            >
                <button onClick={() => setLeftOpen((open) => !open)}>
                    {leftOpen ? 'Collapse' : 'Expand'} main sidebar
                </button>
                <button onClick={() => setRightOpen((open) => !open)}>
                    {rightOpen ? 'Collapse' : 'Expand'} tools sidebar
                </button>
                <button onClick={() => setLeftMounted((mounted) => !mounted)}>
                    {leftMounted ? 'Remove' : 'Add'} main sidebar
                </button>
            </nav>
            <LayoutMotionScope>
                <div className="flex min-h-0 min-w-0 flex-1">
                    {leftMounted && (
                        <SidebarChrome
                            position="left"
                            collapsed={!leftOpen}
                            savedWidth={leftWidth}
                            onResize={setLeftWidth}
                            landmarkLabel="Main sidebar"
                            resizeLabel="Resize main sidebar"
                        >
                            <SidebarContent className="p-4 text-sm">Hosts</SidebarContent>
                        </SidebarChrome>
                    )}
                    <div
                        className="flex min-h-0 min-w-0 flex-1"
                        data-files-workspace-preview
                    >
                        <div className="flex min-h-0 min-w-0 flex-1">
                            <FileManager
                                connectionId={host}
                                surface="pane"
                                active
                            />
                        </div>
                        {peer && (
                            <div className="flex min-h-0 min-w-0 flex-1">
                                <FileManager
                                    connectionId={host}
                                    instanceId="peer"
                                    surface="pane"
                                    active
                                />
                            </div>
                        )}
                    </div>
                    <SidebarChrome
                        position="right"
                        collapsed={!rightOpen}
                        savedWidth={rightWidth}
                        onResize={setRightWidth}
                        landmarkLabel="Tools sidebar"
                        resizeLabel="Resize tools sidebar"
                    >
                        <SidebarContent className="p-4 text-sm">Tools</SidebarContent>
                    </SidebarChrome>
                </div>
            </LayoutMotionScope>
        </main>
    );
}

root.render(
    <FixtureProviders>
        {showWorkspaceChrome ? <FilesWorkspacePreview /> : <StandaloneFilesPreview />}
    </FixtureProviders>,
);
import.meta.hot?.dispose(() => {
    detachTransferSafety?.();
    root.unmount();
});
