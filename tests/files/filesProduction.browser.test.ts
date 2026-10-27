/** Production Files UI and browsing state, with only native event/IPC and persistence boundaries substituted. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import type { Browser, Locator, Page } from 'playwright-core';
import { createServer } from 'vite';

import { runFilesDrawerChecks } from './helpers/filesDrawerChecks';
import { runFilesFocusChecks } from './helpers/filesFocusChecks';
import { runFilesTransferSafetyChecks } from './helpers/filesTransferSafetyChecks';
import { runFilesWorkspaceMotionChecks } from './helpers/filesWorkspaceMotionChecks';

const transferSafetyOnly = process.argv.includes('--transfer-safety-only');
const focusOnly = process.argv.includes('--focus-only');
const permissionsOnly = process.argv.includes('--permissions-only');
const administratorOnly = process.argv.includes('--admin-permissions-only');
const windowsPermissionsOnly = process.argv.includes('--windows-permissions-only');
const windowsEditorOnly = process.argv.includes('--windows-editor-only');
const accessOnly = process.argv.includes('--access-only');
const listingAccessOnly = process.argv.includes('--listing-access-only');
const editorOnly = process.argv.includes('--editor-only');
const folderSizeMemoryOnly = process.argv.includes('--folder-size-memory-only');
const folderSizesOnly = process.argv.includes('--folder-sizes-only') || folderSizeMemoryOnly;

const { chromium } = (await import(
    process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright-core'
)) as typeof import('playwright-core');
const repositoryRoot = process.cwd();
const server = await createServer({
    root: repositoryRoot,
    configFile: false,
    plugins: [
        {
            name: 'files-row-render-probe',
            enforce: 'pre',
            // Test-only leaf counters: observe the real memo boundary without shipping instrumentation.
            transform(code, id) {
                const probes = [
                    ['FileGrid.tsx', "const isFolder = file.type === 'd';", 'file.name'],
                    ['FileToolbar.tsx', 'const barRef =', "'@toolbar'"],
                    ['FileContentsHeader.tsx', 'const selectedCount =', "'@header'"],
                    ['FileViewControls.tsx', 'const reversed =', "'@view'"],
                    ['FilePlacesSidebar.tsx', 'const home =', "'@places'"],
                ];
                const probe = probes.find(([file]) =>
                    id.replaceAll('\\', '/').endsWith('/src/components/file-manager/' + file),
                );
                if (!probe) {
                    return;
                }
                const [, marker, key] = probe;
                assert.ok(code.includes(marker), 'Missing render-probe boundary: ' + probe[0]);
                return code.replaceAll(
                    marker,
                    `
        globalThis.filesRowRenders ??= Object.create(null);
        globalThis.filesRowRenders[${key}] = (globalThis.filesRowRenders[${key}] ?? 0) + 1;
        ${marker}`,
                );
            },
        },
        react(),
    ],
    cacheDir: path.join(repositoryRoot, 'node_modules/.vite-files-production-tests'),
    resolve: {
        alias: [
            {
                find: '@tauri-apps/api/event',
                replacement: path.join(repositoryRoot, 'tests/files/fixtures/nativeEvents.ts'),
            },
            {
                find: /^(?:.*\/)?tauri-ipc(?:\.ts|\.js)?$/,
                replacement: path.join(repositoryRoot, 'tests/files/fixtures/nativeBridge.ts'),
            },
        ],
    },
    server: {
        host: '127.0.0.1',
        port: 0,
        watch: { ignored: ['**/src-tauri/**', '**/.tmp-agent-tests/**'] },
    },
    optimizeDeps: {
        entries: ['tests/files/filesProduction.browser.html'],
        exclude: ['@enjoys/context-engine'],
    },
});
let browser: Browser | undefined;
let checks = 0;
try {
    await server.listen();
    browser = await chromium.launch({
        channel: process.env.ZYNC_BROWSER_CHANNEL || 'msedge',
        headless: true,
    });
    const context = await browser.newContext({
        viewport: { width: 1200, height: 800 },
        reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().includes('Sample permission denied')) {
            errors.push(message.text());
        }
    });
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) {
            return route.continue();
        }
        requests.push(url.origin);
        return route.abort();
    });
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string', 'The test server must have a TCP address');
    await page.goto(
        `http://127.0.0.1:${address.port}/tests/files/filesProduction.browser.html${folderSizesOnly ? '?folderSizes=1' : administratorOnly ? '?permissions=1&admin=1' : windowsEditorOnly ? '?permissions=1&windows=1&editor=1' : windowsPermissionsOnly ? '?permissions=1&windows=1' : accessOnly ? '?access=1' : permissionsOnly ? '?permissions=1' : editorOnly ? '?editor=1' : ''}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 },
    );
    const item = (name: string) => page.locator(`[data-file-name=${JSON.stringify(name)}]`);
    const summary = page.locator('.files-summary-count');
    const listing = page.getByRole('listbox');
    const check = (label: string, value: unknown) => {
        assert.ok(value, label);
        console.log(`  ok ${label}`);
        checks++;
    };
    const screenshot = async (name: string) => {
        if (!process.env.ZYNC_FILES_SCREENSHOTS) {
            return;
        }
        await mkdir(process.env.ZYNC_FILES_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.ZYNC_FILES_SCREENSHOTS}/${name}.png` });
    };
    if (folderSizeMemoryOnly) {
        await listing.waitFor();
        const cdp = await context.newCDPSession(page);
        for (let cycle = 0; cycle < 5; cycle++) {
            const renders = await page.evaluate(() => window.runFolderSizeRenderChecks());
            check(
                'size cycle ' + cycle + ' skips unchanged view controls and Places',
                renders['@view'] === 0 && renders['@places'] === 0,
            );
            check(
                'size cycle ' + cycle + ' skips regular-file rows',
                renders['package.json'] === 0,
            );
            // Collection is diagnostic-only, in this isolated fixture, never the user's app.
            await cdp.send('HeapProfiler.collectGarbage');
            const heap = await cdp.send('Runtime.getHeapUsage');
            const dom = await cdp.send('Memory.getDOMCounters');
            console.log(
                JSON.stringify({
                    cycle,
                    renders,
                    heapMiB: +(heap.usedSize / 1048576).toFixed(2),
                    dom,
                }),
            );
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log('Repeated folder-size render/memory checks passed (' + checks + ').');
    } else if (folderSizesOnly) {
        for (const reducedMotion of ['reduce', 'no-preference'] as const) {
            await page.emulateMedia({ reducedMotion });
            if (reducedMotion === 'no-preference') {
                await page.reload({ waitUntil: 'domcontentloaded' });
            }
            await listing.waitFor();
            for (const label of await page.evaluate(() => window.runFolderSizeBrowserChecks())) {
                check(reducedMotion + ': ' + label, true);
            }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log(`Production Files folder-size checks passed (${checks}).`);
    } else if (listingAccessOnly) {
        await listing.waitFor();
        for (const label of await page.evaluate(() => window.runFileListingAccessBrowserChecks())) {
            check(label, true);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log(`Production Files observed-read access checks passed (${checks}).`);
    } else if (windowsEditorOnly) {
        await page.waitForFunction(
            () => typeof window.runFileEditorSaveBrowserChecks === 'function',
        );
        for (const label of await page.evaluate(() => window.runFileEditorSaveBrowserChecks())) {
            check(label, true);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log(`Production Files Windows editor permission checks passed (${checks}).`);
    } else if (administratorOnly || accessOnly || windowsPermissionsOnly) {
        await page.waitForFunction(
            () => typeof window.runFilePermissionBrowserChecks === 'function',
        );
        for (const label of await page.evaluate(() => window.runFilePermissionBrowserChecks())) {
            check(label, true);
        }
        if (accessOnly) {
            await page.getByRole('menuitem', { name: 'Copy', exact: true }).locator('..').hover();
            const tooltip = page.getByRole('tooltip');
            await tooltip.waitFor();
            check(
                'hovering disabled Copy explains the read denial using the shared tooltip',
                (await tooltip.innerText()).includes('permission to read'),
            );
            await page.keyboard.press('Escape');
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log(
            `Production Files ${administratorOnly ? 'administrator permissions' : windowsPermissionsOnly ? 'Windows permissions' : 'access'} checks passed (${checks}).`,
        );
    } else if (editorOnly) {
        await page.waitForFunction(
            () => typeof window.runFileEditorSaveBrowserChecks === 'function',
        );
        for (const label of await page.evaluate(() => window.runFileEditorSaveBrowserChecks())) {
            check(label, true);
        }
        const writesBefore = await page.evaluate(
            () => window.filesUiTest.editor!.editorWrites.length,
        );
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+s');
        await page.keyboard.press('Control+s');
        check(
            'real browser Ctrl+S is silent on a read-only CodeMirror document',
            (await page.evaluate(() => window.filesUiTest.editor!.editorWrites.length)) ===
                writesBefore,
        );
        await screenshot('files-editor-read-only');
        await page.setViewportSize({ width: 360, height: 800 });
        const accessTrigger = page.getByRole('button', { name: 'Read-only file', exact: true });
        await accessTrigger.waitFor();
        check(
            'read-only explanation and actions remain usable in a narrow Files pane',
            await accessTrigger.evaluate((element) => {
                const notice = element.getBoundingClientRect();
                const save = document
                    .querySelector<HTMLElement>('[aria-label="Save file"]')!
                    .getBoundingClientRect();
                return (
                    notice.left >= 0 &&
                    notice.right <= innerWidth &&
                    save.left >= 0 &&
                    save.right <= innerWidth &&
                    (save.top >= notice.bottom || save.left >= notice.right)
                );
            }),
        );
        await accessTrigger.focus();
        await page.keyboard.press('ArrowDown');
        const accessMenu = page.getByRole('menu', { name: 'Read-only file', exact: true });
        await accessMenu.waitFor();
        check(
            'keyboard opens the existing access menu at its safe refresh action',
            await page
                .getByRole('menuitem', { name: 'Check permissions again', exact: true })
                .evaluate((element) => document.activeElement === element),
        );
        check(
            'advanced options fit inside the narrow viewport',
            await accessMenu.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return (
                    bounds.left >= 0 &&
                    bounds.right <= innerWidth &&
                    bounds.top >= 0 &&
                    bounds.bottom <= innerHeight
                );
            }),
        );
        await screenshot('files-editor-access-options');
        await page.keyboard.press('Escape');
        await accessMenu.waitFor({ state: 'detached' });
        check(
            'Escape closes access options and restores focus without enabling saving',
            (await accessTrigger.evaluate((element) => document.activeElement === element)) &&
                (await page.getByRole('button', { name: 'Save file', exact: true }).isDisabled()),
        );
        await screenshot('files-editor-read-only-narrow');
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log(`Production Files editor save-access checks passed (${checks}).`);
        process.exitCode = 0;
    } else if (permissionsOnly) {
        await page.waitForFunction(
            () => typeof window.runFilePermissionBrowserChecks === 'function',
        );
        for (const label of await page.evaluate(() => window.runFilePermissionBrowserChecks())) {
            check(label, true);
        }
        const permissionWrites = await page.evaluate(
            () =>
                window.filesUiTest.calls.filter((command) => command === 'fs_permissions_apply')
                    .length,
        );
        const ownerWrite = page.getByRole('checkbox', { name: 'Owner write', exact: true });
        const checkedBeforeSpace = await ownerWrite.isChecked();
        await ownerWrite.focus();
        await page.keyboard.press('Space');
        check(
            'Space toggles the native permission control without submitting a write',
            (await ownerWrite.isChecked()) !== checkedBeforeSpace &&
                (await page.evaluate(
                    () =>
                        window.filesUiTest.calls.filter(
                            (command) => command === 'fs_permissions_apply',
                        ).length,
                )) === permissionWrites,
        );
        await page.emulateMedia({ forcedColors: 'active' });
        check(
            'forced colors restores system-owned native checkbox artwork',
            await ownerWrite.evaluate((element) => getComputedStyle(element).appearance === 'auto'),
        );
        await page.emulateMedia({ forcedColors: 'none' });
        await screenshot('files-permission-editor');
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log(`Production Files permission checks passed (${checks}).`);
        process.exitCode = 0;
    } else {
        // Focused motion runs share the exact production fixture and browser boundaries.
        if (
            !focusOnly &&
            !transferSafetyOnly &&
            !process.argv.includes('--drawers-only') &&
            !process.argv.includes('--workspace-motion-only')
        ) {
            const clickMenu = async (
                label: string,
                itemName: string,
                role: Parameters<Page['getByRole']>[0] = 'menuitem',
            ) => {
                await page.getByRole('button', { name: label, exact: true }).click();
                await page.getByRole(role, { name: itemName, exact: true }).click();
            };
            const checkGutters = async (label: string) => {
                check(
                    label,
                    await page.locator('.files-content').evaluate((el) => {
                        const listing = el.querySelector<HTMLElement>('.files-listing')!;
                        const count = el
                            .querySelector<HTMLElement>('.files-summary-main')!
                            .getBoundingClientRect();
                        const actions = el
                            .querySelector<HTMLElement>('[aria-label="Folder actions"]')!
                            .getBoundingClientRect();
                        const bounds = listing.getBoundingClientRect();
                        const inset = parseFloat(getComputedStyle(listing).paddingLeft);
                        return (
                            Math.abs(count.left - bounds.left - inset) <= 1 &&
                            Math.abs(bounds.right - inset - actions.right) <= 1
                        );
                    }),
                );
            };
            const checkPointerStates = async (option: Locator, label: string) => {
                await page.mouse.move(0, 0);
                const idle = await option.evaluate((el) => getComputedStyle(el).backgroundColor);
                await option.hover();
                const hover = await option.evaluate((el) => getComputedStyle(el).backgroundColor);
                await option.click();
                await page.mouse.move(0, 0);
                const selected = await option.evaluate(
                    (el) => getComputedStyle(el).backgroundColor,
                );
                await option.hover();
                const selectedHover = await option.evaluate(
                    (el) => getComputedStyle(el).backgroundColor,
                );
                check(
                    label,
                    idle !== hover &&
                        selected !== idle &&
                        selected !== hover &&
                        selectedHover !== hover &&
                        (await option.getAttribute('aria-selected')) === 'true' &&
                        (await option.locator('svg').count()) >= 1,
                );
            };
            const checkLeadingCheckbox = async (option: Locator, label: string) => {
                check(
                    label,
                    await option.evaluate((el) => {
                        const mark = el
                            .querySelector<HTMLElement>('[data-file-select]')!
                            .getBoundingClientRect();
                        const icon = el
                            .querySelector<HTMLElement>('[data-file-select]')!
                            .nextElementSibling!.getBoundingClientRect();
                        const name = [...el.querySelectorAll<HTMLElement>('[aria-label]')]
                            .find(
                                (node) =>
                                    node.getAttribute('aria-label') ===
                                    el.getAttribute('data-file-name'),
                            )!
                            .getBoundingClientRect();
                        const row = el.getBoundingClientRect();
                        const heading = el
                            .closest<HTMLElement>('.files-listing')!
                            .querySelector<HTMLElement>('.files-name-heading')!;
                        return (
                            mark.width >= 24 &&
                            mark.height >= 24 &&
                            mark.left >= row.left &&
                            Math.abs(mark.right + 8 - icon.left) <= 1 &&
                            Math.abs(icon.right + 8 - name.left) <= 1 &&
                            Math.abs(mark.top + mark.height / 2 - row.top - row.height / 2) <= 1 &&
                            Math.abs(
                                heading.getBoundingClientRect().left +
                                    parseFloat(getComputedStyle(heading).paddingLeft) -
                                    name.left,
                            ) <= 1
                        );
                    }),
                );
            };
            const checkGridCheckbox = async (option: Locator, label: string) => {
                check(
                    label,
                    await option.evaluate((el) => {
                        const target = el.querySelector<HTMLElement>('[data-file-select]')!;
                        const mark = target.getBoundingClientRect();
                        const tile = el.getBoundingClientRect();
                        return (
                            mark.width >= 24 &&
                            mark.height >= 24 &&
                            Math.abs(mark.left - tile.left - 2) <= 1 &&
                            Math.abs(mark.top - tile.top - 2) <= 1 &&
                            mark.right <= tile.right &&
                            mark.bottom <= tile.bottom &&
                            target.contains(
                                document.elementFromPoint(
                                    mark.left + mark.width / 2,
                                    mark.top + mark.height / 2,
                                ),
                            )
                        );
                    }),
                );
            };
            const gridBand = async () =>
                listing.evaluate((el) => {
                    const cells = [...el.querySelectorAll<HTMLElement>('[data-file-name]')].map(
                        (node) => {
                            return {
                                name: node.dataset.fileName!,
                                ...(node.getBoundingClientRect().toJSON() as Pick<
                                    DOMRect,
                                    'left' | 'right' | 'top' | 'bottom'
                                >),
                            };
                        },
                    );
                    const rows = [...new Set(cells.map((cell) => cell.top))].sort((a, b) => a - b);
                    const first = cells
                        .filter((cell) => cell.top === rows[0])
                        .sort((a, b) => a.left - b.left);
                    const bottom = Math.max(
                        ...cells.filter((cell) => cell.top === rows[2]).map((cell) => cell.bottom),
                    );
                    const start = { x: first[0].left - 2, y: rows[0] - 2 };
                    const end = { x: first[4].right + 2, y: bottom + 2 };
                    return {
                        start,
                        end,
                        outside: first[5].name,
                        expected: cells
                            .filter(
                                (cell) =>
                                    cell.left < end.x &&
                                    cell.right > start.x &&
                                    cell.top < end.y &&
                                    cell.bottom > start.y,
                            )
                            .map((cell) => cell.name),
                    };
                });
            const dragBand = async (
                geometry: {
                    start: { x: number; y: number };
                    end: { x: number; y: number };
                    expected: (string | undefined)[];
                },
                label: string,
                { additive = false, reverse = false, interrupted = false } = {},
            ) => {
                const before = additive
                    ? await page
                          .getByRole('option', { selected: true })
                          .evaluateAll((nodes) => nodes.map((node) => node.dataset.fileName))
                    : [];
                const start = reverse ? geometry.end : geometry.start;
                const end = reverse ? geometry.start : geometry.end;
                if (additive) {
                    await page.keyboard.down('Control');
                }
                await page.mouse.move(start.x, start.y);
                await page.mouse.down();
                await page.mouse.move(end.x, end.y, { steps: 12 });
                const surface = page.locator('.files-listing');
                check(
                    `${label}: the active band suppresses native text selection`,
                    (await surface.getAttribute('data-file-marquee-active')) === 'true' &&
                        (await page.evaluate(() => !window.getSelection()?.toString())),
                );
                check(
                    `${label}: filename descendants cannot override the active text-selection guard`,
                    await page
                        .locator('.files-option')
                        .first()
                        .evaluate((el) =>
                            [...el.querySelectorAll<HTMLElement>('*')].every(
                                (node) => getComputedStyle(node).userSelect === 'none',
                            ),
                        ),
                );
                if (interrupted) {
                    await surface.dispatchEvent('lostpointercapture');
                }
                await page.mouse.up();
                if (additive) {
                    await page.keyboard.up('Control');
                }
                if (!interrupted) {
                    const selected = await page
                        .getByRole('option', { selected: true })
                        .evaluateAll((nodes) => nodes.map((node) => node.dataset.fileName).sort());
                    const expected = [...new Set([...before, ...geometry.expected])].sort();
                    check(
                        `${label}: only intersecting files are selected, not the intervening text`,
                        JSON.stringify(selected) === JSON.stringify(expected) &&
                            (await page.evaluate(() => !window.getSelection()?.toString())),
                    );
                }
                check(
                    `${label}: completion or capture loss releases the temporary guard`,
                    (await surface.getAttribute('data-file-marquee-active')) === null,
                );
            };
            await item('README.md').waitFor();
            const initialSettings = await page.evaluate(() =>
                JSON.stringify(window.filesUiTest.savedSettings()),
            );
            check(
                'real Files component has one accessible heading and twelve visible items',
                (await page.getByRole('heading', { name: 'project', exact: true }).count()) === 1 &&
                    (await page.locator('[id^="file-item-"]').count()) === 12,
            );
            const quietListing = () =>
                listing.evaluate(
                    (el) =>
                        document.activeElement === el &&
                        getComputedStyle(el).boxShadow === 'none' &&
                        [...el.querySelectorAll<HTMLElement>('[data-focused]')].every(
                            (option) =>
                                !getComputedStyle(option).boxShadow.includes('0px 0px 0px 2px'),
                        ),
                );
            check(
                'opening Files keeps listing shortcuts ready without drawing an automatic focus ring',
                await quietListing(),
            );
            await page.keyboard.press('Home');
            check(
                'the first keyboard navigation reveals a mounted row focus indicator',
                await listing.evaluate((el) => {
                    const option = document.getElementById(
                        el.getAttribute('aria-activedescendant') ?? '',
                    )!;
                    return (
                        el.contains(option) &&
                        option?.getAttribute('data-file-name') === 'assets' &&
                        getComputedStyle(option).boxShadow.includes('2px')
                    );
                }),
            );
            const beforeActivation = await page.evaluate(() =>
                JSON.stringify(window.filesUiTest.listingSnapshot()),
            );
            await page.evaluate(() => window.dispatchEvent(new Event('zync:files-panel-show')));
            check(
                'reopening the focused Files panel silences only its decoration, not browsing state',
                (await quietListing()) &&
                    beforeActivation ===
                        (await page.evaluate(() =>
                            JSON.stringify(window.filesUiTest.listingSnapshot()),
                        )),
            );
            await page.keyboard.press('Shift+F10');
            await page.getByRole('menu').waitFor();
            check(
                'automatic activation still supports the keyboard context menu immediately',
                (await page.getByRole('menu').count()) === 1,
            );
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.dispatchEvent(new Event('zync:files-panel-show')));
            await page.locator('.files-list-columns button:visible').last().focus();
            await page.keyboard.press('Tab');
            check(
                'Tab entry restores normal native keyboard focus styling after quiet activation',
                await listing.evaluate(
                    (el) =>
                        document.activeElement === el &&
                        el.matches(':focus-visible') &&
                        !el.closest<HTMLElement>('[data-files-quiet-focus]')!,
                ),
            );
            await page.evaluate(() => {
                window.filesUiTest.breadcrumbPath('/home/deploy/loading');
                window.dispatchEvent(new Event('zync:files-panel-show'));
            });
            const emptyListing = page.getByRole('region', {
                name: 'Files in loading',
                exact: true,
            });
            check(
                'an automatically focused empty or loading listing does not acquire a full-area ring',
                await emptyListing.evaluate(
                    (el) =>
                        document.activeElement === el && getComputedStyle(el).boxShadow === 'none',
                ),
            );
            await page.evaluate(() => window.filesUiTest.restore());
            await item('README.md').waitFor();
            check(
                'publishing files after activation remains quiet without refocusing the panel',
                await quietListing(),
            );
            await item('assets').click();
            check(
                'pointer selection keeps its selection state without a keyboard row ring',
                (await item('assets').getAttribute('aria-selected')) === 'true' &&
                    (await listing.evaluate((el) => !el.matches(':focus-visible'))),
            );
            await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
            check(
                'list rows and headings share a comfortable outer gutter instead of touching pane edges',
                await page.locator('.files-listing-list').evaluate((el) => {
                    const bounds = el.getBoundingClientRect();
                    const row = el
                        .querySelector<HTMLElement>('[role="option"]')!
                        .getBoundingClientRect();
                    const heading = el
                        .querySelector<HTMLElement>('.files-list-columns')!
                        .getBoundingClientRect();
                    return (
                        row.left >= bounds.left + 24 &&
                        row.right <= bounds.right - 24 &&
                        Math.abs(heading.left - row.left) <= 1 &&
                        row.top >= heading.bottom + 8 &&
                        parseFloat(getComputedStyle(el).paddingBottom) >= 24
                    );
                }),
            );
            check(
                'row highlights have a small gap without changing virtual row heights',
                await item('assets').evaluate(
                    (el) => el.parentElement!.clientHeight - el.clientHeight === 2,
                ),
            );
            check(
                'Name heading aligns with filenames rather than the artwork',
                await item('assets').evaluate((el) => {
                    const heading = el
                        .closest<HTMLElement>('.files-listing')!
                        .querySelector<HTMLElement>('.files-name-heading')!;
                    return (
                        Math.abs(
                            heading.getBoundingClientRect().left +
                                parseFloat(getComputedStyle(heading).paddingLeft) -
                                el
                                    .querySelector<HTMLElement>('[aria-label="assets"]')!
                                    .getBoundingClientRect().left,
                        ) <= 1
                    );
                }),
            );
            await checkGutters('wide summary, actions and list use the same content gutter');
            await screenshot('files-production-list');
            const initialNameWidth = await page
                .locator('.files-name-heading')
                .evaluate((el) => el.clientWidth);
            check(
                'default metadata is Name, Size and Modified, with fluid bounded filename width',
                initialNameWidth > 400 &&
                    initialNameWidth <= 672 &&
                    (await page.locator('.files-list-column-type').count()) === 0 &&
                    (await page.locator('.files-list-column-owner').count()) === 0,
            );
            await page.setViewportSize({ width: 1600, height: 800 });
            const wideColumns = await page
                .locator('.files-list-columns')
                .first()
                .evaluate((el) => ({
                    name: el
                        .querySelector<HTMLElement>('.files-name-heading')!
                        .getBoundingClientRect().width,
                    size: el
                        .querySelector<HTMLElement>('.files-list-column-size')!
                        .getBoundingClientRect().width,
                    modified: el
                        .querySelector<HTMLElement>('.files-list-column-modified')!
                        .getBoundingClientRect().width,
                }));
            check(
                `wider panes give names more space while retaining compact metadata tracks (${initialNameWidth} → ${JSON.stringify(wideColumns)})`,
                wideColumns.name > initialNameWidth + 40 &&
                    wideColumns.name <= 672 &&
                    wideColumns.size === 80 &&
                    wideColumns.modified === 144,
            );
            await screenshot('files-production-wide');
            await page.setViewportSize({ width: 1200, height: 800 });
            check(
                'wide folder header uses one compact line without shrinking shared controls',
                (await page.locator('.files-summary').evaluate((el) => el.clientHeight <= 48)) &&
                    (await page
                        .locator('.files-summary-main')
                        .evaluate((el) => getComputedStyle(el).flexDirection === 'row')),
            );
            check(
                'folder title is available to assistive technology without a repeated visible heading',
                await page
                    .getByRole('heading', { name: 'project', exact: true })
                    .evaluate((el) => el.classList.contains('sr-only')),
            );
            const pathBar = page.getByRole('navigation', { name: 'Folder path', exact: true });
            check(
                'breadcrumbs expose a named navigation landmark and one current location',
                (await pathBar.locator('ol > li').count()) === 2 &&
                    (await pathBar.locator('[aria-current="location"]').count()) === 1,
            );
            check(
                'breadcrumb buttons provide full-path hints and practical pointer targets',
                await pathBar
                    .getByRole('button', { name: 'Home', exact: true })
                    .evaluate((el) => el.clientHeight >= 24 && el.clientWidth >= 24),
            );
            await page.waitForFunction(() =>
                [...document.querySelectorAll<HTMLImageElement>('[role="option"] img')].every(
                    (image) => image.complete && image.naturalWidth > 0,
                ),
            );
            check(
                'approved Material file and special-folder icons use bundled resources',
                (await item('src').locator('img').count()) === 1 &&
                    (await item('package.json').locator('img').count()) === 1,
            );
            check(
                'bundled icon packs load through the real plugin registry without starting a worker',
                await page.evaluate(
                    () =>
                        window.filesUiTest.pluginCalls.includes('plugins:load') &&
                        window.filesUiTest.pluginCalls.every((command) =>
                            [
                                'plugins:load',
                                'plugins:runtime_reset',
                                'plugins:recovery_status',
                            ].includes(command),
                        ),
                ),
            );
            await page.evaluate(() =>
                window.filesUiTest.iconPluginEnabled('com.zync.builtin-icons.material', false),
            );
            await page.waitForFunction(
                () =>
                    document.querySelectorAll<HTMLImageElement>('[role="option"] img').length === 0,
            );
            check(
                'disabling a selected built-in icon pack falls back without rewriting its saved ID',
                await page.evaluate(
                    () =>
                        window.filesUiTest.savedSettings().iconTheme ===
                        'com.zync.builtin-icons.material',
                ),
            );
            await page.evaluate(() =>
                window.filesUiTest.iconPluginEnabled('com.zync.builtin-icons.material', true),
            );
            await page.waitForFunction(
                () => document.querySelector<HTMLImageElement>('[role="option"] img')!,
            );
            check(
                're-enabling the pack restores artwork from the same registry',
                (await item('src').locator('img').count()) === 1,
            );
            await page.evaluate(() => window.filesUiTest.iconTheme('lucide'));
            await page.waitForFunction(
                () =>
                    document.querySelectorAll<HTMLImageElement>('[role="option"] img').length === 0,
            );
            check(
                'a saved legacy icon selector remains authoritative',
                (await item('package.json').locator('svg').count()) > 0,
            );
            await page.evaluate(() =>
                window.filesUiTest.iconTheme('com.zync.builtin-icons.material'),
            );
            await page.waitForFunction(
                () => document.querySelector<HTMLImageElement>('[role="option"] img')!,
            );
            await page.evaluate(() => window.filesUiTest.preference({ placesCollapsed: true }));
            await page.getByRole('button', { name: 'Show places', exact: true }).waitFor();
            check(
                'explicit saved Places collapse is not overwritten by the new default',
                (await page
                    .getByRole('complementary', { name: 'File places', exact: true })
                    .count()) === 0,
            );
            await page.evaluate(() => window.filesUiTest.preference({ placesCollapsed: false }));
            await page.getByRole('complementary', { name: 'File places', exact: true }).waitFor();
            await page.evaluate(() => window.filesUiTest.preference({ listZoom: 1 }));
            await page.waitForFunction(
                () => document.querySelector<HTMLImageElement>('[role="option"] img')?.width === 32,
            );
            check(
                'saved larger-icon zoom retains its existing icon size and row height',
                await item('package.json').evaluate((el) => el.parentElement!.clientHeight === 44),
            );
            for (const [zoom, icon] of [
                [0, 20],
                [1, 32],
                [2, 64],
            ]) {
                await page.evaluate(
                    (listZoom) => window.filesUiTest.preference({ listZoom }),
                    zoom,
                );
                await page.waitForFunction(
                    (size) =>
                        document.querySelector<HTMLImageElement>('[role="option"] img')?.width ===
                        size,
                    icon,
                );
                await checkLeadingCheckbox(
                    item('assets'),
                    `list zoom ${zoom} aligns its leading checkbox, icon, filename and Name heading`,
                );
            }
            await page.evaluate(() => window.filesUiTest.preference({ listZoom: 0 }));
            await page.waitForFunction(
                () => document.querySelector<HTMLImageElement>('[role="option"] img')?.width === 20,
            );
            const listOrigin = (await item('assets').boundingBox())!.y;
            const beforeCheckboxHover = await item('package.json')
                .getByLabel('package.json', { exact: true })
                .boundingBox();
            await item('package.json').hover();
            check(
                'revealing a leading checkbox does not shift its filename',
                (await item('package.json')
                    .getByLabel('package.json', { exact: true })
                    .boundingBox())!.x === beforeCheckboxHover!.x,
            );
            check(
                'checkboxes occupy the same leading gutter on different rows',
                await item('package.json')
                    .locator('[data-file-select]')
                    .evaluate(
                        (el) =>
                            Math.abs(
                                el.getBoundingClientRect().left -
                                    document
                                        .querySelector<HTMLElement>(
                                            '[data-file-name="README.md"] [data-file-select]',
                                        )!
                                        .getBoundingClientRect().left,
                            ) <= 1,
                    ),
            );
            check(
                'hover exposes a bordered checkbox with a practical target and no extra tab stop',
                await item('package.json')
                    .locator('[data-file-select]')
                    .evaluate((el) => {
                        const box = el.querySelector<HTMLElement>('.files-selection-box')!;
                        return (
                            el.clientWidth >= 24 &&
                            el.clientHeight >= 24 &&
                            getComputedStyle(el).opacity === '1' &&
                            getComputedStyle(box).borderStyle === 'solid' &&
                            !el.hasAttribute('tabindex')
                        );
                    }),
            );
            await item('package.json').locator('[data-file-select]').click();
            await item('README.md').locator('[data-file-select]').click();
            check(
                'checkbox targets add to selection without modifier keys',
                (await page.getByRole('option', { selected: true }).count()) === 2,
            );
            await item('package.json').locator('[data-file-select]').click();
            check(
                'a checkbox clears only its own file, preserving the other selection',
                (await page.getByRole('option', { selected: true }).count()) === 1 &&
                    (await item('README.md').getAttribute('aria-selected')) === 'true',
            );
            const savedClickPolicy = await page.evaluate(
                () => window.filesUiTest.savedSettings().fileManager.clickPolicy,
            );
            await page.evaluate(() => window.filesUiTest.preference({ clickPolicy: 'single' }));
            const beforeCheckboxReads = await page.evaluate(() => window.filesUiTest.calls.length);
            await item('assets').locator('[data-file-select]').click();
            check(
                'checkbox selection never opens a folder, including single-click mode',
                (await page.evaluate(
                    () =>
                        window.filesUiTest.path() === '/home/deploy/project' &&
                        window.filesUiTest.calls.length,
                )) === beforeCheckboxReads &&
                    (await item('assets').getAttribute('aria-selected')) === 'true',
            );
            await page.evaluate(
                (clickPolicy) => window.filesUiTest.preference({ clickPolicy }),
                savedClickPolicy,
            );
            await item('assets').locator('[data-file-select]').dblclick();
            check(
                'double-clicking a selection checkbox never activates the folder',
                (await page.evaluate(
                    () =>
                        window.filesUiTest.path() === '/home/deploy/project' &&
                        window.filesUiTest.calls.length,
                )) === beforeCheckboxReads,
            );
            await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
            await checkPointerStates(
                item('assets'),
                'dark list distinguishes hover, selection and selected hover with a non-color indicator',
            );
            check(
                'selected list rows keep their accent rail when the pointer leaves',
                await item('assets').evaluate((el) => getComputedStyle(el).boxShadow !== 'none'),
            );
            const selectedBox = item('assets').locator('.files-selection-box');
            check(
                'selected checkboxes use the active accent with a contrasting dark tick for a light accent',
                await selectedBox.evaluate((el) => {
                    const style = getComputedStyle(el);
                    return (
                        style.backgroundColor === 'rgb(245, 156, 119)' &&
                        style.borderColor === style.backgroundColor &&
                        style.color === 'rgb(0, 0, 0)'
                    );
                }),
            );
            const beforeAccentChange = await page.evaluate(() => ({
                accent: document.body.style.getPropertyValue('--color-app-accent'),
                calls: window.filesUiTest.calls.length,
            }));
            const uncheckedBorder = await item('config')
                .locator('.files-selection-box')
                .evaluate((el) => getComputedStyle(el).borderColor);
            await page.evaluate(() =>
                document.body.style.setProperty('--color-app-accent', '#1e40af'),
            );
            await page.waitForFunction(() => {
                const box = document.querySelector<HTMLElement>(
                    '[data-file-name="assets"] .files-selection-box',
                )!;
                return getComputedStyle(box).color === 'rgb(255, 255, 255)';
            });
            check(
                'changing to a dark accent updates checked fill and switches the tick to white without remounting',
                await selectedBox.evaluate(
                    (el) => getComputedStyle(el).backgroundColor === 'rgb(30, 64, 175)',
                ),
            );
            await screenshot('files-production-checkbox-dark-accent');
            await page.evaluate(() =>
                document.body.style.setProperty('--color-app-accent', '#fff176'),
            );
            await page.waitForFunction(
                () =>
                    getComputedStyle(
                        document.querySelector<HTMLElement>(
                            '[data-file-name="assets"] .files-selection-box',
                        )!,
                    ).color === 'rgb(0, 0, 0)',
            );
            check(
                'changing to a light accent restores a dark tick while preserving selection and neutral unchecked borders',
                (await selectedBox.evaluate(
                    (el) => getComputedStyle(el).backgroundColor === 'rgb(255, 241, 118)',
                )) &&
                    (await item('assets').getAttribute('aria-selected')) === 'true' &&
                    (await item('config')
                        .locator('.files-selection-box')
                        .evaluate((el) => getComputedStyle(el).borderColor)) === uncheckedBorder &&
                    (await page.evaluate(
                        (before) => window.filesUiTest.calls.length === before,
                        beforeAccentChange.calls,
                    )),
            );
            await screenshot('files-production-checkbox-light-accent');
            await page.evaluate((accent) => {
                if (accent) {
                    document.body.style.setProperty('--color-app-accent', accent);
                } else {
                    document.body.style.removeProperty('--color-app-accent');
                }
            }, beforeAccentChange.accent);
            await screenshot('files-production-selected');
            await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
            await item('package.json').click();
            await item('README.md').click({ modifiers: ['Control'] });
            check(
                'multiple selection updates existing chrome without moving file rows',
                (await page.getByRole('option', { selected: true }).count()) === 2 &&
                    (await item('assets').boundingBox())!.y === listOrigin &&
                    (await summary.textContent())!.includes('2 selected'),
            );
            check(
                'selection summary shows combined regular-file sizes from existing metadata',
                (await summary.textContent())!.includes('5.1 KB') &&
                    (await summary.locator('.sr-only').textContent())!.includes('2 files'),
            );
            await item('assets').locator('[data-file-select]').click();
            check(
                'mixed selection counts folders without pretending their metadata is recursive size',
                (await summary.textContent())!.includes('3 selected · Partial · 5.1 KB') &&
                    (await summary.locator('.sr-only').textContent())!.includes('1 folder'),
            );
            await item('assets').locator('[data-file-select]').click();
            await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
            check(
                'clear-selection control keeps row positions and returns listing focus',
                (await page.getByRole('option', { selected: true }).count()) === 0 &&
                    (await item('assets').boundingBox())!.y === listOrigin &&
                    (await listing.evaluate((el) => document.activeElement === el)),
            );
            const columns = page.locator('.files-list-columns').first();
            const sizeHeading = await columns.locator('.files-list-column-size').boundingBox();
            const sizeCell = await item('package.json')
                .locator('.files-list-column-size')
                .boundingBox();
            const dateHeading = await columns.locator('.files-list-column-modified').boundingBox();
            const dateCell = await item('package.json')
                .locator('.files-list-column-modified')
                .boundingBox();
            check(
                'metadata headers and cells share exact column boundaries',
                Math.abs(sizeHeading!.x + sizeHeading!.width - sizeCell!.x - sizeCell!.width) <=
                    1 && Math.abs(dateHeading!.x - dateCell!.x) <= 1,
            );
            check(
                'read-only view changes retain every unrelated saved preference',
                initialSettings ===
                    (await page.evaluate(() =>
                        JSON.stringify(window.filesUiTest.savedSettings()),
                    )) &&
                    (await page.evaluate(() => window.filesUiTest.settingsWrites.length === 0)),
            );
            check(
                'sort buttons remain outside the multiselect listing',
                (await listing.getByRole('button').count()) === 0 &&
                    (await listing.getAttribute('aria-multiselectable')) === 'true',
            );
            await listing.focus();
            await page.keyboard.press('Home');
            await page.waitForFunction(() => {
                const widget = document.querySelector<HTMLElement>('[role="listbox"]')!;
                const active = document.getElementById(
                    widget?.getAttribute('aria-activedescendant') ?? '',
                )!;
                return widget?.contains(active) && active?.getAttribute('aria-posinset') === '1';
            });
            check(
                'focus exposes a mounted, instance-scoped option without selecting it',
                (await page.getByRole('option', { selected: true }).count()) === 0,
            );
            await page.keyboard.press('Space');
            check(
                'Space exposes selection without relying on color',
                (await page.getByRole('option', { selected: true }).count()) === 1 &&
                    (await page.getByRole('option', { selected: true }).locator('svg').count()) >=
                        1,
            );
            check(
                'keyboard focus remains distinct from the selection rail',
                await page
                    .locator('.files-option[data-focused]')
                    .evaluate((el) => getComputedStyle(el).boxShadow.includes('2px')),
            );
            await page.keyboard.press('Escape');
            const newButton = page.getByRole('button', { name: 'New', exact: true });
            for (const label of ['New', 'Upload', 'Folder actions', 'View', 'Folders in Home']) {
                const trigger = page.getByRole('button', { name: label, exact: true });
                await trigger.click();
                await page.getByRole('menu', { name: label, exact: true }).waitFor();
                await trigger.click();
                check(
                    `${label} closes on a second pointer click without reopening`,
                    (await trigger.getAttribute('aria-expanded')) === 'false' &&
                        (await page.getByRole('menu').count()) === 0 &&
                        (await trigger.evaluate((el) => el === document.activeElement)),
                );
            }
            await newButton.click();
            await page.locator('.files-summary-count').click();
            check(
                'an outside click still dismisses a trigger-owned menu',
                (await page.getByRole('menu').count()) === 0 &&
                    (await newButton.getAttribute('aria-expanded')) === 'false',
            );
            await newButton.click();
            await page.getByRole('button', { name: 'Upload', exact: true }).click();
            check(
                'switching menu triggers closes the previous menu and opens only the new one',
                (await page.getByRole('menu').count()) === 1 &&
                    (await page.getByRole('menu', { name: 'Upload', exact: true }).count()) === 1 &&
                    (await newButton.getAttribute('aria-expanded')) === 'false',
            );
            await page.keyboard.press('Escape');
            await newButton.focus();
            await page.keyboard.press('ArrowDown');
            check(
                'New menu separates creation from uploads and folder actions',
                (await page.getByRole('menuitem').count()) === 2 &&
                    (await page.getByRole('menuitem', { name: 'Upload files' }).count()) === 0,
            );
            check(
                'keyboard opening focuses a real shared menu item',
                await page
                    .getByRole('menuitem', { name: 'New file', exact: true })
                    .evaluate((el) => document.activeElement === el),
            );
            await page.keyboard.press('ArrowDown');
            check(
                'menu arrows do not select a file behind the menu',
                (await page
                    .getByRole('menuitem', { name: 'New folder', exact: true })
                    .evaluate((el) => document.activeElement === el)) &&
                    !(await summary.textContent())!.includes('selected'),
            );
            await page.keyboard.press('Escape');
            check(
                'Escape returns to the New trigger',
                await newButton.evaluate((el) => document.activeElement === el),
            );
            await clickMenu('New', 'New file');
            await page.getByRole('dialog', { name: 'New File', exact: true }).waitFor();
            check(
                'New reuses the production dialog and keeps input focus',
                await page
                    .getByRole('textbox', { name: 'File Name', exact: true })
                    .evaluate((el) => document.activeElement === el),
            );
            await page.getByRole('button', { name: 'Cancel', exact: true }).click();
            await clickMenu('New', 'New folder');
            await page.getByRole('dialog', { name: 'New Folder', exact: true }).waitFor();
            check(
                'folder creation retains the existing modal and native handler',
                await page.getByRole('textbox', { name: 'Folder Name', exact: true }).isVisible(),
            );
            await page.getByRole('button', { name: 'Cancel', exact: true }).click();
            await clickMenu('Upload', 'Upload folder');
            check(
                'folder uploads retain the existing directory picker',
                await page.evaluate(() =>
                    window.filesUiTest.calls.includes('dialog:openDirectory'),
                ),
            );
            await clickMenu('Upload', 'Upload files');
            check(
                'Upload calls the existing picker boundary without writing a file',
                await page.evaluate(() => window.filesUiTest.calls.includes('dialog:openFile')),
            );
            await page.getByRole('button', { name: 'Filter this folder', exact: true }).click();
            const search = page.getByRole('textbox', { name: 'Search this folder', exact: true });
            await search.fill('missing');
            check(
                'active filtering reports shown and eligible totals',
                (await summary.textContent())!.includes('0 of 12 shown'),
            );
            check(
                'filter leaves location breadcrumbs visible',
                await page
                    .locator('.files-toolbar')
                    .getByRole('button', { name: 'project', exact: true })
                    .isVisible(),
            );
            check(
                'no matches is distinct from an empty folder',
                await page.getByText('No matches in this folder', { exact: true }).isVisible(),
            );
            await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
            check(
                'clear filter restores the original inventory',
                (await page.locator('[id^="file-item-"]').count()) === 12,
            );
            await page.getByRole('button', { name: 'Filter file types', exact: true }).click();
            await page.getByRole('menuitemcheckbox', { name: 'Folders', exact: true }).click();
            check(
                'file type filter uses shared checked menu semantics',
                (await page.locator('[id^="file-item-"]').count()) === 6,
            );
            check(
                'type restriction is visible without reopening its menu',
                await page
                    .getByRole('button', { name: 'Filter file types', exact: true })
                    .textContent()
                    .then((text) => text!.includes('Folders')),
            );
            await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
            check(
                'one clear action removes both filters and keeps input focus',
                (await item('README.md').isVisible()) &&
                    (await search.evaluate((el) => document.activeElement === el)),
            );
            await search.fill('readme');
            await search.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
            await page.keyboard.press('ArrowLeft');
            check(
                'filter Left/Right remain text-caret keys',
                await search.evaluate(
                    (el: HTMLInputElement) =>
                        document.activeElement === el && el.selectionStart === 2,
                ),
            );
            await search.focus();
            await page.keyboard.press('Escape');
            check(
                'closing search clears its type filter and restores its trigger',
                (await page.locator('[id^="file-item-"]').count()) === 12 &&
                    (await page
                        .getByRole('button', { name: 'Filter this folder', exact: true })
                        .evaluate((el) => document.activeElement === el)),
            );
            await newButton.focus();
            await page.keyboard.press('Control+f');
            await search.waitFor();
            check(
                'Files shortcuts still work from chrome while unmodified button keys remain native',
                await search.evaluate((el) => document.activeElement === el),
            );
            await page.keyboard.press('Escape');
            await item('README.md').click();
            check(
                'selection is summarized without a floating overlay',
                (await summary.textContent())!.includes('1 selected'),
            );
            await item('README.md').click({ button: 'right' });
            const featureMenu = page.getByRole('menu');
            check(
                'existing file operations, archives and editor choices remain reachable',
                (await featureMenu
                    .getByRole('menuitem', { name: 'Download', exact: true })
                    .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', {
                            name: 'Download as Archive (.tar.gz)',
                            exact: true,
                        })
                        .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', { name: 'Open With…', exact: true })
                        .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', { name: 'Set Default Editor', exact: true })
                        .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', { name: 'Copy', exact: true })
                        .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', { name: 'Cut', exact: true })
                        .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', { name: 'Copy to Server...', exact: true })
                        .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', { name: 'Delete', exact: true })
                        .count()) === 1 &&
                    (await featureMenu
                        .getByRole('menuitem', { name: 'Properties', exact: true })
                        .count()) === 1,
            );
            await featureMenu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
            await page.getByRole('dialog', { name: 'Rename', exact: true }).waitFor();
            check(
                'rename retains its existing prefilled modal without issuing a mutation',
                (await page
                    .getByRole('textbox', { name: 'New Name', exact: true })
                    .inputValue()) === 'README.md',
            );
            await page.getByRole('button', { name: 'Cancel', exact: true }).click();
            await page.getByRole('button', { name: 'Inspect selection', exact: true }).click();
            await page.getByRole('button', { name: 'Close properties', exact: true }).waitFor();
            check(
                'Inspect reuses the real read-only Properties surface',
                (await page
                    .getByRole('button', { name: 'Hide properties', exact: true })
                    .getAttribute('aria-pressed')) === 'true',
            );
            const properties = page.getByRole('complementary', {
                name: 'File properties',
                exact: true,
            });
            await page.waitForFunction(
                () =>
                    document
                        .querySelector<HTMLElement>('[aria-label="File properties"]')
                        ?.getBoundingClientRect().width! >= 318,
            );
            check(
                'wide Properties sits beside files instead of covering them',
                await listing
                    .boundingBox()
                    .then(
                        async (box) => box!.x + box!.width <= (await properties.boundingBox())!.x,
                    ),
            );
            check(
                'details are grouped into readable, non-editable sections',
                (await properties
                    .getByRole('heading', { name: 'Information', exact: true })
                    .count()) === 1 &&
                    (await properties
                        .getByRole('heading', { name: 'Permissions', exact: true })
                        .count()) === 1 &&
                    (await properties.getByRole('checkbox').count()) === 0,
            );
            await page.getByRole('button', { name: 'Close properties', exact: true }).focus();
            await page
                .locator('[data-zync-tooltip]')
                .filter({ hasText: 'Close properties' })
                .waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: 'Inspect selection', exact: true }).waitFor();
            check(
                'Escape from the inline inspector close button dismisses Properties without clearing selection',
                (await item('README.md').getAttribute('aria-selected')) === 'true' &&
                    (await page
                        .getByRole('button', { name: 'Inspect selection', exact: true })
                        .evaluate((el) => el === document.activeElement)),
            );
            await page.getByRole('button', { name: 'Inspect selection', exact: true }).click();
            await page.waitForFunction(
                () =>
                    document
                        .querySelector<HTMLElement>('[aria-label="File properties"]')
                        ?.getBoundingClientRect().width! >= 318,
            );
            await screenshot('files-production-properties');
            const propertyValue = await properties.locator('dd').first().boundingBox();
            await page.mouse.move(
                propertyValue!.x + 1,
                propertyValue!.y + propertyValue!.height / 2,
            );
            await page.mouse.down();
            await page.mouse.move(
                propertyValue!.x + Math.min(propertyValue!.width - 1, 140),
                propertyValue!.y + propertyValue!.height / 2,
                { steps: 8 },
            );
            await page.mouse.up();
            check(
                'Properties still supports native pointer text selection outside the file listing',
                await properties.evaluate((el) => {
                    const selection = window.getSelection();
                    return Boolean(
                        selection?.toString().trim() && el.contains(selection.anchorNode),
                    );
                }),
            );
            await page.evaluate(() => {
                const text = document.querySelector<HTMLElement>(
                    '[aria-label="File properties"] dd',
                )!;
                const range = document.createRange();
                range.selectNodeContents(text);
                const selection = window.getSelection();
                selection!.removeAllRanges();
                selection!.addRange(range);
            });
            await page.keyboard.press('Control+c');
            check(
                'native text copy from Properties is not replaced by file-copy shortcuts',
                await page.evaluate(() => !window.filesUiTest.clipboard()),
            );
            await page.evaluate(() => window.getSelection()!.removeAllRanges());
            await page.setViewportSize({ width: 500, height: 800 });
            await page.getByRole('dialog', { name: 'Properties', exact: true }).waitFor();
            check(
                'resizing an open inspector acquires dialog focus',
                await page
                    .getByRole('dialog', { name: 'Properties', exact: true })
                    .evaluate((el) => el.contains(document.activeElement)),
            );
            await page.setViewportSize({ width: 1200, height: 800 });
            await page
                .getByRole('dialog', { name: 'Properties', exact: true })
                .waitFor({ state: 'detached' });
            await page.waitForFunction(
                () => document.activeElement?.getAttribute('aria-label') === 'Close properties',
            );
            check(
                'returning to inline inspector retains reachable focus',
                await page
                    .getByRole('button', { name: 'Close properties', exact: true })
                    .evaluate((el) => document.activeElement === el),
            );
            await page
                .locator('[data-zync-tooltip]')
                .filter({ hasText: 'Close properties' })
                .waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: 'Inspect selection', exact: true }).waitFor();
            await page.waitForFunction(
                () => document.activeElement?.getAttribute('aria-label') === 'Inspect selection',
            );
            check(
                'Escape after responsive migration closes Properties and restores the original opener',
                await page
                    .getByRole('button', { name: 'Inspect selection', exact: true })
                    .evaluate((el) => document.activeElement === el),
            );
            await page.setViewportSize({ width: 380, height: 800 });
            check(
                'narrow panes keep all top-level actions accessible',
                (await page.getByRole('button', { name: 'New', exact: true }).isVisible()) &&
                    (await page.getByRole('button', { name: 'Upload', exact: true }).isVisible()) &&
                    (await page.getByRole('button', { name: 'View', exact: true }).isVisible()) &&
                    (await page.getByRole('button', { name: 'Back', exact: true }).count()) === 1,
            );
            check(
                'narrow list hides metadata without horizontal overflow',
                (await page
                    .locator('.files-list-column-modified')
                    .first()
                    .evaluate((el) => getComputedStyle(el).display === 'none')) &&
                    (await page
                        .locator('.files-manager')
                        .evaluate((el) => el.scrollWidth <= el.clientWidth)),
            );
            await checkGutters('narrow summary and list retain matching reduced gutters');
            await screenshot('files-production-narrow');
            await item('README.md').click();
            await page.getByRole('button', { name: 'Inspect selection', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'Properties', exact: true });
            await dialog.waitFor();
            check(
                'narrow details has one close owner',
                (await dialog.getByRole('button', { name: 'Close', exact: true }).count()) === 1 &&
                    (await dialog
                        .getByRole('button', { name: 'Close properties', exact: true })
                        .count()) === 0,
            );
            await page.keyboard.press('Tab');
            check(
                'narrow dialog traps focus',
                await dialog.evaluate((el) => el.contains(document.activeElement)),
            );
            await screenshot('files-production-properties-narrow');
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'detached' });
            check(
                'narrow details restores its opener',
                await page
                    .getByRole('button', { name: 'Inspect selection', exact: true })
                    .evaluate((el) => document.activeElement === el),
            );
            await page.getByRole('button', { name: 'Show places', exact: true }).click();
            const placesDialog = page.getByRole('dialog', { name: 'Places', exact: true });
            await placesDialog.waitFor();
            check(
                'narrow Places uses the same dialog owner without changing saved visibility',
                await page.evaluate(
                    () =>
                        !window.filesUiTest.settingsWrites.some((write) =>
                            Object.hasOwn(write, 'placesCollapsed'),
                        ),
                ),
            );
            await page.keyboard.press('Escape');
            await placesDialog.waitFor({ state: 'detached' });
            await page.getByRole('button', { name: 'View', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Sort by', exact: true }).hover();
            await page.getByRole('menuitemradio', { name: 'Owner:Group', exact: true }).click();
            check('columns hidden in narrow panes remain sortable in View', true);
            await clickMenu('View', 'Show hidden files', 'menuitemcheckbox');
            check(
                'hidden-file preference still reveals hidden entries',
                await item('.env.example').isVisible(),
            );
            await clickMenu('View', 'Grid view', 'menuitemradio');
            check(
                'grid reuses the same selection and saved-view callback',
                (await summary.textContent())!.includes('1 selected') &&
                    (await page.evaluate(() =>
                        window.filesUiTest.settingsWrites.some(
                            (write) => write.defaultView === 'grid',
                        ),
                    )),
            );
            await page.setViewportSize({ width: 1200, height: 800 });
            await clickMenu('View', 'List view', 'menuitemradio');
            await page.getByRole('button', { name: 'View', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Columns in this pane', exact: true }).hover();
            await page.getByRole('menuitemcheckbox', { name: 'Type', exact: true }).click();
            check(
                'optional columns affect both headings and rows without persistence writes',
                (await page.locator('.files-list-column-type').count()) > 1 &&
                    (await page.evaluate(() =>
                        window.filesUiTest.settingsWrites.every(
                            (write) => !Object.hasOwn(write, 'detailColumns'),
                        ),
                    )),
            );
            await page.getByRole('button', { name: 'View', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Columns in this pane', exact: true }).hover();
            await page.getByRole('menuitemcheckbox', { name: 'Owner:Group', exact: true }).click();
            await page.setViewportSize({ width: 1600, height: 800 });
            check(
                'all optional metadata tracks stay aligned with their headings in wide panes',
                await item('package.json').evaluate((el) => {
                    const headings = el
                        .closest<HTMLElement>('.files-listing')!
                        .querySelector<HTMLElement>('.files-list-columns')!;
                    return ['size', 'modified', 'type', 'owner'].every((column) => {
                        const cell = el.querySelector<HTMLElement>(`.files-list-column-${column}`)!;
                        const heading = headings.querySelector<HTMLElement>(
                            `.files-list-column-${column}`,
                        )!;
                        const a = cell.getBoundingClientRect();
                        const b = heading.getBoundingClientRect();
                        return (
                            getComputedStyle(cell).display !== 'none' &&
                            Math.abs(a.left - b.left) <= 1 &&
                            Math.abs(a.width - b.width) <= 1
                        );
                    });
                }),
            );
            await page.setViewportSize({ width: 1200, height: 800 });
            check(
                'medium panes hide Owner without losing Type or overflowing',
                (await page
                    .locator('.files-list-column-owner')
                    .first()
                    .evaluate((el) => getComputedStyle(el).display === 'none')) &&
                    (await page.locator('.files-list-column-type').first().isVisible()) &&
                    (await page
                        .locator('.files-listing')
                        .evaluate((el) => el.scrollWidth <= el.clientWidth)),
            );
            await page.setViewportSize({ width: 900, height: 800 });
            check(
                'smaller panes prioritize names and base metadata over optional columns',
                (await page
                    .locator('.files-list-column-type')
                    .first()
                    .evaluate((el) => getComputedStyle(el).display === 'none')) &&
                    (await page.locator('.files-list-column-modified').first().isVisible()) &&
                    (await page
                        .locator('.files-listing')
                        .evaluate((el) => el.scrollWidth <= el.clientWidth)),
            );
            await page.setViewportSize({ width: 1200, height: 800 });
            await page.getByRole('button', { name: 'View', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Columns in this pane', exact: true }).hover();
            await page.getByRole('menuitemcheckbox', { name: 'Owner:Group', exact: true }).click();
            await clickMenu('View', 'Grid view', 'menuitemradio');
            await checkGutters('grid and summary retain the same content gutter as list view');
            await checkPointerStates(
                item('package.json'),
                'grid uses the same unambiguous hover and selection states as list',
            );
            await item('README.md').locator('[data-file-select]').click();
            check(
                'grid checkbox shares modifier-free multi-selection and size feedback with list',
                (await page.getByRole('option', { selected: true }).count()) === 2 &&
                    (await summary.textContent())!.includes('5.1 KB'),
            );
            check(
                'grid and list share the same theme-accent checkbox colors',
                await item('package.json')
                    .locator('.files-selection-box')
                    .evaluate((el) => {
                        const style = getComputedStyle(el);
                        return (
                            style.backgroundColor === 'rgb(245, 156, 119)' &&
                            style.color === 'rgb(0, 0, 0)'
                        );
                    }),
            );
            await checkGridCheckbox(
                item('package.json'),
                'grid tiles keep the checkbox in a consistent leading corner inside the tile',
            );
            await screenshot('files-production-grid');
            await page.evaluate(() => window.filesUiTest.marqueeFiles());
            await item('file-0030.ts').waitFor();
            const smallBand = await gridBand();
            check(
                'the regression fixture exercises five columns across three grid rows',
                smallBand.expected.length === 15,
            );
            await item(smallBand.outside).evaluate((el) => {
                const range = document.createRange();
                range.selectNodeContents(el.querySelector<HTMLElement>('.select-text')!);
                const selection = window.getSelection();
                selection!.removeAllRanges();
                selection!.addRange(range);
            });
            await dragBand(smallBand, 'small grid marquee');
            check(
                'grid filename text policy is restored after a completed marquee',
                await item(smallBand.outside)
                    .locator('.select-text')
                    .evaluate((el) => getComputedStyle(el).userSelect === 'text'),
            );
            await screenshot('files-production-marquee-selection');
            await item(smallBand.outside).click();
            await dragBand(smallBand, 'reverse additive marquee', {
                additive: true,
                reverse: true,
            });
            await dragBand(smallBand, 'interrupted marquee', { interrupted: true });
            await item(smallBand.outside).evaluate((el) =>
                el.ownerDocument.addEventListener(
                    'pointerdown',
                    (event) => {
                        el.dataset.pointerPrevented = String(event.defaultPrevented);
                    },
                    { once: true },
                ),
            );
            await item(smallBand.outside).click();
            check(
                'file items retain uncanceled pointer events and remain draggable',
                (await item(smallBand.outside).getAttribute('data-pointer-prevented')) ===
                    'false' && (await item(smallBand.outside).getAttribute('draggable')) === 'true',
            );
            await page.evaluate(() => window.filesUiTest.manyFiles());
            await page.waitForFunction(() =>
                document
                    .querySelector<HTMLElement>('[role="status"]')
                    ?.textContent!.includes('1000 items'),
            );
            const gridCount = await page.locator('[id^="file-item-"]').count();
            check('large icon listings retain virtualization', gridCount > 0 && gridCount < 1000);
            await dragBand(await gridBand(), 'virtual grid marquee');
            await listing.focus();
            await page.keyboard.press('End');
            await item('file-0999.ts').waitFor();
            await page.waitForFunction(
                () =>
                    document
                        .getElementById(
                            document
                                .querySelector<HTMLElement>('[role="listbox"]')
                                ?.getAttribute('aria-activedescendant') ?? '',
                        )
                        ?.getAttribute('data-file-name') === 'file-0999.ts',
            );
            check(
                'virtual grid End scrolls the final option into view and exposes its total position',
                (await item('file-0999.ts').getAttribute('aria-posinset')) === '1000' &&
                    (await item('file-0999.ts').getAttribute('aria-setsize')) === '1000',
            );
            await checkGridCheckbox(
                item('file-0999.ts'),
                'virtual grid tiles use the same leading selection position',
            );
            await clickMenu('View', 'List view', 'menuitemradio');
            const listCount = await page.locator('[id^="file-item-"]').count();
            check('large list listings retain virtualization', listCount > 0 && listCount < 1000);
            await listing.focus();
            await page.keyboard.press('End');
            await item('file-0999.ts').waitFor();
            check(
                'scrolling to the final virtual row keeps bottom and side breathing room',
                await item('file-0999.ts').evaluate((el) => {
                    const bounds = el
                        .closest<HTMLElement>('.files-listing-list')!
                        .getBoundingClientRect();
                    const row = el.getBoundingClientRect();
                    return (
                        row.bottom <= bounds.bottom - 24 + 1 &&
                        row.left >= bounds.left + 24 &&
                        row.right <= bounds.right - 24
                    );
                }),
            );
            await page.keyboard.press('Home');
            await item('file-0000.ts').waitFor();
            const listBand = await listing.evaluate((el) => {
                const rows = [...el.querySelectorAll<HTMLElement>('[data-file-name]')].slice(0, 3);
                const first = rows[0].getBoundingClientRect();
                const last = rows[2].getBoundingClientRect();
                return {
                    start: { x: first.right + 2, y: first.top - 2 },
                    end: { x: first.left + 40, y: last.bottom - 1 },
                    expected: rows.map((row) => row.dataset.fileName),
                };
            });
            await dragBand(listBand, 'virtual list marquee');
            check(
                'virtual lists contain no conflicting row/gridcell roles',
                (await listing
                    .locator('[role="row"], [role="gridcell"], [role="listitem"]')
                    .count()) === 0,
            );
            await page.evaluate(() => window.filesUiTest.restore());
            await item('src').dblclick();
            await page.getByText('This folder is empty', { exact: true }).waitFor();
            check(
                'empty folders describe available controls instead of claiming disabled browser uploads',
                await page
                    .getByText('Create a file or folder with New, or choose Upload to add files.', {
                        exact: true,
                    })
                    .isVisible(),
            );
            await page.getByRole('button', { name: 'Back', exact: true }).click();
            await item('README.md').waitFor();
            check(
                'folder navigation and history use real browsing state',
                await page.getByRole('button', { name: 'Forward', exact: true }).isEnabled(),
            );
            for (const label of await page.evaluate(() =>
                window.runFileListingAccessBrowserChecks(),
            )) {
                check(label, true);
            }
            await page.evaluate(() => window.filesUiTest.failListing());
            await clickMenu('Folder actions', 'Reload');
            await page.getByRole('alert').waitFor();
            check(
                'listing failures are visible with an explicit recovery action',
                (await page.getByRole('alert').textContent())!.includes(
                    'Sample permission denied',
                ) && (await page.getByRole('button', { name: 'Retry', exact: true }).isVisible()),
            );
            await page.getByRole('button', { name: 'Retry', exact: true }).click();
            await page.getByRole('alert').waitFor({ state: 'detached' });
            check(
                'Retry clears the error through the real refresh action',
                await item('README.md').isVisible(),
            );
            await page.getByRole('button', { name: 'View', exact: true }).focus();
            await page.locator('[data-zync-tooltip]').first().waitFor();
            check(
                'noninteractive tooltip wrappers cannot cover underlying controls',
                await page
                    .locator('[data-radix-popper-content-wrapper]:has(> [data-zync-tooltip])')
                    .evaluateAll(
                        (elements) =>
                            elements.length > 0 &&
                            elements.every((el) => getComputedStyle(el).pointerEvents === 'none'),
                    ),
            );
            await page.evaluate(() => window.filesUiTest.longNames());
            await page.waitForFunction(
                () =>
                    !document
                        .querySelector<HTMLElement>('.files-summary-count')
                        ?.textContent!.includes('selected'),
            );
            check(
                'refreshing a listing prunes vanished selections but filtering does not',
                (await page.getByRole('option', { selected: true }).count()) === 0,
            );
            await page.setViewportSize({ width: 320, height: 640 });
            const longOption = page.getByRole('option', { name: /^project-long-filename-/ });
            check(
                'long names retain a visible short extension and their full accessible name',
                (await longOption
                    .locator('[aria-label^="project-long-filename-"]')
                    .textContent()
                    .then((text) => text!.endsWith('.ts'))) &&
                    (await longOption
                        .getAttribute('aria-label')
                        .then((text) => text!.length > 200)),
            );
            check(
                'literal unusual filenames are exposed as text, never DOM identities',
                (await page
                    .getByRole('option', {
                        name: 'odd "quote" [draft] 🦄.txt, TXT File',
                        exact: true,
                    })
                    .count()) === 1 &&
                    (await page
                        .locator('[data-file-name]')
                        .evaluateAll((elements) =>
                            elements.every((el) => !el.id.includes(el.dataset.fileName!)),
                        )),
            );
            await checkLeadingCheckbox(
                longOption,
                'narrow rows retain leading checkbox alignment without crowding the filename',
            );
            await page.evaluate(() => {
                const palette = {
                    '--color-app-bg': '#ffffff',
                    '--color-app-panel': '#f4f4f5',
                    '--color-app-surface': '#e4e4e7',
                    '--color-app-border': '#d4d4d8',
                    '--color-app-text': '#18181b',
                    '--color-app-muted': '#52525b',
                };
                for (const [key, value] of Object.entries(palette)) {
                    document.documentElement.style.setProperty(key, value);
                }
            });
            await screenshot('files-production-light-narrow');
            check(
                'light-theme filenames use the scoped foreground rather than inherited dark text',
                await longOption
                    .locator('[aria-label^="project-long-filename-"]')
                    .evaluate((el) => getComputedStyle(el).color === 'rgb(24, 24, 27)'),
            );
            await checkPointerStates(
                longOption,
                'light list distinguishes neutral hover from accented selection and selected hover',
            );
            await screenshot('files-production-light-selected');
            await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
            await page.emulateMedia({ forcedColors: 'active' });
            await listing.focus();
            await page.keyboard.press('Home');
            await page.keyboard.press('Space');
            check(
                'forced colors retain a non-color-only selection indicator',
                await page
                    .getByRole('option', { selected: true })
                    .evaluate((el) => getComputedStyle(el).outlineStyle !== 'none'),
            );
            check(
                'forced colors retain system-owned checked colors instead of the theme accent',
                await page
                    .getByRole('option', { selected: true })
                    .locator('.files-selection-box')
                    .evaluate((el) => {
                        const style = getComputedStyle(el);
                        return (
                            style.forcedColorAdjust === 'none' &&
                            style.color !== style.backgroundColor &&
                            style.backgroundColor !== 'rgb(245, 156, 119)'
                        );
                    }),
            );
            await page.emulateMedia({ forcedColors: 'none' });
            await page.evaluate(() => {
                document.documentElement.removeAttribute('style');
                window.filesUiTest.restore();
            });
            await page.setViewportSize({ width: 1200, height: 800 });
            check(
                'UI changes only save explicitly chosen view/visibility preferences',
                await page.evaluate(() =>
                    window.filesUiTest.settingsWrites.every((write) =>
                        Object.keys(write).every((key) =>
                            ['defaultView', 'showHiddenFiles'].includes(key),
                        ),
                    ),
                ),
            );
            check(
                'no unexpected native, network or browser errors',
                errors.length === 0 &&
                    requests.length === 0 &&
                    (await page.evaluate(() =>
                        window.filesUiTest.calls.every((command) =>
                            [
                                'fs_list',
                                'fs_exists',
                                'fs_cwd',
                                'fs_permissions_read',
                                'fs_copy_access',
                                'dialog:openFile',
                                'dialog:openDirectory',
                            ].includes(command),
                        ),
                    )),
            );
            await page.evaluate(() => window.filesUiTest.preference({ showHiddenFiles: false }));
            await item('README.md').locator('[data-file-select]').click();
            const folderSwitch = page.getByRole('button', { name: 'Folders in Home', exact: true });
            const beforeFolderMenu = await page.evaluate(() =>
                JSON.stringify(window.filesUiTest.listingSnapshot()),
            );
            const beforeParentReads = await page.evaluate(
                () => window.filesUiTest.listingReads.length,
            );
            await folderSwitch.focus();
            await page.keyboard.press('ArrowDown');
            const siblingsMenu = page.getByRole('menu', { name: 'Folders in Home', exact: true });
            await siblingsMenu.waitFor();
            check(
                'breadcrumb chevrons load sibling folders on demand and apply the hidden-file policy',
                (await siblingsMenu.getByRole('menuitemradio').allTextContents()).join('|') ===
                    'archive|project|release candidate  ' &&
                    (await page.evaluate(
                        (previous) =>
                            window.filesUiTest.listingReads.length === previous + 1 &&
                            window.filesUiTest.listingReads.at(-1)! === '/home/deploy',
                        beforeParentReads,
                    )),
            );
            check(
                'folder menu marks the current child and supports keyboard focus',
                (await siblingsMenu
                    .getByRole('menuitemradio', { name: 'project', exact: true })
                    .getAttribute('aria-checked')) === 'true' &&
                    (await siblingsMenu.evaluate((el) => el.contains(document.activeElement))),
            );
            check(
                'opening folder choices cannot overwrite listing, history, loading or selection state',
                beforeFolderMenu ===
                    (await page.evaluate(() =>
                        JSON.stringify(window.filesUiTest.listingSnapshot()),
                    )) && (await item('README.md').getAttribute('aria-selected')) === 'true',
            );
            await screenshot('files-production-folder-switch');
            await page.keyboard.press('Escape');
            check(
                'folder-menu Escape restores its own separator control',
                await folderSwitch.evaluate((el) => el === document.activeElement),
            );
            await page.evaluate(() => window.filesUiTest.failListing());
            await folderSwitch.click();
            await siblingsMenu.getByRole('menuitem', { name: 'Retry', exact: true }).waitFor();
            check(
                'folder-read failure stays inside the menu without damaging the active listing',
                (await siblingsMenu
                    .getByRole('menuitem', { name: 'Unable to load folders', exact: true })
                    .isDisabled()) &&
                    (await page.getByRole('alert').count()) === 0 &&
                    (await item('README.md').isVisible()),
            );
            await siblingsMenu.getByRole('menuitem', { name: 'Retry', exact: true }).click();
            await siblingsMenu
                .getByRole('menuitemradio', { name: 'archive', exact: true })
                .waitFor();
            check('folder-menu Retry performs a fresh read and restores usable options', true);
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.filesUiTest.deferFolders());
            await folderSwitch.click();
            check(
                'a deferred folder read keeps focus on an explicitly busy trigger',
                (await folderSwitch.getAttribute('aria-busy')) === 'true' &&
                    (await folderSwitch.evaluate((el) => el === document.activeElement)),
            );
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.filesUiTest.finishFolders());
            check(
                'Escape cancels a deferred menu without reopening it when the reply arrives',
                (await siblingsMenu.count()) === 0 &&
                    (await folderSwitch.evaluate((el) => el === document.activeElement)) &&
                    (await folderSwitch.getAttribute('aria-busy')) !== 'true',
            );
            await page.evaluate(() => window.filesUiTest.deferFolders());
            await folderSwitch.click();
            await newButton.focus();
            await page.evaluate(() => window.filesUiTest.finishFolders());
            check(
                'leaving a busy separator cancels its reply without stealing focus',
                (await siblingsMenu.count()) === 0 &&
                    (await newButton.evaluate((el) => el === document.activeElement)),
            );
            await page.evaluate(() => window.filesUiTest.deferFolders());
            await folderSwitch.click();
            await page.evaluate(() =>
                window.filesUiTest.breadcrumbPath('/home/deploy/project/elsewhere'),
            );
            await page.evaluate(() => window.filesUiTest.finishFolders());
            check(
                'navigation invalidates deferred folder choices from the previous location',
                (await page.getByRole('menu').count()) === 0 &&
                    (await pathBar
                        .getByRole('button', { name: 'elsewhere', exact: true })
                        .isVisible()),
            );
            await page.evaluate(() => window.filesUiTest.restore());
            await item('README.md').waitFor();
            await folderSwitch.click();
            await siblingsMenu.getByRole('menuitemradio', { name: 'archive', exact: true }).click();
            await page.waitForFunction(() => window.filesUiTest.path() === '/home/deploy/archive');
            check(
                'choosing a sibling delegates to the existing navigation and history owner',
                await page.getByText('This folder is empty', { exact: true }).isVisible(),
            );
            await page.getByRole('button', { name: 'Back', exact: true }).click();
            await item('README.md').waitFor();
            await page.evaluate(() => window.filesUiTest.preference({ showHiddenFiles: true }));
            await folderSwitch.click();
            check(
                'show-hidden preference also governs folder switching',
                await siblingsMenu
                    .getByRole('menuitemradio', { name: '.private', exact: true })
                    .isVisible(),
            );
            await page.keyboard.press('Escape');
            // Transient dialogs belong to a visible workspace surface; hiding it must not steal peer focus.
            const lifecycleViewport = page.viewportSize();
            const leaveFiles = async () =>
                page.evaluate(() => {
                    const peer = document.createElement('button');
                    peer.id = 'files-peer-focus';
                    peer.textContent = 'Peer control';
                    document.body.append(peer);
                    peer.focus();
                    window.filesUiTest.surfaceActive(false);
                });
            const returnFiles = async () => {
                await page.evaluate(() => {
                    document.getElementById('files-peer-focus')?.remove();
                    window.filesUiTest.surfaceActive(true);
                });
                await listing.waitFor({ state: 'visible' });
            };
            await page.setViewportSize({ width: 800, height: 700 });
            await item('README.md').click();
            await page.getByRole('button', { name: 'Inspect selection', exact: true }).click();
            const inactiveProperties = page.getByRole('dialog', {
                name: 'Properties',
                exact: true,
            });
            await inactiveProperties.waitFor();
            await leaveFiles();
            await inactiveProperties.waitFor({ state: 'detached' });
            check(
                'inactive Files dismisses modal Properties without restoring focus into its hidden pane',
                await page.evaluate(() => document.activeElement?.id === 'files-peer-focus'),
            );
            await returnFiles();
            check(
                'returning to Files does not reopen dismissed Properties',
                (await inactiveProperties.count()) === 0,
            );

            await page.setViewportSize({ width: 600, height: 700 });
            await page.getByRole('button', { name: 'Show places', exact: true }).click();
            const inactivePlaces = page.getByRole('dialog', { name: 'Places', exact: true });
            await inactivePlaces.waitFor();
            await leaveFiles();
            await inactivePlaces.waitFor({ state: 'detached' });
            check(
                'inactive Files dismisses modal Places without stealing focus from the new surface',
                await page.evaluate(() => document.activeElement?.id === 'files-peer-focus'),
            );
            await returnFiles();
            check(
                'returning to Files does not reopen dismissed Places',
                (await inactivePlaces.count()) === 0,
            );

            await page.setViewportSize({ width: 1200, height: 800 });
            await page.getByRole('button', { name: 'Inspect selection', exact: true }).click();
            const retainedInspector = page.getByRole('complementary', {
                name: 'File properties',
                exact: true,
            });
            await retainedInspector.waitFor();
            await leaveFiles();
            await returnFiles();
            check(
                'inline Properties remains retained when its Files pane is reactivated',
                (await retainedInspector.isVisible()) && (await inactiveProperties.count()) === 0,
            );
            await page.getByRole('button', { name: 'Hide properties', exact: true }).click();
            await page.setViewportSize(lifecycleViewport!);

            await page.evaluate(() => window.filesUiTest.twoPanes());
            await page.waitForFunction(
                () => document.querySelectorAll<HTMLElement>('[role="listbox"]').length === 2,
            );
            const firstPane = page.getByRole('listbox').first();
            const secondPane = page.getByRole('listbox').last();
            await firstPane.focus();
            await page.keyboard.press('Home');
            await page.keyboard.press('Space');
            check(
                'two same-host Files panes keep keyboard selection isolated',
                (await firstPane.getByRole('option', { selected: true }).count()) === 1 &&
                    (await secondPane.getByRole('option', { selected: true }).count()) === 0,
            );
            check(
                'file IDs are unique even when both panes contain identical names',
                await page
                    .locator('[data-file-name]')
                    .evaluateAll(
                        (elements) => new Set(elements.map((el) => el.id)).size === elements.length,
                    ),
            );
            await page.keyboard.press('Shift+F10');
            await page.getByRole('menu').waitFor();
            check(
                'keyboard file context menu focuses its action',
                await page.getByRole('menu').evaluate((el) => el.contains(document.activeElement)),
            );
            await page.keyboard.press('Escape');
            check(
                'keyboard context menu returns to its own Files widget',
                await firstPane.evaluate((el) => document.activeElement === el),
            );
            await page.setViewportSize({ width: 320, height: 640 });
            check(
                'narrow split layout never creates horizontal page overflow',
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= window.innerWidth,
                ),
            );
            const unfilteredFirstCount = await firstPane.getByRole('option').count();
            const unfilteredPeerCount = await secondPane.getByRole('option').count();
            await page
                .getByRole('button', { name: 'Filter this folder', exact: true })
                .first()
                .click();
            await page
                .getByRole('textbox', { name: 'Search this folder', exact: true })
                .fill('read');
            check(
                'a very narrow split keeps the filter editor within its own content width',
                await page
                    .locator('.files-query-editor')
                    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
            );
            check(
                'narrow split filtering still uses its own listing',
                (await firstPane.getByRole('option').count()) === 1 &&
                    (await secondPane.getByRole('option').count()) === unfilteredPeerCount,
            );
            await page.keyboard.press('Escape');
            check(
                'narrow filter dismissal restores its trigger and inventory',
                (await firstPane.getByRole('option').count()) === unfilteredFirstCount &&
                    (await page
                        .getByRole('button', { name: 'Filter this folder', exact: true })
                        .first()
                        .evaluate((el) => document.activeElement === el)),
            );
            const narrowFolderSwitch = page
                .getByRole('navigation', { name: 'Folder path', exact: true })
                .first()
                .getByRole('button', { name: 'Folders in Home', exact: true });
            await narrowFolderSwitch.click();
            const narrowFolderMenu = page.getByRole('menu', {
                name: 'Folders in Home',
                exact: true,
            });
            await narrowFolderMenu.waitFor();
            check(
                'folder switching remains reachable and viewport-bounded in a very narrow split',
                await narrowFolderMenu.evaluate((el) => {
                    const rect = el.getBoundingClientRect();
                    return (
                        rect.left >= 0 &&
                        rect.right <= window.innerWidth &&
                        rect.bottom <= window.innerHeight
                    );
                }),
            );
            await page.keyboard.press('Escape');
            check(
                'narrow folder menu returns focus to its own pane without affecting peer selection',
                (await narrowFolderSwitch.evaluate((el) => el === document.activeElement)) &&
                    (await secondPane.getByRole('option', { selected: true }).count()) === 0,
            );
            await page.setViewportSize({ width: 1200, height: 800 });
            const firstPathBar = page
                .getByRole('navigation', { name: 'Folder path', exact: true })
                .first();
            const firstEditLocation = firstPathBar.getByRole('button', {
                name: 'Edit location',
                exact: true,
            });
            await firstEditLocation.click();
            const pathInput = page.getByRole('combobox', { name: 'Path', exact: true });
            check(
                'explicit path editing retains the complete literal location and input focus',
                (await pathInput.inputValue()) === '/home/deploy/project' &&
                    (await pathInput.evaluate((el) => el === document.activeElement)),
            );
            const folderSuggestions = page.getByRole('listbox', {
                name: 'Folder suggestions',
                exact: true,
            });
            const autocompleteSnapshot = await page.evaluate(() =>
                JSON.stringify(window.filesUiTest.listingSnapshot()),
            );
            const readsBeforeAutocomplete = await page.evaluate(
                () => window.filesUiTest.listingReads.length,
            );
            await pathInput.fill('/home/deploy/project/');
            await folderSuggestions.getByRole('option', { name: 'config', exact: true }).waitFor();
            check(
                'typing a separator reveals the next folders without changing the current listing or history',
                (await folderSuggestions.getByRole('option').count()) === 6 &&
                    autocompleteSnapshot ===
                        (await page.evaluate(() =>
                            JSON.stringify(window.filesUiTest.listingSnapshot()),
                        )),
            );
            check(
                'the path combobox owns its suggestion list without moving DOM focus',
                (await pathInput.getAttribute('aria-controls')) ===
                    (await folderSuggestions.getAttribute('id')) &&
                    (await pathInput.getAttribute('aria-autocomplete')) === 'list' &&
                    (await pathInput.evaluate((el) => el === document.activeElement)),
            );
            await screenshot('files-production-path-suggestions');
            await pathInput.fill('/home/deploy/project/s');
            check(
                'typing a prefix filters folders locally rather than reading the parent again',
                (await folderSuggestions.getByRole('option').allTextContents()).join('|') ===
                    'scripts|src' &&
                    (await page.evaluate(
                        (before) => window.filesUiTest.listingReads.length === before + 1,
                        readsBeforeAutocomplete,
                    )),
            );
            await pathInput.fill('/home/deploy/project/co');
            await page.keyboard.press('ArrowDown');
            check(
                'arrows expose one active suggestion while the editable text and listing selection stay unchanged',
                (await folderSuggestions
                    .getByRole('option', { selected: true })
                    .getAttribute('aria-label')) === 'config' &&
                    (await pathInput.inputValue()) === '/home/deploy/project/co' &&
                    (await pathInput.evaluate((el) => el === document.activeElement)),
            );
            await page.keyboard.press('Tab');
            await folderSuggestions
                .getByRole('option', { name: 'environments', exact: true })
                .waitFor();
            check(
                'Tab completes a selected folder and immediately offers its children',
                (await pathInput.inputValue()) === '/home/deploy/project/config/' &&
                    (await pathInput.evaluate((el) => el === document.activeElement)) &&
                    (await page.evaluate(
                        () => window.filesUiTest.path() === '/home/deploy/project',
                    )),
            );
            await folderSuggestions
                .getByRole('option', { name: 'environments', exact: true })
                .click();
            await folderSuggestions
                .getByRole('option', { name: 'production', exact: true })
                .waitFor();
            check(
                'pointer completion keeps editing active and supports finding another folder level',
                (await pathInput.inputValue()) === '/home/deploy/project/config/environments/' &&
                    (await pathInput.evaluate((el) => el === document.activeElement)),
            );
            await folderSuggestions
                .getByRole('option', { name: 'production', exact: true })
                .click();
            await page.keyboard.press('Enter');
            await page.waitForFunction(
                () =>
                    window.filesUiTest.path() ===
                    '/home/deploy/project/config/environments/production/',
            );
            check(
                'Enter opens the completed path through the existing navigation owner',
                (await pathInput.count()) === 0 &&
                    (await firstEditLocation.evaluate((el) => el === document.activeElement)),
            );
            await page.evaluate(() => window.filesUiTest.restore());
            await firstEditLocation.click();
            await pathInput.fill('~/arch');
            await folderSuggestions.getByRole('option', { name: 'archive', exact: true }).waitFor();
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.filesUiTest.path() === '/home/deploy/archive');
            check(
                'Enter can open an explicitly highlighted home-relative suggestion',
                (await pathInput.count()) === 0,
            );
            await page.evaluate(() => window.filesUiTest.restore());
            await firstEditLocation.click();
            await page.evaluate(() => window.filesUiTest.deferFolders());
            await pathInput.fill('/home/deploy/a');
            await page.waitForFunction(() => window.filesUiTest.foldersPending());
            await pathInput.fill('/home/deploy/project/co');
            await folderSuggestions.getByRole('option', { name: 'config', exact: true }).waitFor();
            await page.evaluate(() => window.filesUiTest.finishFolders());
            check(
                'late parent replies cannot replace suggestions for a newer typed path',
                (await folderSuggestions.getByRole('option').count()) === 1 &&
                    (await folderSuggestions
                        .getByRole('option', { name: 'config', exact: true })
                        .isVisible()),
            );
            await page.getByRole('button', { name: 'Cancel path edit', exact: true }).click();
            await firstEditLocation.click();
            await page.evaluate(() => window.filesUiTest.deferFolders());
            await pathInput.fill('/home/deploy/a');
            await page.waitForFunction(() => window.filesUiTest.foldersPending());
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.filesUiTest.finishFolders());
            check(
                'canceling an edit invalidates deferred suggestions without stealing breadcrumb focus',
                (await pathInput.count()) === 0 &&
                    (await folderSuggestions.count()) === 0 &&
                    (await firstPathBar
                        .locator('[data-file-path-current]')
                        .evaluate((el) => el === document.activeElement)),
            );
            await firstEditLocation.click();
            const beforeSuggestionError = await page.evaluate(() =>
                JSON.stringify(window.filesUiTest.listingSnapshot()),
            );
            await page.evaluate(() => window.filesUiTest.failListing());
            await pathInput.fill('/home/deploy/project/co');
            await page
                .getByText('Unable to load folders. Press ↓ to retry, or enter a path.', {
                    exact: true,
                })
                .waitFor();
            check(
                'suggestion failures stay separate from the main listing and manual path entry',
                (await pathInput.evaluate((el) => el === document.activeElement)) &&
                    beforeSuggestionError ===
                        (await page.evaluate(() =>
                            JSON.stringify(window.filesUiTest.listingSnapshot()),
                        )) &&
                    (await page.getByRole('alert').count()) === 0,
            );
            await page.keyboard.press('ArrowDown');
            await folderSuggestions.getByRole('option', { name: 'config', exact: true }).waitFor();
            check('Down retries a failed suggestion read without another toolbar action', true);
            await page.getByRole('button', { name: 'Cancel path edit', exact: true }).click();
            await firstEditLocation.click();
            await pathInput.fill('/home/deploy/project/missing');
            await page
                .getByText('No matching folders. You can still enter a path.', { exact: true })
                .waitFor();
            await page.keyboard.press('Enter');
            await page.waitForFunction(
                () =>
                    document
                        .querySelector<HTMLElement>('[role="combobox"][aria-label="Path"]')
                        ?.getAttribute('aria-invalid') === 'true',
            );
            check(
                'manual paths still validate explicitly when suggestions do not match',
                (await pathInput.getAttribute('aria-invalid')) === 'true' &&
                    (await page
                        .getByRole('alert')
                        .textContent()
                        .then((text) => text!.includes('Path not found'))) &&
                    (await page.evaluate(
                        () => window.filesUiTest.path() === '/home/deploy/project',
                    )),
            );
            await pathInput.fill('/home/deploy/project/co');
            check(
                'editing a rejected path clears its invalid state',
                (await pathInput.getAttribute('aria-invalid')) === 'false',
            );
            await page.getByRole('button', { name: 'Cancel path edit', exact: true }).click();
            await firstEditLocation.click();
            await page.evaluate(() => window.filesUiTest.deferPathCheck());
            await pathInput.fill('/home/deploy/project/late');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.filesUiTest.pathCheckPending());
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.filesUiTest.finishPathCheck());
            check(
                'late existence checks cannot navigate after path editing was canceled',
                (await page.evaluate(() => window.filesUiTest.path() === '/home/deploy/project')) &&
                    (await pathInput.count()) === 0,
            );
            await firstEditLocation.click();
            await pathInput.dispatchEvent('compositionstart');
            await pathInput.fill('/home/deploy/project/co');
            await page.keyboard.press('Enter');
            check(
                'IME composition does not open suggestions or submit a path prematurely',
                (await pathInput.count()) === 1 &&
                    (await pathInput.getAttribute('aria-expanded')) === 'false' &&
                    (await page.evaluate(
                        () => window.filesUiTest.path() === '/home/deploy/project',
                    )),
            );
            await pathInput.dispatchEvent('compositionend');
            await folderSuggestions.getByRole('option', { name: 'config', exact: true }).waitFor();
            check(
                'finishing composition resumes suggestions for the final input',
                (await folderSuggestions.getByRole('option').count()) === 1,
            );
            await page.evaluate(() => window.filesUiTest.deferPathCheck());
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.filesUiTest.pathCheckPending());
            check(
                'accepting a suggestion displays its complete path while validation is pending',
                (await pathInput.inputValue()) === '/home/deploy/project/config',
            );
            await page.keyboard.press('ArrowDown');
            await page.evaluate(() => window.filesUiTest.finishPathCheck());
            check(
                'resuming suggestion selection cancels an older pending submission',
                (await pathInput.count()) === 1 &&
                    (await page.evaluate(
                        () => window.filesUiTest.path() === '/home/deploy/project',
                    )),
            );
            await page.getByRole('button', { name: 'Cancel path edit', exact: true }).click();
            await firstEditLocation.click();
            await pathInput.fill('/home/deploy/project/');
            await folderSuggestions.getByRole('option', { name: 'tests', exact: true }).waitFor();
            await page.setViewportSize({ width: 320, height: 640 });
            check(
                'typing suggestions remain viewport-bounded and focused in a narrow split',
                (await folderSuggestions.evaluate((el) => {
                    const bounds = el
                        .closest<HTMLElement>('.files-path-completions')!
                        .getBoundingClientRect();
                    return (
                        bounds.left >= 0 &&
                        bounds.right <= window.innerWidth &&
                        bounds.bottom <= window.innerHeight
                    );
                })) && (await pathInput.evaluate((el) => el === document.activeElement)),
            );
            await page.keyboard.press('ArrowUp');
            check(
                'keyboard suggestion focus always references a mounted, visible option',
                await pathInput.evaluate((el) => {
                    const option = document.getElementById(
                        el.getAttribute('aria-activedescendant')!,
                    )!;
                    const bounds = option?.getBoundingClientRect();
                    return (
                        option?.getAttribute('aria-selected') === 'true' &&
                        bounds.top >= 0 &&
                        bounds.bottom <= window.innerHeight
                    );
                }),
            );
            await page.emulateMedia({ forcedColors: 'active' });
            check(
                'path suggestions retain a visible keyboard selection outline in forced colors',
                await folderSuggestions
                    .getByRole('option', { selected: true })
                    .evaluate((el) => getComputedStyle(el).outlineStyle === 'solid'),
            );
            await page.emulateMedia({ forcedColors: 'none' });
            await screenshot('files-production-path-suggestions-narrow');
            await page.setViewportSize({ width: 1200, height: 800 });
            await page.getByRole('button', { name: 'Cancel path edit', exact: true }).click();
            await firstEditLocation.click();
            await pathInput.fill('/home/deploy/discarded');
            await page.keyboard.press('Escape');
            check(
                'first Escape dismisses path suggestions without discarding the draft',
                (await pathInput.inputValue()) === '/home/deploy/discarded' &&
                    (await pathInput.getAttribute('aria-expanded')) === 'false',
            );
            await page.keyboard.press('Escape');
            check(
                'canceling a path edit preserves navigation and restores a reachable breadcrumb',
                (await page.evaluate(() => window.filesUiTest.path() === '/home/deploy/project')) &&
                    (await firstPathBar
                        .locator('[data-file-path-current]')
                        .evaluate((el) => el === document.activeElement)),
            );
            await firstEditLocation.click();
            await page.getByRole('button', { name: 'Cancel path edit', exact: true }).click();
            check(
                'pointer cancellation has the same focus owner as Escape',
                await firstPathBar
                    .locator('[data-file-path-current]')
                    .evaluate((el) => el === document.activeElement),
            );
            await firstEditLocation.click();
            await page.keyboard.press('Tab');
            check(
                'keyboard users can reach Cancel without path-edit blur unmounting it',
                await page
                    .getByRole('button', { name: 'Cancel path edit', exact: true })
                    .evaluate((el) => el === document.activeElement),
            );
            await page.keyboard.press('Enter');
            check(
                'keyboard cancellation returns to the current folder',
                await firstPathBar
                    .locator('[data-file-path-current]')
                    .evaluate((el) => el === document.activeElement),
            );
            await firstEditLocation.click();
            const literalPath = '/home/deploy/project/release candidate  ';
            await page.getByRole('combobox', { name: 'Path', exact: true }).fill(literalPath);
            await page.keyboard.press('Enter');
            await page.waitForFunction(
                (expected) => window.filesUiTest.path() === expected,
                literalPath,
            );
            check(
                'path submission preserves valid trailing folder-name spaces',
                (await firstPathBar
                    .locator('[aria-current="location"]')
                    .getAttribute('aria-label')) === 'release candidate  ',
            );
            check(
                'path submission restores a stable editor action rather than a disappearing leaf',
                await firstEditLocation.evaluate((el) => el === document.activeElement),
            );
            check(
                'restored path controls retain a compact inset keyboard ring rather than a clipped outer ring',
                await firstEditLocation.evaluate((el) => {
                    const shadow = getComputedStyle(el).boxShadow;
                    return (
                        el.matches(':focus-visible') &&
                        shadow.includes('inset') &&
                        shadow.includes('1px') &&
                        !shadow.includes('2px')
                    );
                }),
            );
            await screenshot('files-production-path-focus-inset');
            await page.emulateMedia({ forcedColors: 'active' });
            check(
                'compact breadcrumb focus remains visible in forced colors',
                await firstEditLocation.evaluate((el) => {
                    const style = getComputedStyle(el);
                    return (
                        style.outlineStyle === 'solid' &&
                        style.outlineWidth === '1px' &&
                        style.outlineOffset === '-1px'
                    );
                }),
            );
            await page.emulateMedia({ forcedColors: 'none' });
            await page.evaluate(() =>
                window.filesUiTest.breadcrumbPath('/home/deploy/project/later-listing'),
            );
            await firstPathBar
                .getByRole('button', { name: 'later-listing', exact: true })
                .waitFor();
            check(
                'focus survives a later folder publication without reopening the editor',
                await firstEditLocation.evaluate((el) => el === document.activeElement),
            );
            const deepPath =
                '/home/deploy/project/services/catalog/src/modules/catalog/releases/config';
            await page.evaluate((path) => window.filesUiTest.breadcrumbPath(path), deepPath);
            await firstPathBar.getByRole('button', { name: 'config', exact: true }).waitFor();
            await firstPathBar.getByRole('button', { name: 'Home', exact: true }).focus();
            await page.setViewportSize({ width: 320, height: 640 });
            await page.waitForFunction(
                () =>
                    document.querySelector<HTMLElement>('[data-file-path-current]')! ===
                    document.activeElement,
            );
            check(
                'folding a focused ancestor on resize keeps focus in the location bar',
                await firstPathBar
                    .locator('[data-file-path-current]')
                    .evaluate((el) => el === document.activeElement),
            );
            check(
                'deep paths retain a visible leaf without scrolling or overlapping the edit control',
                (await firstPathBar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)) &&
                    (await firstPathBar
                        .locator('[data-file-path-current]')
                        .evaluate((el) => el.getBoundingClientRect().width >= 24)),
            );
            const parents = firstPathBar.getByRole('button', {
                name: 'Hidden parent folders',
                exact: true,
            });
            await parents.focus();
            await page.keyboard.press('ArrowDown');
            const parentMenu = page.getByRole('menu', {
                name: 'Hidden parent folders',
                exact: true,
            });
            check(
                'folded ancestors remain ordered native-path actions in the shared keyboard menu',
                (await parentMenu.getByRole('menuitem').allTextContents()).join('|') ===
                    [
                        '/home/deploy',
                        '/home/deploy/project',
                        '/home/deploy/project/services',
                        '/home/deploy/project/services/catalog',
                        '/home/deploy/project/services/catalog/src',
                        '/home/deploy/project/services/catalog/src/modules',
                        '/home/deploy/project/services/catalog/src/modules/catalog',
                        '/home/deploy/project/services/catalog/src/modules/catalog/releases',
                    ].join('|'),
            );
            await page.keyboard.press('Escape');
            check(
                'the parent menu restores its own trigger rather than the Files listing',
                await parents.evaluate((el) => el === document.activeElement),
            );
            await page.setViewportSize({ width: 1200, height: 800 });
            check(
                'resizing retains the same focused overflow trigger when its position changes',
                await parents.evaluate((el) => el === document.activeElement),
            );
            await parents.click();
            await page.getByRole('menuitem', { name: '/home/deploy/project', exact: true }).click();
            await page.waitForFunction(() => window.filesUiTest.path() === '/home/deploy/project');
            check(
                'folded-parent navigation calls the existing browsing owner',
                (await firstPathBar
                    .getByRole('button', { name: 'project', exact: true })
                    .count()) === 1,
            );
            check(
                'parent navigation restores the current location when overflow is no longer needed',
                await firstPathBar
                    .locator('[data-file-path-current]')
                    .evaluate((el) => el === document.activeElement),
            );
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '24px';
                window.filesUiTest.breadcrumbPath(
                    `/home/deploy/project/${'component-'.repeat(24)}/${'release-'.repeat(24)}/config`,
                );
            });
            await firstPathBar.getByRole('button', { name: 'config', exact: true }).waitFor();
            check(
                'long breadcrumb labels remain bounded when interface text is enlarged',
                await firstPathBar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
            );
            await page.setViewportSize({ width: 320, height: 640 });
            check(
                'enlarged text and narrow splits retain a reachable current folder',
                (await firstPathBar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)) &&
                    (await firstPathBar
                        .locator('[data-file-path-current]')
                        .evaluate((el) => el.getBoundingClientRect().width >= 24)),
            );
            await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
        }
        if (transferSafetyOnly) {
            await runFilesTransferSafetyChecks({ page, check });
        }
        if (
            focusOnly ||
            (!transferSafetyOnly &&
                !process.argv.includes('--drawers-only') &&
                !process.argv.includes('--workspace-motion-only'))
        ) {
            await runFilesFocusChecks({ page, check });
        }
        if (
            !focusOnly &&
            !transferSafetyOnly &&
            !process.argv.includes('--workspace-motion-only')
        ) {
            await runFilesDrawerChecks({ page, check, screenshot });
        }
        if (!focusOnly && !transferSafetyOnly && !process.argv.includes('--drawers-only')) {
            await runFilesWorkspaceMotionChecks({ page, check, screenshot });
        }
        if (process.argv.length === 2) {
            await page.setViewportSize({ width: 1200, height: 800 });
            await page.goto(
                `http://127.0.0.1:${address.port}/tests/files/filesProduction.browser.html?folderSizes=1`,
                { waitUntil: 'domcontentloaded' },
            );
            await page.getByRole('listbox').waitFor();
            for (const label of await page.evaluate(() => window.runFolderSizeBrowserChecks())) {
                check(label, true);
            }
            await screenshot('files-folder-sizes');
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        console.log(`Production Files browser checks passed (${checks}).`);
    }
} finally {
    await browser?.close();
    await server.close();
}
