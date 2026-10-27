import type { createFolderSizeFixture } from '../fixtures/folderSizes';

declare global {
    var filesRowRenders: Record<string, number> | undefined;
}

const settle = () =>
    new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
const wait = async (predicate: () => unknown) => {
    for (let i = 0; i < 120; i++) {
        if (predicate()) {
            return;
        }
        await settle();
    }
    throw new Error('Folder-size UI did not settle');
};
const button = (label: string) =>
    document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!;
const row = (name: string) =>
    document.querySelector<HTMLElement>('[data-file-name="' + name + '"]')!;
const properties = () => document.querySelector('[aria-label="File properties"]');
const size = () => properties()?.querySelector('[data-folder-size-state]');
const closeProperties = async () => {
    button('Hide properties').click();
    await settle();
};
const propertyAction = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="File properties"] button')].find(
        (node) => node.textContent === label,
    )!;

/** Properties is the sole scan owner; exercise the real lifecycle with deferred native replies. */
export async function runFolderSizeBrowserChecks(
    control: ReturnType<typeof createFolderSizeFixture>['control'],
) {
    const passed: string[] = [];
    const check = (label: string, value: unknown) => {
        if (!value) {
            throw new Error(label);
        }
        passed.push(label);
    };
    const { useAppStore } = await import('../../../src/store/useAppStore');
    const host = useAppStore.getState().activeConnectionId!;
    const before = useAppStore.getState();
    const listing = before.files[host];
    const path = before.currentPath[host];
    const reads = () =>
        control.calls.filter((call) => call.command === 'fs_folder_size_calculate').length;
    const open = async (name = 'assets') => {
        row(name).click();
        await settle();
        button('Inspect selection').click();
        await wait(
            () =>
                control.pending() === 1 &&
                size()?.getAttribute('data-folder-size-state') === 'calculating',
        );
    };
    await new Promise((resolve) => setTimeout(resolve, 350));
    check('browsing starts no folder-size IPC with older settings', control.calls.length === 0);
    // A removed saved flag must not reactivate the former background queue.
    useAppStore.setState((state) => ({
        settings: {
            ...state.settings,
            fileManager: { ...state.settings.fileManager, ...{ showFolderSizes: true } },
        },
    }));
    row('assets').click();
    button('Grid view').click();
    await settle();
    button('List view').click();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    check(
        'legacy enabled preference, selection and view changes cannot start scans',
        control.calls.length === 0,
    );
    const selectionText = document.querySelector('.files-summary-count')?.textContent ?? '';
    check(
        'folder-only selection shows counts without unavailable size text',
        selectionText.includes('1 selected') && !selectionText.includes('Size unavailable'),
    );
    check(
        'selection hint omits irrelevant zero counts and verbose explanations',
        selectionText.includes('Folder sizes are shown in Properties.') &&
            !selectionText.includes('0 files') &&
            !selectionText.includes('0 links') &&
            !selectionText.includes('guaranteed lower bound'),
    );
    button('View').click();
    await settle();
    check(
        'View no longer offers Show folder sizes',
        ![...document.querySelectorAll('[role="menuitemcheckbox"]')].some((node) =>
            node.textContent?.includes('Show folder sizes'),
        ),
    );
    button('View').click();
    await settle();
    row('package.json').click();
    await settle();
    button('Inspect selection').click();
    await settle();
    check(
        'regular-file Properties uses listing metadata without a folder scan',
        reads() === 0 && properties()?.textContent?.includes('1.8 KB'),
    );
    await closeProperties();
    await open();
    check(
        'opening a folder Properties starts only that folder',
        reads() === 1 && control.calls.at(-1)?.path === path + '/assets',
    );
    check(
        'loading belongs only to Properties, not the listing',
        size()?.querySelector('svg') &&
            !document.querySelector('[role="listbox"] [data-folder-size-state]'),
    );
    const loadingStatus = size()?.querySelector('[role="status"]');
    check(
        'loading has screen-reader text without a visible calculating label',
        loadingStatus?.textContent === 'Calculating…' &&
            loadingStatus.classList.contains('sr-only') &&
            getComputedStyle(loadingStatus).position === 'absolute' &&
            getComputedStyle(loadingStatus).overflow === 'hidden' &&
            size()?.querySelector('svg')?.getAttribute('aria-hidden') === 'true',
    );
    const rendersBefore = { ...globalThis.filesRowRenders };
    control.finish({ bytes: '853750579' });
    await wait(() => size()?.getAttribute('data-folder-size-state') === 'finished');
    await settle();
    check(
        'completed size appears in Properties without an info button',
        properties()?.textContent?.includes('814.2 MB') &&
            !properties()?.querySelector('[aria-label="Folder-size details"]'),
    );
    check(
        'a Properties result does not render file rows, View or Places again',
        globalThis.filesRowRenders &&
            ['assets', 'config', 'package.json', '@view', '@places'].every(
                (key) =>
                    rendersBefore[key] > 0 &&
                    globalThis.filesRowRenders![key] === rendersBefore[key],
            ),
    );
    check(
        'completed commands do not send redundant cancellation',
        !control.calls.some((call) => call.command === 'fs_folder_size_cancel'),
    );
    row('config').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    await settle();
    check(
        'multi-folder Properties does not launch recursive batches or reuse another folder total',
        reads() === 1 && !size() && !properties()?.textContent?.includes('814.2 MB'),
    );
    row('assets').click();
    await wait(() => control.pending() === 1);
    control.finish({ bytes: '4096', complete: false, reason: 'Time limit reached' });
    await wait(() => size()?.getAttribute('data-folder-size-state') === 'finished');
    properties()!.querySelector<HTMLButtonElement>('[aria-label="Folder-size details"]')!.click();
    await settle();
    check(
        'partial Properties results retain one safety explanation',
        document.querySelectorAll('[role="dialog"]').length === 1 &&
            document.querySelector('[role="dialog"]')?.textContent?.includes('Time limit reached'),
    );
    check(
        'open details omit redundant instructions while preserving safety information',
        !document.querySelector('[role="dialog"]')?.textContent?.includes('Click for details') &&
            document
                .querySelector('[role="dialog"]')
                ?.textContent?.includes('Links are not followed'),
    );
    document
        .querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!
        .click();
    await settle();
    await closeProperties();
    await open();
    propertyAction('Cancel calculation').click();
    await settle();
    control.finish({ bytes: '999999' });
    await settle();
    const cancelledReads = reads();
    await new Promise((resolve) => setTimeout(resolve, 350));
    check(
        'cancel fences late data and never restarts automatically',
        reads() === cancelledReads &&
            size()?.getAttribute('data-folder-size-state') === 'cancelled',
    );
    propertyAction('Retry calculation').click();
    propertyAction('Retry calculation')?.click();
    await wait(() => control.pending() === 1);
    check('repeated retry starts one scan', reads() === cancelledReads + 1);
    control.fail('Sample scan unavailable');
    await wait(() => size()?.getAttribute('data-folder-size-state') === 'unavailable');
    const failedReads = reads();
    await new Promise((resolve) => setTimeout(resolve, 350));
    check(
        'failed scans remain retryable without an automatic retry loop',
        reads() === failedReads && propertyAction('Retry calculation'),
    );
    propertyAction('Retry calculation').click();
    await wait(() => control.pending() === 1);
    const oldId = control.calls.at(-1)?.id;
    row('config').click();
    await wait(() => control.pending() === 2);
    check(
        'selection change cancels the old Properties scan',
        control.calls.some((call) => call.command === 'fs_folder_size_cancel' && call.id === oldId),
    );
    control.finish({ bytes: '777777' });
    await settle();
    check(
        'late old-selection result cannot replace new Properties metadata',
        size()?.getAttribute('data-folder-size-state') === 'calculating' &&
            !properties()?.textContent?.includes('759.5 KB'),
    );
    control.finish({ bytes: '11' });
    await wait(() => size()?.getAttribute('aria-label') === '11 B');
    check(
        'new selection receives only its own size',
        properties()?.textContent?.includes('config') &&
            size()?.getAttribute('aria-label') === '11 B',
    );
    row('docs').click();
    await wait(() => control.pending() === 1);
    await closeProperties();
    control.finish();
    await settle();
    check(
        'closing Properties clears the result and fences late replies',
        !size() && !document.querySelector('[data-folder-size-state]'),
    );
    control.deferAdmission();
    row('assets').click();
    await settle();
    button('Inspect selection').click();
    await wait(() => control.calls.at(-1)?.command === 'fs_folder_size_begin');
    const beforeAdmission = reads();
    await closeProperties();
    control.acknowledge();
    await settle();
    check(
        'closing during admission cancels without starting a stale read',
        reads() === beforeAdmission &&
            control.pending() === 0 &&
            control.calls.at(-1)?.command === 'fs_folder_size_cancel',
    );
    await open();
    useAppStore.setState((state) => ({
        connections: state.connections.map((connection) =>
            connection.id === host ? { ...connection } : connection,
        ),
    }));
    await wait(() => control.pending() === 2);
    control.finish({ bytes: '888888' });
    await settle();
    check(
        'replaced SSH binding rejects the old scan result',
        size()?.getAttribute('data-folder-size-state') === 'calculating',
    );
    control.finish({ bytes: '22' });
    await wait(() => size()?.getAttribute('aria-label') === '22 B');
    row('config').click();
    await wait(() => control.pending() === 1);
    const previousCalls = control.calls.length;
    // The actual surface-visibility owner is exposed by the production fixture.
    (
        window as unknown as { filesUiTest: { surfaceActive: (active: boolean) => void } }
    ).filesUiTest.surfaceActive(false);
    await wait(() => control.calls.length > previousCalls);
    control.finish();
    await settle();
    check(
        'hiding the Files surface cancels its active scan',
        control.pending() === 0 && !document.querySelector('[data-folder-size-state]'),
    );
    (
        window as unknown as { filesUiTest: { surfaceActive: (active: boolean) => void } }
    ).filesUiTest.surfaceActive(true);
    await wait(() => control.pending() === 1);
    await closeProperties();
    control.finish();
    await settle();
    const afterClose = reads();
    button('Grid view').click();
    useAppStore.setState((state) => ({
        files: {
            ...state.files,
            [host]: Array.from({ length: 1000 }, (_, i) => ({
                ...listing[0],
                name: 'folder-' + i,
                path: path + '/folder-' + i,
            })),
        },
    }));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    check(
        'large virtualized grids remain metadata-only',
        reads() === afterClose &&
            document.querySelectorAll('[data-file-name]').length < 100 &&
            !document.querySelector('[data-folder-size-state]'),
    );
    check(
        'size work does not mutate directory metadata or add notification noise',
        listing.every((file) => file.type !== 'd' || file.size === 0) &&
            useAppStore.getState().toasts.length === before.toasts.length,
    );
    useAppStore.setState((state) => ({ files: { ...state.files, [host]: [...listing] } }));
    await settle();
    const pins = useAppStore.getState().settings.fileManager.bookmarksByConnection;
    useAppStore.setState((state) => ({
        settings: {
            ...state.settings,
            fileManager: {
                ...state.settings.fileManager,
                bookmarksByConnection: { ...pins, [host]: [path + '/updated-pin'] },
            },
        },
    }));
    await settle();
    check(
        'memoized Places still receives live bookmark changes',
        document.querySelector('[aria-label="File places"]')?.textContent?.includes('updated-pin'),
    );
    useAppStore.setState((state) => ({
        settings: {
            ...state.settings,
            fileManager: { ...state.settings.fileManager, bookmarksByConnection: pins },
        },
    }));
    await settle();
    const [{ StrictMode, createElement }, { createRoot }, { useFolderSizes }] = await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('../../../src/features/files/application/useFolderSizes'),
    ]);
    let observed: ReturnType<typeof useFolderSizes> | undefined;
    let probeListing = listing;
    let probeBinding = before.connections[0];
    let probeTarget = path + '/assets';
    const Probe = () => {
        observed = useFolderSizes(host, path, probeListing, probeBinding, true, probeTarget);
        return null;
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const beforeReplay = reads();
    try {
        root.render(createElement(StrictMode, null, createElement(Probe)));
        await wait(() => control.pending() === 1);
        control.finish({ bytes: '33' });
        await wait(() => observed?.state?.status === 'finished');
        check(
            'Strict Mode replay cancels old admission but completes one fresh inspection',
            reads() === beforeReplay + 1 &&
                observed?.state?.status === 'finished' &&
                observed.state.report.bytes === '33',
        );
        observed!.start();
        await wait(() => control.pending() === 1);
        observed!.cancel();
        control.finish();
        await settle();
        const cancelledProbeReads = reads();
        probeListing = [...listing];
        root.render(createElement(StrictMode, null, createElement(Probe)));
        await settle();
        probeBinding = { ...probeBinding };
        root.render(createElement(StrictMode, null, createElement(Probe)));
        await settle();
        check(
            'user cancellation survives listing and binding refreshes without restarting',
            reads() === cancelledProbeReads && observed?.state?.status === 'cancelled',
        );
        observed!.start();
        await wait(() => control.pending() === 1);
        control.fail('Owned probe failure');
        await wait(() => observed?.state?.status === 'unavailable');
        const failedProbeReads = reads();
        const staleRetry = observed!.start;
        probeListing = [...listing];
        root.render(createElement(StrictMode, null, createElement(Probe)));
        await settle();
        staleRetry();
        await settle();
        check(
            'owned failure survives refresh and a stale Retry cannot release the halt',
            reads() === failedProbeReads && observed?.state?.status === 'unavailable',
        );
        observed!.start();
        await wait(() => control.pending() === 1);
        check('explicit Retry clears the same-target halt', reads() === failedProbeReads + 1);
        observed!.cancel();
        await settle();
        probeTarget = path + '/config';
        root.render(createElement(StrictMode, null, createElement(Probe)));
        await wait(() => control.pending() === 2);
        check(
            'changing the target releases a user-cancelled halt automatically',
            observed?.state?.status === 'calculating',
        );
        control.fail('Old selection failure');
        await settle();
        check(
            'a superseded failure cannot halt the new target',
            observed?.state?.status === 'calculating',
        );
        probeListing = [...listing];
        root.render(createElement(StrictMode, null, createElement(Probe)));
        await wait(() => control.pending() === 2);
        control.finish();
        control.finish({ bytes: '44' });
        await wait(() => observed?.state?.status === 'finished');
        check(
            'target changes and cleanup still allow fresh owned scans',
            observed?.state?.status === 'finished' && observed.state.report.bytes === '44',
        );
    } finally {
        root.unmount();
        container.remove();
    }
    return passed;
}

/** Repeat only explicit Properties inspections; measure the existing memo boundaries. */
export async function runFolderSizeRenderChecks(
    control: ReturnType<typeof createFolderSizeFixture>['control'],
) {
    row('assets').click();
    await settle();
    button('Inspect selection').click();
    await wait(
        () =>
            control.pending() === 1 &&
            size()?.getAttribute('data-folder-size-state') === 'calculating',
    );
    await settle();
    const before = { ...globalThis.filesRowRenders };
    control.finish();
    await wait(() => size()?.getAttribute('data-folder-size-state') === 'finished');
    await settle();
    const delta = Object.fromEntries(
        Object.entries(globalThis.filesRowRenders ?? {}).map(([name, count]) => [
            name,
            count - (before[name] ?? 0),
        ]),
    );
    await closeProperties();
    if (control.pending()) {
        throw new Error('Properties inspection retained a pending native request');
    }
    return delta;
}
