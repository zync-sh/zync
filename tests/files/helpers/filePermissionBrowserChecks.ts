import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { useFilePermissionEditor } from '../../../src/features/files/application/useFilePermissionEditor';
import type { createPermissionFixture } from '../fixtures/permissions';

/** Exercise observed SSH denials through the real listing store and clipboard UI. */
export async function runFileListingAccessBrowserChecks(
    host: string,
    directory: string,
    failNext: () => void,
    control: ReturnType<typeof createPermissionFixture>['control'],
    surfaceActive: (active: boolean) => void,
    nativeCalls: readonly string[],
): Promise<string[]> {
    const { useAppStore } = await import('../../../src/store/useAppStore');
    const passed: string[] = [];
    const check = (label: string, value: unknown) => {
        if (!value) {
            throw new Error(label);
        }
        passed.push(label);
    };
    const settle = () =>
        new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
    const row = (name: string) =>
        document.querySelector<HTMLElement>(`[data-file-name="${name}"]`)!;
    const menuItem = (name: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
            (element) => element.textContent?.trim() === name,
        )!;
    const shortcut = async (name: string, key: 'c' | 'x') => {
        const element = row(name);
        element.click();
        await settle();
        element.focus();
        element.dispatchEvent(
            new KeyboardEvent('keydown', {
                key,
                code: key === 'c' ? 'KeyC' : 'KeyX',
                ctrlKey: true,
                bubbles: true,
            }),
        );
        await settle();
    };
    const store = useAppStore.getState();
    const previousFile = store.files[host].find((file) => file.name === 'README.md')!;
    store.setClipboard([previousFile], 'previous-fixture', '/previous', 'copy');
    const previousClipboard = useAppStore.getState().clipboard;
    const initialChecks = control.copyChecks.length;
    row('README.md').click();
    await settle();
    check(
        'browsing and selecting an SSH source do not trigger Copy preflight',
        control.copyChecks.length === initialChecks,
    );
    failNext();
    await store.loadFiles(host, `${directory}/assets`);
    await settle();
    check(
        'a denied SSH child retains the parent listing and exact failed-read path',
        useAppStore.getState().currentPath[host] === directory &&
            useAppStore.getState().listingReadDenial[host]?.path === `${directory}/assets`,
    );
    await shortcut('assets', 'c');
    check(
        'Copy after an actual SSH listing denial preserves the previous clipboard and explains access',
        useAppStore.getState().clipboard === previousClipboard &&
            useAppStore
                .getState()
                .toasts.some(
                    (toast) =>
                        toast.id === 'files-clipboard-access' &&
                        toast.message.includes('Copy is unavailable'),
                ),
    );
    row('assets').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await settle();
    check(
        'the denied folder menu disables Copy but does not confuse read denial with move rights',
        menuItem('Copy').disabled && !menuItem('Cut').disabled,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    await shortcut('README.md', 'c');
    check(
        'a sibling remains copyable despite the other folder error banner',
        useAppStore.getState().clipboard?.files[0].path === previousFile.path,
    );
    check(
        'clipboard feedback describes a pending copy, not a completed transfer',
        useAppStore
            .getState()
            .toasts.some((toast) => toast.message.includes('ready to copy. Choose Paste')) &&
            !useAppStore.getState().toasts.some((toast) => /^Copied \d+ item/.test(toast.message)),
    );
    await shortcut('assets', 'x');
    check(
        'a denied content read does not block same-endpoint Cut intent',
        useAppStore.getState().clipboard?.op === 'cut' &&
            useAppStore.getState().clipboard?.files[0].path === `${directory}/assets`,
    );
    const originalConnection = useAppStore
        .getState()
        .connections.find((connection) => connection.id === host)!;
    useAppStore.setState((state) => ({
        connections: state.connections.map((connection) =>
            connection.id === host ? { ...connection } : connection,
        ),
    }));
    await settle();
    await shortcut('assets', 'c');
    check(
        'replacing the connection invalidates its prior observed denial',
        useAppStore.getState().clipboard?.op === 'copy',
    );
    // Restore this fixture's account identity, then explicitly retry the denied read.
    useAppStore.setState((state) => ({
        connections: state.connections.map((connection) =>
            connection.id === host ? originalConnection : connection,
        ),
    }));
    await store.loadFiles(host, `${directory}/assets`);
    await settle();
    await store.loadFiles(host, directory);
    await settle();
    await shortcut('assets', 'c');
    check(
        'a successful fresh listing removes the observed denial and Copy works again',
        useAppStore.getState().listingReadDenial[host] === null &&
            useAppStore.getState().clipboard?.files[0].path === `${directory}/assets`,
    );

    store.setClipboard([previousFile], 'previous-fixture', '/previous', 'copy');
    const beforeCheck = useAppStore.getState().clipboard;
    const historyBefore = useAppStore.getState().notificationHistory.length;
    useAppStore.setState({ toasts: [] });
    control.setCopyError('Cannot check Copy source: Permission denied');
    await shortcut('README.md', 'c');
    check(
        'Copy checks an unreadable SSH file without opening it first and preserves the clipboard',
        control.copyChecks.at(-1)?.[0] === previousFile.path &&
            useAppStore.getState().clipboard === beforeCheck,
    );
    check(
        'preflight denial explains access without announcing ready-to-copy or saving notification history',
        useAppStore
            .getState()
            .toasts.some((toast) => toast.message.includes("don't have permission to read")) &&
            !useAppStore
                .getState()
                .toasts.some((toast) => toast.message.includes('ready to copy')) &&
            useAppStore.getState().notificationHistory.length === historyBefore,
    );
    control.setCopyError('session closed');
    row('README.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await settle();
    menuItem('Copy').click();
    await settle();
    check(
        'context Copy uses the same preflight and distinguishes connection errors from denied permissions',
        useAppStore.getState().clipboard === beforeCheck &&
            useAppStore
                .getState()
                .toasts.some(
                    (toast) => toast.message === 'Could not check Copy access. session closed',
                ),
    );

    control.setCopyError(null);
    control.deferCopy();
    await shortcut('README.md', 'c');
    const count = control.copyChecks.length;
    for (let attempt = 0; attempt < 3; attempt++) {
        row('README.md').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true }),
        );
    }
    await settle();
    check(
        'repeated Copy shortcuts share one pending check and do not publish clipboard intent early',
        control.copyPending() &&
            control.copyChecks.length === count &&
            useAppStore.getState().clipboard === beforeCheck,
    );
    row('README.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await settle();
    check(
        'the Copy menu explains its pending access check',
        menuItem('Copy').disabled &&
            menuItem('Copy').getAttribute('aria-description') === 'Checking read access…',
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    check(
        'slow preflight gives one silent temporary checking message without inbox history',
        useAppStore.getState().toasts.filter((toast) => toast.message === 'Checking read access…')
            .length === 1 && useAppStore.getState().notificationHistory.length === historyBefore,
    );
    control.finishCopy();
    await settle();
    check(
        'a successful explicit check publishes the captured Copy selection',
        useAppStore.getState().clipboard?.files[0].path === previousFile.path &&
            useAppStore.getState().clipboard !== beforeCheck,
    );
    check(
        'finishing the preflight removes its pending feedback',
        !useAppStore.getState().toasts.some((toast) => toast.message === 'Checking read access…'),
    );

    for (const changed of ['selection', 'connection', 'clipboard', 'inactive', 'cut'] as const) {
        const connection = useAppStore.getState().connections.find((item) => item.id === host)!;
        control.deferCopy();
        await shortcut('README.md', 'c');
        const before = useAppStore.getState().clipboard;
        if (changed === 'selection') {
            row('assets').click();
        }
        if (changed === 'connection') {
            useAppStore.setState((state) => ({
                connections: state.connections.map((item) =>
                    item.id === host ? { ...item } : item,
                ),
            }));
        }
        if (changed === 'clipboard') {
            store.setClipboard([previousFile], 'another-pane', '/elsewhere', 'copy');
        }
        if (changed === 'inactive') {
            surfaceActive(false);
        }
        if (changed === 'cut') {
            await shortcut('README.md', 'x');
        }
        await settle();
        const expected = useAppStore.getState().clipboard;
        control.finishCopy();
        await settle();
        check(
            `a late Copy check cannot overwrite a newer ${changed} context`,
            useAppStore.getState().clipboard === expected &&
                (changed !== 'cut' || expected?.op === 'cut') &&
                (changed !== 'selection' || expected === before),
        );
        if (changed === 'connection') {
            useAppStore.setState((state) => ({
                connections: state.connections.map((item) =>
                    item.id === host ? connection : item,
                ),
            }));
        }
        if (changed === 'inactive') {
            surfaceActive(true);
        }
        await settle();
    }
    const originalFiles = useAppStore.getState().files[host];
    const largeSelection = Array.from({ length: 129 }, (_, index) => ({
        ...previousFile,
        name: `copy-${index}.txt`,
        path: `${directory}/copy-${index}.txt`,
    }));
    useAppStore.setState((state) => ({ files: { ...state.files, [host]: largeSelection } }));
    await settle();
    const selectAll = async () => {
        const listing = document.querySelector<HTMLElement>('[role="listbox"]')!;
        listing.focus();
        listing.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }),
        );
        await settle();
        listing.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true }),
        );
        await settle();
    };
    const checksBeforeBatch = control.copyChecks.length;
    await selectAll();
    check(
        'large explicit selections use bounded serial batches without omitting sources',
        JSON.stringify(control.copyChecks.slice(checksBeforeBatch).map((paths) => paths.length)) ===
            '[64,64,1]' && useAppStore.getState().clipboard?.files.length === 129,
    );
    const previousBatchClipboard = useAppStore.getState().clipboard;
    const checksBeforeFailure = control.copyChecks.length;
    control.deferCopy();
    await selectAll();
    control.setCopyError('Permission denied');
    control.finishCopy();
    await settle();
    check(
        'a later batch denial preserves the entire previous clipboard and stops remaining checks',
        control.copyChecks.length === checksBeforeFailure + 2 &&
            useAppStore.getState().clipboard === previousBatchClipboard,
    );
    control.setCopyError(null);
    useAppStore.setState((state) => ({ files: { ...state.files, [host]: originalFiles } }));
    await settle();
    check(
        'Copy preflight never invokes a content read or a transfer',
        !nativeCalls.some((command) =>
            [
                'fs_read_file',
                'fs_write_file',
                'fs_copy',
                'fs_copy_batch',
                'fs_transfer',
                'fs_transfer_file',
                'fs_rename',
                'fs_rename_batch',
                'sftp_put',
                'sftp_get',
                'sftp_copy_to_server',
                'sftp_download_as_zip',
                'sftp:put',
                'sftp:get',
                'sftp:copyToServer',
                'sftp:downloadAsZip',
                'ssh_exec',
            ].includes(command),
        ),
    );
    useAppStore.setState({ toasts: [] });
    store.clearClipboard();
    return passed;
}

