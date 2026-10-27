import { EditorView } from '@codemirror/view';

import type { createPermissionFixture } from '../fixtures/permissions';

/** Exercise real Files → editor host → all three providers with isolated IPC. */
export async function runFileEditorSaveBrowserChecks(
    fixture: ReturnType<typeof createPermissionFixture>['control'],
    controls: {
        provider: (id: string) => void;
        toasts: () => { message: string }[];
        clearToasts: () => void;
    },
    windowsOnly = false,
): Promise<string[]> {
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
    const until = async (predicate: () => unknown) => {
        const deadline = performance.now() + 10_000;
        while (!predicate()) {
            if (performance.now() > deadline) {
                throw new Error(
                    `Editor did not settle after ${passed.at(-1) ?? 'setup'}: ${document.body.innerText.slice(-1200)}`,
                );
            }
            await settle();
        }
    };
    const button = (label: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (element) =>
                (element.getAttribute('aria-label') || element.textContent?.trim()) === label,
        );
    let pluginState: { content: string; readOnly: boolean } | null = null;
    const frame = () => document.querySelector<HTMLIFrameElement>('iframe');
    const onMessage = (event: MessageEvent) => {
        if (
            event.source === frame()?.contentWindow &&
            event.data?.type === 'test:editor:snapshot'
        ) {
            pluginState = event.data.payload;
        }
    };
    window.addEventListener('message', onMessage);
    const textarea = () =>
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Fallback editor"]');
    const codeMirror = () => {
        const content = document.querySelector<HTMLElement>('.cm-content');
        return content ? EditorView.findFromDOM(content) : null;
    };
    const content = () =>
        textarea()?.value ?? codeMirror()?.state.doc.toString() ?? pluginState?.content;
    const readOnly = () =>
        textarea()?.readOnly ?? codeMirror()?.state.readOnly ?? pluginState?.readOnly;
    const save = () => button('Save file') ?? button('Save');
    const shortcut = async () => {
        if (frame()) {
            frame()!.contentWindow!.postMessage({ type: 'test:editor:save', payload: {} }, '*');
            await settle();
            return;
        }
        const target = textarea() ?? document.querySelector<HTMLElement>('.cm-content');
        if (!target) {
            throw new Error('Editor input missing');
        }
        target.focus();
        const eventWindow = target.ownerDocument.defaultView!;
        target.dispatchEvent(
            new eventWindow.KeyboardEvent('keydown', {
                key: 's',
                code: 'KeyS',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        await settle();
    };
    const edit = async (value: string) => {
        if (frame()) {
            frame()!.contentWindow!.postMessage(
                { type: 'test:editor:edit', payload: { content: value } },
                '*',
            );
            await until(() => pluginState?.content === value);
            await settle();
            return;
        }
        const input = textarea();
        if (input) {
            const prototype = input.ownerDocument.defaultView!.HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(
                new input.ownerDocument.defaultView!.Event('input', { bubbles: true }),
            );
        } else {
            const view = codeMirror()!;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
        }
        await settle();
    };
    const open = async (name = 'README.md') => {
        pluginState = null;
        await until(() => document.querySelector(`[data-file-name="${name}"]`));
        document
            .querySelector<HTMLElement>(`[data-file-name="${name}"]`)!
            .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await until(() => Boolean(textarea() ?? codeMirror() ?? pluginState));
        await until(() => !document.body.innerText.includes('Checking permissions…'));
        await settle();
    };
    const close = async () => {
        (button('Close editor') ?? button('Close'))!.click();
        await until(() => !textarea() && !codeMirror() && !frame());
        pluginState = null;
    };
    const accessMenu = async () => {
        const trigger = button('Read-only file')!;
        trigger.focus();
        trigger.click();
        await until(() => document.querySelector('[role="menu"][aria-label="Read-only file"]'));
    };
    const refresh = async () => {
        await accessMenu();
        button('Check permissions again')!.click();
        await settle();
        await until(() => !document.body.innerText.includes('Checking permissions…'));
    };

    try {
        await until(() => document.querySelector('[role="listbox"]'));
        check('Files rows do not trigger editor permission probes', fixture.reads.length === 0);
        if (windowsOnly) {
            for (const provider of [
                'builtin-plain',
                'com.zync.editor.codemirror',
                'test.permission-editor',
            ]) {
                controls.provider(provider);
                controls.clearToasts();
                fixture.setReadOnly(false);
                fixture.failWrite(null);
                await open();
                await edit('keep this Windows draft');
                fixture.failWrite('Access is denied. (os error 5)');
                await shortcut();
                await until(() => Boolean(readOnly()));
                controls.clearToasts();
                const before = fixture.editorWrites.length;
                const opens = fixture.systemEditorOpens.length;
                await accessMenu();
                check(
                    `${provider}: Windows permissions is available from the existing read-only menu`,
                    Boolean(button('Windows permissions…')) && !button('Allow save attempts'),
                );
                fixture.deferSystemEditor();
                button('Windows permissions…')!.click();
                await until(fixture.systemEditorPending);
                check(
                    `${provider}: pending Windows handoff is single flight and cannot enable Save`,
                    !button('Windows permissions…') &&
                        button('Check permissions again')?.disabled &&
                        save()?.disabled &&
                        fixture.systemEditorOpens.length === opens + 1,
                );
                fixture.finishSystemEditor();
                await until(() =>
                    document.body.innerText.includes(
                        'Your editor draft is unchanged; no save was attempted.',
                    ),
                );
                check(
                    `${provider}: native settings invocation preserves draft and creates neither writes nor toasts`,
                    content() === 'keep this Windows draft' &&
                        fixture.editorWrites.length === before &&
                        fixture.writes.length === 0 &&
                        controls.toasts().length === 0 &&
                        save()?.disabled,
                );
                check(
                    `${provider}: another handoff requires an explicit metadata recheck`,
                    !button('Windows permissions…'),
                );
                fixture.failWrite(null);
                button('Check permissions again')!.click();
                await until(() => !readOnly());
                check(
                    `${provider}: explicit recheck restores saving without saving or replacing the draft`,
                    !save()?.disabled &&
                        content() === 'keep this Windows draft' &&
                        fixture.editorWrites.length === before,
                );
                await close();
            }
            controls.provider('com.zync.editor.codemirror');
            fixture.setReadOnly(true);
            await open();
            await accessMenu();
            // The old duplicate mount-focus timer stole focus and closed this menu.
            await new Promise<void>((resolve) => setTimeout(resolve, 90));
            check(
                'CodeMirror initial focus does not later steal an explicitly opened access menu',
                Boolean(button('Windows permissions…')) &&
                    document.activeElement === button('Check permissions again'),
            );
            fixture.deferSystemEditor();
            button('Windows permissions…')!.click();
            await until(fixture.systemEditorPending);
            await close();
            fixture.setReadOnly(false);
            await open('package.json');
            fixture.finishSystemEditor();
            await settle();
            check(
                'late closed-document handoff does not lock or relabel the next editor',
                !readOnly() &&
                    content()?.includes('package.json') &&
                    !document.body.innerText.includes('Windows Properties opened.'),
            );
            await close();
            fixture.setReadOnly(true);
            fixture.failSystemEditor(true);
            await open();
            await accessMenu();
            button('Windows permissions…')!.click();
            await until(() =>
                document.body.innerText.includes('Simulated Windows settings invocation failed'),
            );
            check(
                'editor invocation failure stays inline, preserves read-only and requires recheck',
                !button('Windows permissions…') &&
                    save()?.disabled &&
                    !button('Check permissions again')?.disabled &&
                    controls.toasts().length === 0,
            );
            return passed;
        }
        for (const provider of [
            'builtin-plain',
            'com.zync.editor.codemirror',
            'test.permission-editor',
        ]) {
            controls.provider(provider);
            controls.clearToasts();
            fixture.setMode(0o100400);
            fixture.failWrite(null);
            fixture.failRead(false);
            const before = fixture.editorWrites.length;
            await open();
            check(
                `${provider}: 400 opens read-only with disabled, non-accented Save`,
                readOnly() &&
                    save()?.disabled &&
                    document.body.innerText.includes('Read-only file') &&
                    !save()?.className.includes('!text-app-accent'),
            );
            check(
                `${provider}: advanced save override is not a primary toolbar action`,
                !button('Allow save attempts') && !button('Enable saving'),
            );
            for (let index = 0; index < 3; index++) {
                await shortcut();
            }
            check(
                `${provider}: repeated Ctrl+S cannot write or create denial toasts`,
                fixture.editorWrites.length === before && controls.toasts().length === 0,
            );
            fixture.setMode(0o100644);
            await refresh();
            check(
                `${provider}: refreshed permissions restore editing without changing the document`,
                !readOnly() && content()?.includes('Fixture content'),
            );
            await edit('unsaved draft');
            fixture.setMode(0o100400);
            // Refresh is deliberately available only in the blocked notice. Reopen
            // an advisory block through a denied save to test live draft retention.
            fixture.failWrite(
                'Failed to open file for writing: Permission denied: Permission denied',
            );
            await shortcut();
            await until(() => Boolean(readOnly()) && controls.toasts().length === 1);
            check(
                `${provider}: a native string denial produces one detailed error and retains the draft`,
                fixture.editorWrites.length === before + 1 &&
                    content() === 'unsaved draft' &&
                    controls.toasts()[0].message.includes('Permission denied') &&
                    save()?.disabled,
            );
            await accessMenu();
            check(
                `${provider}: a filesystem-denied write offers no override`,
                !button('Allow save attempts') && Boolean(button('Check permissions again')),
            );
            button('Read-only file')!.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
            await until(
                () => !document.querySelector('[role="menu"][aria-label="Read-only file"]'),
            );
            for (let index = 0; index < 3; index++) {
                await shortcut();
            }
            check(
                `${provider}: observed denial is latched without repeated native writes or errors`,
                fixture.editorWrites.length === before + 1 && controls.toasts().length === 1,
            );
            fixture.failWrite(null);
            await refresh();
            await accessMenu();
            check(
                `${provider}: mode-only override explains its file-only scope without changing permissions`,
                readOnly() &&
                    button('Allow save attempts') &&
                    document.body.innerText.includes(
                        'For this open file only. Does not change permissions, grant access or use sudo.',
                    ),
            );
            const permissionWrites = fixture.writes.length;
            button('Allow save attempts')!.click();
            await settle();
            check(
                `${provider}: opt-in preserves unsaved content and enables saving`,
                !readOnly() && !save()?.disabled && content() === 'unsaved draft',
            );
            check(
                `${provider}: allowing attempts itself neither writes content nor changes permissions`,
                fixture.editorWrites.length === before + 1 &&
                    fixture.writes.length === permissionWrites,
            );
            await shortcut();
            await until(() => fixture.editorWrites.length === before + 2);
            await settle();
            check(
                `${provider}: explicit opt-in uses the existing write path and correct content`,
                fixture.editorWrites.at(-1)?.content === 'unsaved draft' &&
                    fixture.editorWrites.at(-1)?.path.endsWith('/README.md'),
            );
            await close();
            await open();
            check(
                `${provider}: reopening the same file restores read-only instead of persisting the override`,
                readOnly() && save()?.disabled,
            );
            await close();
            fixture.failRead(true);
            controls.clearToasts();
            await open('package.json');
            check(
                `${provider}: unavailable metadata is unknown, not a fabricated denial`,
                !readOnly() && controls.toasts().length === 0,
            );
            await edit('keep draft on disk-full');
            fixture.failWrite('No space left on device');
            await shortcut();
            await until(() => controls.toasts().length === 1);
            check(
                `${provider}: non-permission errors keep drafts and do not latch read-only`,
                !readOnly() && content() === 'keep draft on disk-full' && !save()?.disabled,
            );
            await close();
            fixture.failRead(false);
            fixture.failWrite(null);
            fixture.setMode(0o100644);
            fixture.setWriteAccess(false);
            controls.clearToasts();
            const beforeAcl = fixture.editorWrites.length;
            await open();
            await accessMenu();
            check(
                `${provider}: native local ACL denial has no mode-hint override`,
                readOnly() && save()?.disabled && !button('Allow save attempts'),
            );
            button('Read-only file')!.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
            await until(
                () => !document.querySelector('[role="menu"][aria-label="Read-only file"]'),
            );
            await shortcut();
            check(
                `${provider}: native local ACL denial blocks all save routes without a first error`,
                fixture.editorWrites.length === beforeAcl && controls.toasts().length === 0,
            );
            fixture.setWriteAccess(null);
            await refresh();
            check(
                `${provider}: explicit access recheck restores unknown/attemptable saving`,
                !readOnly(),
            );
            await close();
        }
        controls.provider('com.zync.editor.codemirror');
        controls.clearToasts();
        fixture.setMode(0o100400);
        fixture.deferRead();
        // Do not wait for access: close while the old metadata request is in flight.
        document
            .querySelector<HTMLElement>('[data-file-name="README.md"]')!
            .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await until(() => fixture.readPending() && Boolean(codeMirror()));
        check('Save is disabled while initial metadata is pending', save()?.disabled);
        await close();
        fixture.setMode(0o100644);
        await open('package.json');
        fixture.finishRead();
        await settle();
        check(
            'late read-only metadata from a closed file cannot lock a new document',
            !readOnly() &&
                content()?.includes('package.json') &&
                !document.body.innerText.includes('Read-only file'),
        );
        await close();
        fixture.setMode(0o100400);
        await open();
        return passed;
    } finally {
        window.removeEventListener('message', onMessage);
    }
}
