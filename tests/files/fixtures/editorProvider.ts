import type { InstalledPlugin } from '../../../src/features/plugins/types';

/** Deliberately sends save requests even when read-only, proving the host guard
 * is independent of a community provider's UI and shortcut implementation.
 */
export const permissionTestEditor: InstalledPlugin = {
    path: '/isolated-editor-fixture',
    enabled: true,
    manifest: {
        id: 'test.permission-editor',
        name: 'Permission test editor',
        version: '1.0.0',
        type: 'editor-provider',
        editor: { supports: ['save', 'readonly'] },
    },
    editorHtml: `<!doctype html><html><body><textarea aria-label="Plugin document"></textarea><script>
        let docId, requestId = 0;
        const editor = document.querySelector('textarea');
        const send = (type, payload) => parent.postMessage({ type, payload }, '*');
        const report = () => send('test:editor:snapshot', { content: editor.value, readOnly: editor.readOnly });
        const save = () => send('zync:editor:save-request', { docId, requestId: ++requestId, content: editor.value });
        editor.addEventListener('input', () => send('zync:editor:change', { docId, content: editor.value }));
        window.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); save(); } });
        window.addEventListener('message', ({ data: { type, payload } }) => {
            if (type === 'zync:editor:open-document') { docId = payload.docId; editor.value = payload.content; editor.readOnly = payload.readOnly; }
            if (type === 'zync:editor:update-document') editor.value = payload.content;
            if (type === 'zync:editor:set-readonly') editor.readOnly = payload.readOnly;
            if (type === 'zync:editor:command' && payload.command === 'save') save();
            if (type === 'zync:editor:save-result' && payload.ok) send('zync:editor:dirty-change', { docId, dirty: false });
            if (type === 'zync:editor:bootstrap') send('zync:editor:ready', {});
            if (type === 'test:editor:save') save();
            if (type === 'test:editor:edit') { editor.value = payload.content; editor.dispatchEvent(new Event('input')); }
            if (docId) report();
        });
        send('zync:editor:ready', {});
    </script></body></html>`,
};