/** Typed regressions in the real FileManager fixture; the runner only supplies a
 * browser. No production implementation is copied into this check module.
 */
export async function runFilePermissionBrowserChecks(
    fixture: ReturnType<typeof createPermissionFixture>,
    surfaceActive: (active: boolean) => void,
    accessOnly = false,
    nativeCalls: string[] = [],
    windowsOnly = false,
    administratorOnly = false,
): Promise<string[]> {
    const passed: string[] = [];
    const check = (label: string, value: unknown) => {
        if (!value) {
            throw new Error(label);
        }
        passed.push(label);
    };
    const until = async (predicate: () => unknown) => {
        const deadline = performance.now() + 10_000;
        while (!predicate()) {
            if (performance.now() > deadline) {
                throw new Error(
                    `Permission UI did not settle: ${document.body.innerText.slice(-1600)}`,
                );
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
    };
    const button = (label: string): HTMLButtonElement => {
        const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (element) =>
                (element.getAttribute('aria-label') || element.textContent?.trim()) === label,
        );
        if (!result) {
            throw new Error(`Missing button ${label}: ${document.body.innerText.slice(-1600)}`);
        }
        return result;
    };
    const select = async (name: string) => {
        await until(() => document.querySelector(`[data-file-name="${name}"]`));
        const element = document.querySelector<HTMLElement>(`[data-file-name="${name}"]`);
        if (!element) {
            throw new Error(`Missing file ${name}`);
        }
        element.click();
        await until(() => element.getAttribute('aria-selected') === 'true');
    };
    const inspector = () => document.querySelector<HTMLElement>('[aria-label="File properties"]')!;
    const editReady = () =>
        [...document.querySelectorAll<HTMLButtonElement>('button')].some(
            (el) => el.textContent?.trim() === 'Edit permissions' && !el.disabled,
        );
    const setOctal = async (value: string) => {
        const input = inspector().querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await until(() => input.value === value);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const refresh = async () => {
        const before = fixture.control.reads.length;
        button('Refresh').click();
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        await until(
            () =>
                fixture.control.reads.length > before &&
                !inspector().textContent?.includes('Reading permissions…'),
        );
    };

    await until(() => document.querySelector('[role="listbox"]'));
    if (administratorOnly) {
        const control = fixture.control;
        const settle = () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
        const start = async () => {
            const details = [...inspector().querySelectorAll('details')].find(
                (element) =>
                    element.querySelector('summary')?.textContent === 'Administrator permissions',
            )!;
            details.open = true;
            button('Review administrator edit…').click();
            await settle();
        };
        const password = () =>
            inspector().querySelector<HTMLInputElement>('input[type="password"]');
        const authenticate = async () => {
            const input = password()!;
            input.value = 'fixture-password-not-retained';
            input.form!.requestSubmit();
            await settle();
            check(
                'submitted password is immediately removed from the native input',
                input.value === '',
            );
        };
        await select('README.md');
        button('Inspect selection').click();
        await until(editReady);
        check(
            'ordinary Properties never starts sudo automatically',
            control.adminStarts.length === 0 && control.adminAuthentications() === 0,
        );
        control.deferAdmin();
        await start();
        button('Review administrator edit…').click();
        await until(control.adminPending);
        check(
            'explicit administrator preparation is single-flight and does not mutate',
            control.adminStarts.length === 1 && control.adminWrites.length === 0,
        );
        control.finishAdmin();
        await until(password);
        check(
            'password is transient and the host-filesystem boundary is explained before review',
            password()?.autocomplete === 'off' &&
                inspector().textContent?.includes('not a proven SFTP object mapping') &&
                !inspector().querySelector('input[type="checkbox"]'),
        );
        await authenticate();
        await until(() => Boolean(inspector().querySelector('[aria-label="Owner read"]')));
        check(
            'authentication only prepares fresh host metadata, not a chmod',
            control.adminAuthentications() === 1 &&
                control.adminWrites.length === 0 &&
                inspector().textContent?.includes('UID 9999') &&
                inspector().textContent?.includes('SSH host filesystem') &&
                inspector().textContent?.includes('400 → 400'),
        );
        await setOctal('600');
        control.deferAdmin();
        button('Apply').click();
        button('Apply').click();
        await until(control.adminPending);
        check(
            'administrator Apply uses one prepared review token and ordinary masks, not SFTP mutation',
            control.adminWrites.length === 1 &&
                control.adminWrites[0].setBits === 0o200 &&
                control.adminWrites[0].clearBits === 0 &&
                control.writes.length === 0,
        );
        control.finishAdmin();
        await until(() => inspector().textContent?.includes('Administrator mode change verified'));
        check(
            'verified administrator result stays in explicit host context until Refresh',
            inspector().textContent?.includes('SSH host filesystem') &&
                !inspector().querySelector('input') &&
                !button('Refresh').disabled,
        );
        await refresh();
        await until(editReady);
        check(
            'Refresh returns to ordinary-account SFTP metadata without another elevation',
            !inspector().textContent?.includes('Administrator review ·') &&
                control.adminStarts.length === 1,
        );

        await start();
        await until(password);
        const cancelledBefore = control.adminCancels.length;
        button('Cancel review').click();
        await settle();
        check(
            'cancelling a password prompt neither relabels SFTP metadata as host metadata nor leaves a secret field',
            !password() &&
                !inspector().textContent?.includes('Administrator review ·') &&
                control.adminCancels.length === cancelledBefore + 1,
        );
        await refresh();
        await until(editReady);
        control.requestAdminPassword(false);
        await start();
        await until(() => Boolean(inspector().querySelector('[aria-label="Owner read"]')));
        check(
            'cached or passwordless sudo skips the secret form but still requires review and Apply',
            !password() && control.adminAuthentications() === 1 && control.adminWrites.length === 1,
        );
        const beforeDiscard = control.adminCancels.length;
        button('Discard draft').click();
        await settle();
        check(
            'discarding the prepared review cancels its capability without chmod',
            control.adminCancels.length === beforeDiscard + 1 && control.adminWrites.length === 1,
        );
        await refresh();
        await until(editReady);

        control.requestAdminPassword(true);
        await start();
        await until(password);
        control.deferAdmin();
        await authenticate();
        await until(control.adminPending);
        await select('package.json');
        control.finishAdmin();
        await until(editReady);
        check(
            'a late authenticated preview cannot bind to another selected file',
            inspector().textContent?.includes('package.json') &&
                !inspector().textContent?.includes('Administrator review ·') &&
                !inspector().querySelector('input'),
        );
        control.requestAdminPassword(false);
        control.malformedAdmin(true);
        await start();
        await until(() =>
            inspector().textContent?.includes('did not match the reviewed host path'),
        );
        check(
            'a missing prepared review token fails closed without Apply',
            !inspector().querySelector('input') && control.adminWrites.length === 1,
        );
        control.malformedAdmin(false);
        await refresh();
        await until(editReady);
        control.requestAdminPassword(true);
        await start();
        await until(password);
        control.failAdmin(true);
        await authenticate();
        await until(() => inspector().textContent?.includes('authentication refused'));
        check(
            'refused authentication is inline and never automatically replayed',
            !password() && control.adminAuthentications() === 3 && control.adminWrites.length === 1,
        );
        control.failAdmin(false);
        await refresh();
        await until(editReady);
        control.requestAdminPassword(false);
        await start();
        await until(() => Boolean(inspector().querySelector('[aria-label="Owner read"]')));
        await setOctal('400');
        control.failAdmin(true);
        button('Apply').click();
        await until(() => inspector().textContent?.includes('result is unknown'));
        check(
            'uncertain administrator Apply requires inspection, without replay or claiming rollback',
            control.adminWrites.length === 2 && button('Apply').disabled,
        );
        check(
            'administrator flow never invokes a terminal, generic exec, root SFTP or content write',
            control.writes.length === 0 &&
                control.editorWrites.length === 0 &&
                nativeCalls.every(
                    (command) =>
                        !['terminal:write', 'ssh_exec', 'ssh:exec', 'fs_write_file'].includes(
                            command,
                        ),
                ),
        );
        return passed;
    }
    if (windowsOnly) {
        const control = fixture.control;
        const ready = () =>
            [...document.querySelectorAll<HTMLButtonElement>('button')].some(
                (element) =>
                    element.textContent?.trim() === 'Windows permissions…' && !element.disabled,
            );
        const settle = () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
        await select('README.md');
        button('Inspect selection').click();
        await until(ready);
        check(
            'Windows uses account/ACL terminology, not missing Unix IDs or synthetic octal',
            inspector().textContent?.includes('Windows accounts and ACLs') &&
                !inspector().textContent?.includes('UID') &&
                !inspector().textContent?.includes('Current mode'),
        );
        control.deferSystemEditor();
        button('Windows permissions…').click();
        button('Windows permissions…').click();
        await until(control.systemEditorPending);
        check(
            'Windows settings invocation is single-flight and captured to the selected path',
            control.systemEditorOpens.length === 1 &&
                control.systemEditorOpens[0].path.endsWith('/README.md') &&
                button('Windows permissions…').disabled,
        );
        control.finishSystemEditor();
        await until(() =>
            inspector().textContent?.includes(
                'Opening settings does not mean permissions changed.',
            ),
        );
        check(
            'invocation is not a save acknowledgement and requires an explicit recheck',
            button('Windows permissions…').disabled &&
                control.writes.length === 0 &&
                control.editorWrites.length === 0,
        );
        await refresh();
        await until(ready);
        check(
            'Refresh checks metadata without reopening Windows settings',
            control.systemEditorOpens.length === 1,
        );
        control.deferSystemEditor();
        button('Windows permissions…').click();
        await until(control.systemEditorPending);
        await select('package.json');
        control.finishSystemEditor();
        await until(ready);
        check(
            'late native replies do not claim a different selection opened or changed',
            inspector().textContent?.includes('package.json') &&
                !inspector().textContent?.includes('Windows Properties opened.'),
        );
        control.failSystemEditor(true);
        button('Windows permissions…').click();
        await until(() =>
            inspector().textContent?.includes('Simulated Windows settings invocation failed'),
        );
        const attempts = control.systemEditorOpens.length;
        await settle();
        check(
            'native failure is inline, does not retry and keeps recheck available',
            button('Windows permissions…').disabled &&
                !button('Refresh').disabled &&
                control.systemEditorOpens.length === attempts,
        );
        control.failSystemEditor(false);
        control.setSystemEditor(false);
        await refresh();
        check(
            'unqualified Windows endpoints cannot launch a fabricated permission editor',
            button('Edit permissions').disabled &&
                inspector().textContent?.includes('access-control lists'),
        );
        control.setSystemEditor(true);
        control.setKind('Symlink');
        await refresh();
        check(
            'links cannot acquire the native editor capability',
            button('Edit permissions').disabled,
        );
        check(
            'Windows handoff never calls chmod, content writing or terminal commands',
            control.writes.length === 0 &&
                control.editorWrites.length === 0 &&
                nativeCalls.every(
                    (command) =>
                        !['fs_permissions_apply', 'fs_write_file', 'terminal:write'].includes(
                            command,
                        ),
                ),
        );
        return passed;
    }
    if (accessOnly) {
        const control = fixture.control;
        const { useAppStore } = await import('../../../src/store/useAppStore');
        const menuItem = (label: string) =>
            [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
                (element) => element.textContent?.trim() === label,
            )!;
        const settle = () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
        const reload = async () => {
            const before = control.accessReads.length;
            if (
                [...document.querySelectorAll('button')].some(
                    (element) => element.textContent === 'Check access again',
                )
            ) {
                button('Check access again').click();
            } else {
                button('Folder actions').click();
                await until(() => menuItem('Reload'));
                menuItem('Reload').click();
            }
            await until(() => control.accessReads.length > before);
            await settle();
        };
        await select('README.md');
        const previousFile = useAppStore
            .getState()
            .files.local.find((file) => file.name === 'README.md')!;
        useAppStore
            .getState()
            .setClipboard([previousFile], 'previous-fixture', '/previous', 'copy');
        const previousClipboard = useAppStore.getState().clipboard;
        const historyBeforeClipboardDenial = useAppStore.getState().notificationHistory.length;
        control.setAccess({
            directoryAccess: { createFile: false, createFolder: false },
            targetAccess: { read: false, write: false, rename: false, delete: false },
        });
        await reload();
        await until(() => document.body.textContent?.includes('Unavailable for this account'));
        check(
            'native denial names its unavailable actions without a toast',
            document.body.textContent?.includes(
                'Create files, Create folders, Read, Save, Rename, Delete',
            ),
        );
        button('New').click();
        await until(() => menuItem('New file'));
        check(
            'toolbar New applies independent create guards',
            menuItem('New file').disabled && menuItem('New folder').disabled,
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        button('Upload').click();
        await until(() => menuItem('Upload files'));
        check(
            'upload menu uses the same create guards',
            menuItem('Upload files').disabled && menuItem('Upload folder').disabled,
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        const row = document.querySelector<HTMLElement>('[data-file-name="README.md"]')!;
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await until(() => menuItem('Rename'));
        check(
            'context Open With, Download, Rename and Delete match the handler guards',
            menuItem('Open With…').disabled &&
                menuItem('Download').disabled &&
                menuItem('Rename').disabled &&
                menuItem('Delete').disabled,
        );
        check(
            'Copy and Cut are disabled with distinct accessible source-denial explanations',
            menuItem('Copy').disabled &&
                menuItem('Cut').disabled &&
                menuItem('Copy').getAttribute('aria-description')?.includes('permission to read') &&
                menuItem('Cut')
                    .getAttribute('aria-description')
                    ?.includes('move this item from its folder'),
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        check(
            'F2/Delete/open cannot bypass the shared native-denial guard',
            !document.querySelector('[role="dialog"]') && !nativeCalls.includes('fs_read_file'),
        );
        const callsBeforeClipboard = nativeCalls.length;
        for (const key of ['c', 'c', 'x', 'x']) {
            row.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    code: key === 'c' ? 'KeyC' : 'KeyX',
                    ctrlKey: true,
                    bubbles: true,
                }),
            );
        }
        await settle();
        check(
            'blocked Copy/Cut shortcuts preserve the previous clipboard without another native probe',
            useAppStore.getState().clipboard === previousClipboard &&
                nativeCalls.length === callsBeforeClipboard,
        );
        const denials = useAppStore
            .getState()
            .toasts.filter((toast) => toast.id === 'files-clipboard-access');
        check(
            'repeated blocked shortcuts show one quiet ephemeral info message, not success or inbox history',
            denials.length === 1 &&
                denials[0].type === 'info' &&
                !denials[0].storeInHistory &&
                denials[0].message.includes('Cut is unavailable') &&
                useAppStore.getState().notificationHistory.length === historyBeforeClipboardDenial,
        );
        button('Folder actions').click();
        await until(() => menuItem('Paste'));
        check('folder Paste reflects destination denial', menuItem('Paste').disabled);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        const operationsBefore = nativeCalls.length;
        row.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true }),
        );
        const drop = new DataTransfer();
        drop.setData(
            'application/json',
            JSON.stringify({
                type: 'server-file',
                connectionId: 'other-fixture',
                paths: ['/remote/new-file'],
                names: ['new-file'],
            }),
        );
        row.dispatchEvent(
            new DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true }),
        );
        await settle();
        check(
            'paste shortcut and internal drop do not bypass destination denial',
            nativeCalls.length === operationsBefore,
        );
        control.setAccess({
            directoryAccess: { createFile: false, createFolder: false },
            targetAccess: { read: false, write: false, rename: false, delete: true },
        });
        await reload();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await until(() => menuItem('Cut'));
        check(
            'unreadable files remain cuttable when removal is allowed, even without same-folder rename rights',
            menuItem('Copy').disabled && !menuItem('Cut').disabled && menuItem('Rename').disabled,
        );
        menuItem('Cut').click();
        await settle();
        check(
            'the allowed Cut menu uses the existing clipboard owner without reading file contents',
            useAppStore.getState().clipboard?.op === 'cut' &&
                useAppStore.getState().clipboard?.files[0]?.name === 'README.md' &&
                !nativeCalls.includes('fs_read_file'),
        );
        control.setAccess({
            directoryAccess: { createFile: false, createFolder: false },
            targetAccess: { read: true, write: false, rename: false, delete: false },
        });
        await reload();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await until(() => menuItem('Copy'));
        check(
            'read access allows Copy independently of denied removal and content-write rights',
            !menuItem('Copy').disabled && menuItem('Cut').disabled,
        );
        menuItem('Copy').click();
        await settle();
        const readableClipboard = useAppStore.getState().clipboard;
        row.focus();
        row.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', ctrlKey: true, bubbles: true }),
        );
        await settle();
        check(
            'a blocked Cut shortcut cannot convert a valid Copy into a cut intent',
            readableClipboard?.op === 'copy' &&
                useAppStore.getState().clipboard === readableClipboard,
        );
        const readsBefore = control.accessReads.length;
        control.deferAccess();
        await select('package.json');
        await until(control.accessPending);
        for (let index = 0; index < 20; index++) {
            await select(index % 2 ? 'index.ts' : 'README.md');
        }
        check(
            'selection churn keeps one action query outstanding',
            control.accessReads.length === readsBefore + 1,
        );
        control.setAccess({
            directoryAccess: { createFile: null, createFolder: null },
            targetAccess: { read: null, write: null, rename: null, delete: null },
        });
        control.finishAccess();
        await until(
            () =>
                control.accessReads.at(-1)?.target?.endsWith('/index.ts') &&
                !control.accessPending(),
        );
        await settle();
        check(
            'late denied evidence cannot lock the newly selected item',
            !document.body.textContent?.includes('Unavailable for this account'),
        );
        button('New').click();
        await until(() => menuItem('New file'));
        check(
            'unknown access remains attemptable',
            !menuItem('New file').disabled && !menuItem('New folder').disabled,
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        document
            .querySelector<HTMLElement>('[data-file-name="index.ts"]')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await until(() => menuItem('Copy'));
        check(
            'unknown source access keeps both clipboard actions attemptable',
            !menuItem('Copy').disabled && !menuItem('Cut').disabled,
        );
        menuItem('Copy').click();
        await settle();
        check(
            'Copy with unknown access continues through the existing clipboard path',
            useAppStore.getState().clipboard?.op === 'copy' &&
                useAppStore.getState().clipboard?.files[0]?.name === 'index.ts',
        );
        control.setAccess({
            directoryAccess: { createFile: false, createFolder: false },
            targetAccess: { read: true, write: false, rename: true, delete: true },
        });
        // Force the real expiry callback just before its monotonic deadline.
        // No production timing switch or duplicate hook implementation is needed.
        const schedule = window.setTimeout;
        let fireExpiry: (() => void) | undefined;
        let expiryDeadline = 0;
        try {
            window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
                const timer = schedule(handler, delay, ...args);
                if (
                    typeof handler === 'function' &&
                    delay != null &&
                    delay > 14_000 &&
                    delay <= 15_000
                ) {
                    expiryDeadline = performance.now() + delay;
                    fireExpiry = () => {
                        clearTimeout(timer);
                        handler(...args);
                    };
                }
                return timer;
            }) as typeof window.setTimeout;
            await reload();
        } finally {
            window.setTimeout = schedule;
        }
        await until(() => document.body.textContent?.includes('Unavailable for this account'));
        check(
            'readonly content does not disable independent rename/delete rights',
            document.body.textContent?.includes('Create files, Create folders, Save.') &&
                !document.body.textContent?.includes('Save, Rename'),
        );
        const realNow = performance.now.bind(performance);
        if (!fireExpiry) {
            throw new Error('Access expiry callback was not scheduled');
        }
        const expireCaptured = fireExpiry;
        const readsAtExpiry = control.accessReads.length;
        try {
            performance.now = () => expiryDeadline - 0.5;
            expireCaptured();
            await settle();
            check(
                'an early expiry callback clears the rendered access denial',
                !document.body.textContent?.includes('Unavailable for this account'),
            );
        } finally {
            performance.now = realNow;
        }
        button('New').click();
        await until(() => menuItem('New file'));
        check(
            'early expiry enables actions without polling or another native read',
            !menuItem('New file').disabled &&
                !menuItem('New folder').disabled &&
                control.accessReads.length === readsAtExpiry,
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        await reload();
        await until(() => document.body.textContent?.includes('Unavailable for this account'));
        expireCaptured();
        await settle();
        check(
            'an old expiry callback cannot clear newer access evidence',
            document.body.textContent?.includes('Unavailable for this account'),
        );
        try {
            performance.now = () => realNow() + 16_000;
            const beforeExpiry = control.accessReads.length;
            button('Grid view').click();
            await settle();
            button('New').click();
            await until(() => menuItem('New file'));
            check(
                'expired evidence becomes attemptable without another native probe',
                !menuItem('New file').disabled && control.accessReads.length === beforeExpiry,
            );
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await settle();
        } finally {
            performance.now = realNow;
        }
        control.deferAccess();
        await reload();
        await until(control.accessPending);
        const beforeHide = control.accessReads.length;
        surfaceActive(false);
        await settle();
        control.setAccess({
            directoryAccess: { createFile: null, createFolder: null },
            targetAccess: { read: null, write: null, rename: null, delete: null },
        });
        try {
            performance.now = () => realNow() + 16_000;
            surfaceActive(true);
            await settle();
            await new Promise<void>((resolve) => setTimeout(resolve, 120));
            check(
                'reactivation does not fan out while an old access query is pending',
                control.accessReads.length === beforeHide,
            );
            control.finishAccess();
            await until(() => control.accessReads.length > beforeHide);
            await settle();
        } finally {
            performance.now = realNow;
        }
        check(
            'reactivation checks anew instead of reviving old denials',
            !document.body.textContent?.includes('Unavailable for this account'),
        );
        control.setAccess({
            directoryAccess: { createFile: false, createFolder: false },
            targetAccess: { read: null, write: null, rename: null, delete: null },
        });
        control.deferAccess();
        await reload();
        await until(control.accessPending);
        button('New').click();
        await until(() => menuItem('New file'));
        menuItem('New file').click();
        await until(() => document.querySelector('[role="dialog"]'));
        control.finishAccess();
        await until(() => button('Create').disabled);
        check(
            'late create denial disables an already-open form and explains why inside it',
            document
                .querySelector('[role="dialog"]')
                ?.textContent?.includes('Creating files is unavailable'),
        );
        const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            'blocked.txt',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        check(
            'form Enter cannot bypass a late native-denial guard',
            !nativeCalls.includes('fs_touch'),
        );
        button('Cancel').click();
        await settle();
        check(
            'advisory checks never mutate mode, content or invoke a shell',
            control.writes.length === 0 &&
                control.editorWrites.length === 0 &&
                nativeCalls.every(
                    (command) =>
                        ![
                            'fs_touch',
                            'fs_mkdir',
                            'fs_delete_batch',
                            'fs_rename',
                            'terminal:write',
                        ].includes(command),
                ),
        );
        // Leave a denied action visible for the runner's real-pointer tooltip check.
        control.setAccess({
            directoryAccess: { createFile: false, createFolder: false },
            targetAccess: { read: false, write: false, rename: false, delete: false },
        });
        await select('README.md');
        await reload();
        document
            .querySelector<HTMLElement>('[data-file-name="README.md"]')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await until(() => menuItem('Copy')?.disabled);
        return passed;
    }
    check('opening Files does not probe permissions for rows', fixture.control.reads.length === 0);
    await select('README.md');
    button('Inspect selection').click();
    await until(editReady);
    check(
        'Properties reads one selected target without mutating it',
        fixture.control.reads.length === 1 && fixture.control.writes.length === 0,
    );
    check(
        'special bits and numeric root ownership are displayed without denying the owner',
        inspector().textContent?.includes('2640') &&
            inspector().textContent?.includes('UID 0') &&
            !button('Edit permissions').disabled,
    );
    button('Edit permissions').click();
    await until(() => inspector().querySelectorAll('input[type="checkbox"]').length === 9);
    await until(() => document.activeElement?.getAttribute('aria-label') === 'Owner read');
    check(
        'explicit editing moves focus to its first labelled native checkbox',
        document.activeElement?.getAttribute('aria-label') === 'Owner read',
    );
    check(
        'all nine native checkboxes have accessible labels',
        [...inspector().querySelectorAll('input[type="checkbox"]')].every((el) =>
            Boolean(el.getAttribute('aria-label')),
        ),
    );
    const groupRead = inspector().querySelector<HTMLInputElement>('[aria-label="Group read"]')!;
    groupRead.click();
    await until(() => !groupRead.checked);
    check('editing a checkbox never writes on change', fixture.control.writes.length === 0);
    button('Discard draft').click();
    await until(() => !inspector().querySelector('input'));
    await until(() => document.activeElement === button('Edit permissions'));
    check(
        'discard returns focus to the same target’s Edit action',
        document.activeElement === button('Edit permissions'),
    );
    check('discarding the draft does not mutate permissions', fixture.control.writes.length === 0);
    button('Edit permissions').click();
    await until(() => Boolean(inspector().querySelector('input')));
    await setOctal('888');
    check(
        'invalid octal is described and cannot be applied',
        button('Apply').disabled && inspector().querySelector('[aria-invalid="true"]'),
    );
    await setOctal('644');
    check(
        'ordinary mode diff never includes special bits',
        !button('Apply').disabled && inspector().textContent?.includes('640 → 644'),
    );
    fixture.control.deferApply();
    button('Apply').click();
    button('Apply').click();
    await until(fixture.control.applyPending);
    check(
        'double Apply admits one write and freezes the draft',
        fixture.control.writes.length === 1 &&
            inspector().querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
    );
    const originalPath = fixture.control.writes[0].path;
    await select('package.json');
    fixture.control.finishApply();
    await until(() => fixture.control.reads.at(-1)?.endsWith('/package.json') && editReady());
    check(
        'selection changes during Apply cannot bind the old reply to the next item',
        fixture.control.writes[0].path === originalPath &&
            inspector().textContent?.includes('package.json') &&
            !inspector().textContent?.includes('Permissions updated;'),
    );
    check(
        'only ordinary disjoint masks cross native IPC',
        fixture.control.writes[0].setBits === 0o004 && fixture.control.writes[0].clearBits === 0,
    );

    fixture.control.reconnect();
    button('Edit permissions').click();
    await until(() => Boolean(inspector().querySelector('input')));
    await setOctal('600');
    button('Apply').click();
    await until(() => inspector().textContent?.includes('Connection changed.'));
    check(
        'a stale session requires a fresh review, without a write replay',
        fixture.control.writes.length === 1 && button('Apply').disabled,
    );
    await refresh();
    await until(editReady);
    fixture.control.setOutcome('unknown');
    button('Edit permissions').click();
    await until(() => Boolean(inspector().querySelector('input')));
    await setOctal('600');
    button('Apply').click();
    await until(() => inspector().textContent?.includes('outcome requires review'));
    check(
        'uncertain outcomes require Refresh and never auto-retry',
        fixture.control.writes.length === 2 && button('Edit permissions').disabled,
    );
    fixture.control.setOutcome('verified');
    fixture.control.setModel('windows');
    await refresh();
    check(
        'Windows exposes read-only attributes, not synthetic Unix chmod',
        button('Edit permissions').disabled &&
            inspector().textContent?.includes('access-control lists') &&
            !inspector().textContent?.includes('Current mode'),
    );
    fixture.control.setModel('posix');
    fixture.control.setKind('Symlink');
    await refresh();
    check(
        'links remain read-only with an accessible reason',
        button('Edit permissions').disabled && inspector().textContent?.includes('not editable'),
    );
    fixture.control.setKind('Directory');
    fixture.control.setMode(0o40755);
    await refresh();
    await until(editReady);
    button('Edit permissions').click();
    await until(() => Boolean(inspector().querySelector('[aria-label="Owner traverse"]')));
    check(
        'directory execute bits are labelled as traversal',
        inspector().querySelectorAll('[aria-label$="traverse"]').length === 3,
    );

    fixture.control.deferApply();
    await setOctal('700');
    button('Apply').click();
    await until(fixture.control.applyPending);
    button('Hide properties').click();
    await until(() => document.querySelector('[aria-label="Inspect selection"]'));
    fixture.control.finishApply();
    await until(() => !fixture.control.applyPending());
    button('Inspect selection').click();
    await until(editReady);
    check(
        'closing during Apply does not cancel the native request or leave reopening stuck',
        !button('Edit permissions').disabled,
    );

    button('Hide properties').click();
    await until(() => document.querySelector('[aria-label="Inspect selection"]'));
    await select('README.md');
    fixture.control.deferRead();
    button('Inspect selection').click();
    await until(fixture.control.readPending);
    await select('package.json');
    const readsBeforeChurn = fixture.control.reads.length;
    for (let index = 0; index < 20; index++) {
        await select(index % 2 ? 'package.json' : 'README.md');
    }
    check(
        'rapid selection changes keep one native permission read outstanding',
        fixture.control.reads.length === readsBeforeChurn,
    );
    fixture.control.finishRead();
    await until(editReady);
    check(
        'late metadata cannot replace a newer selected target',
        inspector().textContent?.includes('package.json') &&
            !inspector().textContent?.includes('README.md'),
    );
    check(
        'the compact inspector does not overflow horizontally',
        inspector().scrollWidth <= inspector().clientWidth + 1,
    );
    fixture.control.setKind('File');
    fixture.control.setMode(0o102644);
    await refresh();
    await until(editReady);
    button('Edit permissions').click();
    await until(() => inspector().querySelectorAll('input[type="checkbox"]').length === 9);
    fixture.control.deferRefresh();
    await setOctal('600');
    button('Apply').click();
    await until(fixture.control.refreshPending);
    await until(editReady);
    check(
        'a slow listing refresh cannot keep verified permissions locked',
        inspector().textContent?.includes('current mode verified'),
    );
    button('Edit permissions').click();
    await until(() => Boolean(inspector().querySelector('input')));
    fixture.control.rejectRefresh();
    await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    check(
        'a late listing failure cannot overwrite a new permission draft',
        Boolean(inspector().querySelector('input')) &&
            !inspector().textContent?.includes('Folder listing refresh failed'),
    );
    const sentinel = document.createElement('button');
    sentinel.textContent = 'Outside permission inspector';
    document.body.append(sentinel);
    sentinel.focus();
    surfaceActive(false);
    await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    check(
        'hiding Files never restores permission-editor focus into its inactive pane',
        document.activeElement === sentinel,
    );
    const readsBeforeActivation = fixture.control.reads.length;
    surfaceActive(true);
    await until(() => fixture.control.reads.length > readsBeforeActivation);
    await until(editReady);
    sentinel.remove();
    button('Edit permissions').click();
    await until(() => inspector().querySelectorAll('input[type="checkbox"]').length === 9);
    // An independent hook owner deliberately receives a fresh callback identity.
    // Exercise the real hook, not a replica of its dependency/fencing logic.
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let editor!: ReturnType<typeof useFilePermissionEditor>;
    const reconciled: string[] = [];
    function PermissionOwner({
        refreshListings,
    }: {
        refreshListings: (id: string) => Promise<void>;
    }) {
        editor = useFilePermissionEditor(
            { connectionId: 'files-ui-fixture', path: '/hook-regression' },
            true,
            refreshListings,
        );
        return null;
    }
    const render = (label: string) =>
        flushSync(() =>
            root.render(
                createElement(PermissionOwner, {
                    refreshListings: async (id) => {
                        reconciled.push(`${label}:${id}`);
                    },
                }),
            ),
        );
    const settle = () =>
        new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
    try {
        render('old');
        await until(() => editor.state?.metadata && !editor.state.loading);
        flushSync(() => {
            editor.edit();
        });
        flushSync(() => {
            editor.setDraft('600');
        });
        const reads = fixture.control.reads.length;
        const refreshIdentity = editor.refresh;
        render('latest');
        await settle();
        check(
            'listing callback identity does not refresh permissions or discard the draft',
            editor.refresh === refreshIdentity &&
                fixture.control.reads.length === reads &&
                editor.state?.editing &&
                editor.state.draft === '600',
        );
        await editor.apply();
        await settle();
        check(
            'verified apply reconciles through the latest listing callback',
            reconciled.join() === 'latest:files-ui-fixture',
        );
        fixture.control.requestAdminPassword(false);
        await editor.reviewAdministrator();
        await settle();
        check(
            'hook regression prepares an administrator review',
            editor.state?.administrator === 'prepared',
        );
        const cancellations = fixture.control.adminCancels.length;
        render('newer');
        await settle();
        check(
            'listing callback changes do not cancel an administrator review',
            editor.state?.administrator === 'prepared' &&
                fixture.control.adminCancels.length === cancellations,
        );
        fixture.control.setModel('windows');
        fixture.control.setSystemEditor(true);
        await editor.refresh(true);
        await settle();
        check(
            'explicit permission refresh reconciles through the newest listing callback',
            reconciled.join() === 'latest:files-ui-fixture,newer:files-ui-fixture',
        );
    } finally {
        flushSync(() => root.unmount());
        container.remove();
        fixture.control.setModel('posix');
        fixture.control.setSystemEditor(false);
        fixture.control.requestAdminPassword(true);
    }
    return passed;
}
