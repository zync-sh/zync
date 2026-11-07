import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import type { Browser, Locator, Page } from 'playwright-core';
import { createServer } from 'vite';

import type { SerialFixtureLog } from './serialTerminal.browser';

const { chromium } = (await import(
    process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright-core'
)) as typeof import('playwright-core');
const fixture = '/tests/serial/serialTerminal.browser.html';
const externalServer = process.env.ZYNC_BROWSER_BASE_URL;
const server = externalServer
    ? undefined
    : await createServer({
          configFile: false,
          plugins: [react()],
          cacheDir: 'node_modules/.vite-serial-ui-tests',
          server: { host: '127.0.0.1', port: 0, watch: null },
          optimizeDeps: { entries: [fixture.slice(1)], exclude: ['@enjoys/context-engine'] },
      });

/** Read only fixture-native calls so assertions exercise the production serial adapter. */
async function readLog(page: Page): Promise<SerialFixtureLog> {
    return page.evaluate(() => window.__SERIAL_FIXTURE__.log());
}

/** A narrow workspace pane must fit independently of the outer desktop window width. */
async function assertNoHorizontalOverflow(page: Page) {
    const dimensions = await page.locator('#serial-fixture-pane').evaluate((pane) => ({
        client: pane.clientWidth,
        scroll: pane.scrollWidth,
    }));
    assert.ok(dimensions.scroll <= dimensions.client + 1, JSON.stringify(dimensions));
}

/** Port and framing menus must escape scroll containers without losing pointer access. */
async function assertOptionReachable(option: Locator) {
    await option.waitFor();
    assert.equal(
        await option.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const centerX = bounds.left + bounds.width / 2;
            const centerY = bounds.top + bounds.height / 2;
            return (
                bounds.left >= 0 &&
                bounds.right <= innerWidth &&
                bounds.top >= 0 &&
                bounds.bottom <= innerHeight &&
                element.contains(document.elementFromPoint(centerX, centerY))
            );
        }),
        true,
        'The visible option must fit the viewport and receive pointer events',
    );
}

/** A foreground connection should be ready for typing without another canvas click. */
async function assertConsoleFocused(page: Page) {
    await page
        .waitForFunction(
            () => document.activeElement?.matches('.xterm-helper-textarea'),
            undefined,
            { timeout: 5000 },
        )
        .catch(async (cause: unknown) => {
            const active = await page.evaluate(() => ({
                tag: document.activeElement?.tagName,
                label: document.activeElement?.getAttribute('aria-label'),
                text: document.activeElement?.textContent?.slice(0, 120),
                focused: document.hasFocus(),
                visibility: document.visibilityState,
            }));
            throw new Error(`Serial console did not receive focus: ${JSON.stringify(active)}`, {
                cause,
            });
        });
}

/** Verify onboarding, saved-device ownership and serial I/O through the production profile flow. */
async function runStandaloneChecks(page: Page, baseUrl: string, screenshotDirectory: string) {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${baseUrl}${fixture}?standalone`, { waitUntil: 'domcontentloaded' });
    const pane = page.getByRole('region', { name: 'Serial Terminal', exact: true });
    const add = page.getByRole('button', { name: 'Add serial fixture', exact: true });
    const editor = page.getByRole('dialog', { name: 'Add Serial profile', exact: true });
    const edit = page.getByRole('dialog', { name: 'Edit Serial profile', exact: true });
    const connect = pane.getByRole('button', { name: 'Connect', exact: true });
    const disconnect = pane.getByRole('button', { name: 'Disconnect', exact: true });

    await add.click();
    await editor.getByRole('button', { name: 'Back', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('Fixture Back count').innerText(), '1');
    assert.equal((await readLog(page)).profileWrites.length, 0);
    assert.equal((await readLog(page)).opens.length, 0);

    await add.click();
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
    assert.equal((await readLog(page)).profileWrites.length, 0, 'Invalid profiles are not saved');
    await editor.getByLabel('Profile name', { exact: true }).fill('Router console');
    await editor.getByLabel('Serial port', { exact: true }).click();
    await page.getByRole('option', { name: 'COM2 · Virtual serial bridge', exact: true }).click();
    await editor.getByLabel('Baud rate', { exact: true }).fill('9600');
    await editor.locator('summary').click();
    await editor.getByLabel('Parity', { exact: true }).click();
    await page.getByRole('option', { name: 'Even', exact: true }).click();
    await editor.getByLabel('Stop bits', { exact: true }).click();
    await page.getByRole('option', { name: '2', exact: true }).click();
    await editor.getByLabel('Flow control', { exact: true }).click();
    await page.getByRole('option', { name: 'RTS/CTS', exact: true }).click();
    await editor.getByLabel('Enter sends', { exact: true }).click();
    await page.getByRole('option', { name: 'CRLF', exact: true }).click();
    await page.evaluate(() => window.__SERIAL_FIXTURE__.failNextSave());
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
    await editor.getByRole('alert').filter({ hasText: 'could not save' }).waitFor();
    assert.equal((await readLog(page)).opens.length, 0, 'Storage failure never opens hardware');
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    const initialSaved = (await readLog(page)).profileWrites.at(-1)!;
    assert.equal(initialSaved.length, 1, 'Retry retains one profile identity');
    const expectedSettings = {
        baudRate: 9600,
        dataBits: 8,
        parity: 'even',
        stopBits: 2,
        flowControl: 'hardware',
    };
    assert.deepEqual(initialSaved[0], {
        id: initialSaved[0].id,
        name: 'Router console',
        portId: 'COM2',
        settings: expectedSettings,
        lineEnding: 'crlf',
    });
    assert.equal(JSON.stringify(initialSaved).includes('documentId'), false);
    assert.equal((await readLog(page)).opens.length, 0, 'Save only stores metadata');

    const savedSerialSection = page.getByRole('button', { name: /^Serial profiles/ });
    assert.equal(await savedSerialSection.getAttribute('aria-expanded'), 'false');
    assert.equal(
        await page.getByRole('list', { name: 'Saved Serial profiles', exact: true }).count(),
        0,
        'Saving a profile keeps its initially collapsed sidebar section closed',
    );
    await savedSerialSection.click();

    await page
        .getByRole('button', { name: 'Open Serial profile Router console', exact: true })
        .click();
    await connect.waitFor();
    assert.equal((await readLog(page)).opens.length, 0, 'Opening a saved tab waits for Connect');
    await savedSerialSection.click();
    await page.getByRole('button', { name: 'Reopen serial fixture', exact: true }).click();
    assert.equal(
        await savedSerialSection.getAttribute('aria-expanded'),
        'false',
        'Opening a saved tab does not expand a section the user kept closed',
    );
    assert.equal((await readLog(page)).opens.length, 0);
    await savedSerialSection.click();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshotDirectory, 'standalone-idle.png') });
    await connect.click();
    await disconnect.waitFor();
    await assertConsoleFocused(page);
    const firstOpen = (await readLog(page)).opens[0];
    assert.equal(firstOpen.portId, 'COM2');
    assert.deepEqual(firstOpen.settings, expectedSettings);
    assert.match(firstOpen.documentId, /^fixture-document-\d+$/);
    assert.notEqual(firstOpen.documentId, 'fixture-document-1', 'Connection uses fresh discovery');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
        window.__SERIAL_FIXTURE__
            .log()
            .input.some((bytes) => bytes.length === 2 && bytes[0] === 13 && bytes[1] === 10),
    );

    await page
        .getByRole('button', { name: 'Edit Serial profile Router console', exact: true })
        .click();
    await edit.getByLabel('Profile name', { exact: true }).fill('Renamed console');
    await edit.getByRole('button', { name: 'Save profile', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    await pane
        .getByText(/^Renamed console/)
        .first()
        .waitFor();
    assert.equal((await readLog(page)).opens.length, 1);
    assert.equal(
        (await readLog(page)).closes.includes(firstOpen.sessionId),
        false,
        'Renaming a connected profile keeps its native device session',
    );
    await page
        .getByRole('button', { name: 'Edit Serial profile Renamed console', exact: true })
        .click();
    await edit.getByLabel('Profile name', { exact: true }).fill('Router console');
    await edit.getByLabel('Serial port', { exact: true }).click();
    await page.getByRole('option', { name: 'COM1 · Virtual serial bridge', exact: true }).click();
    await edit.getByRole('button', { name: 'Save profile', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    await page.waitForFunction(
        (sessionId) => window.__SERIAL_FIXTURE__.log().closes.includes(sessionId),
        firstOpen.sessionId,
    );
    await connect.waitFor();
    assert.equal(
        (await readLog(page)).opens.length,
        1,
        'Endpoint edits retire rather than reconnect the old port',
    );
    await page
        .getByRole('button', { name: 'Edit Serial profile Router console', exact: true })
        .click();
    await edit.getByRole('button', { name: 'Save & Connect', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    await disconnect.waitFor();
    await assertConsoleFocused(page);
    const connected = await readLog(page);
    assert.equal(connected.opens.length, 2, 'Save & Connect opens exactly once');
    assert.equal(connected.opens[1].portId, 'COM1');
    await page.screenshot({ path: path.join(screenshotDirectory, 'standalone-connected.png') });

    await page.evaluate(() => window.__SERIAL_FIXTURE__.deferNextClose());
    await page
        .getByRole('button', { name: 'Edit Serial profile Router console', exact: true })
        .click();
    await edit.getByLabel('Baud rate', { exact: true }).fill('19200');
    await edit.getByRole('button', { name: 'Save & Connect', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    await page.waitForFunction(
        (sessionId) => window.__SERIAL_FIXTURE__.log().closes.includes(sessionId),
        connected.opens[1].sessionId,
    );
    assert.equal(
        (await readLog(page)).opens.length,
        2,
        'Reconfiguring the same port waits until the previous native session releases it',
    );
    await page.evaluate(() => window.__SERIAL_FIXTURE__.completeClose());
    await disconnect.waitFor();
    const reconfigured = await readLog(page);
    assert.equal(reconfigured.opens.length, 3);
    assert.equal(reconfigured.opens[2].portId, 'COM1');
    assert.equal(reconfigured.opens[2].settings.baudRate, 19200);
    const beforeRestore = reconfigured.opens.length;

    await page.getByRole('button', { name: 'Close serial fixture', exact: true }).click();
    await pane.waitFor({ state: 'hidden' });
    await page.waitForFunction(
        (sessionId) => window.__SERIAL_FIXTURE__.log().closes.includes(sessionId),
        reconfigured.opens[2].sessionId,
    );
    await page.getByRole('button', { name: 'Restore serial fixture', exact: true }).click();
    await connect.waitFor();
    assert.equal(
        (await readLog(page)).opens.length,
        beforeRestore,
        'Restoration never opens the device',
    );
    await page.evaluate(() => window.__SERIAL_FIXTURE__.deferNextOpen());
    await connect.click();
    await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(
        (previous) => window.__SERIAL_FIXTURE__.log().opens.length === previous + 1,
        beforeRestore,
    );
    await page.evaluate(() => window.__SERIAL_FIXTURE__.completeOpen());
    await connect.waitFor();
    assert.equal(
        (await readLog(page)).opens.length,
        beforeRestore + 1,
        'A cancelled one-shot request is not replayed',
    );

    await page.getByRole('button', { name: 'Close serial fixture', exact: true }).click();
    await pane.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__SERIAL_FIXTURE__.setPorts(['COM2']));
    await page.getByRole('button', { name: 'Reopen serial fixture', exact: true }).click();
    await pane.getByText(/COM1 is unavailable/).waitFor();
    assert.equal(await connect.isDisabled(), true);
    assert.equal(
        (await readLog(page)).opens.length,
        beforeRestore + 1,
        'Missing saved devices never fall back to another port',
    );
    await page.evaluate(() => window.__SERIAL_FIXTURE__.setPorts(['COM1', 'COM2']));
    await pane.getByRole('button', { name: 'Refresh ports', exact: true }).click();
    await page.waitForFunction(() =>
        [
            ...document.querySelectorAll<HTMLButtonElement>(
                'section[aria-label="Serial Terminal"] button',
            ),
        ].some((button) => button.textContent?.trim() === 'Connect' && !button.disabled),
    );
    assert.equal(
        (await readLog(page)).opens.length,
        beforeRestore + 1,
        'Replug refresh never opens hardware',
    );
    await connect.click();
    await disconnect.waitFor();
    assert.equal((await readLog(page)).opens.at(-1)?.portId, 'COM1');
    await disconnect.click();
    const reconnect = pane.getByRole('button', { name: 'Reconnect', exact: true });
    await reconnect.waitFor();
    await page.evaluate(() => window.__SERIAL_FIXTURE__.setPorts(['COM2']));
    const beforeUnpluggedReconnect = (await readLog(page)).opens.length;
    await reconnect.click();
    await pane
        .getByRole('alert')
        .filter({ hasText: /COM1.*unavailable/ })
        .waitFor();
    assert.equal(await reconnect.isDisabled(), true);
    assert.equal((await readLog(page)).opens.length, beforeUnpluggedReconnect);
    await page.evaluate(() => window.__SERIAL_FIXTURE__.setPorts(['COM1', 'COM2']));
    await pane.getByRole('button', { name: 'Refresh ports', exact: true }).click();
    await reconnect.click();
    await disconnect.waitFor();
    assert.equal((await readLog(page)).opens.length, beforeUnpluggedReconnect + 1);

    await disconnect.click();
    await reconnect.waitFor();
    await page.evaluate(() => window.__SERIAL_FIXTURE__.deferNextOpen());
    await reconnect.click();
    await pane.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    await add.focus();
    await page.evaluate(() => window.__SERIAL_FIXTURE__.completeOpen());
    await disconnect.waitFor();
    assert.equal(
        await add.evaluate((element) => document.activeElement === element),
        true,
        'Moving focus during an open keeps the chosen control focused',
    );

    await disconnect.click();
    await reconnect.waitFor();
    await page.evaluate(() => window.__SERIAL_FIXTURE__.deferNextOpen());
    await reconnect.click();
    await pane.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    await page.evaluate(() => window.__SERIAL_FIXTURE__.setVisible(false));
    await pane.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__SERIAL_FIXTURE__.completeOpen());
    await page
        .getByRole('region', { name: 'Serial Terminal', exact: true, includeHidden: true })
        .getByRole('button', { name: 'Disconnect', exact: true, includeHidden: true })
        .waitFor({ state: 'attached' });
    assert.equal(
        await page.evaluate(() => document.activeElement?.matches('.xterm-helper-textarea')),
        false,
    );
    await add.focus();
    await page.evaluate(() => window.__SERIAL_FIXTURE__.setVisible(true));
    await disconnect.waitFor();
    assert.equal(
        await add.evaluate((element) => document.activeElement === element),
        true,
        'A connection completed while hidden does not replay focus after showing',
    );

    await page.setViewportSize({ width: 520, height: 350 });
    await page.goto(`${baseUrl}${fixture}?standalone&width=320&light`, {
        waitUntil: 'domcontentloaded',
    });
    await add.click();
    await editor.getByLabel('Profile name', { exact: true }).fill('Compact console');
    await editor.locator('summary').click();
    await editor.getByLabel('Flow control', { exact: true }).click();
    const software = page.getByRole('option', { name: 'XON/XOFF', exact: true });
    await assertOptionReachable(software);
    await software.click();
    await software.waitFor({ state: 'hidden' });
    await page.screenshot({
        path: path.join(screenshotDirectory, 'standalone-short-light-editor.png'),
    });
    const editorBounds = await editor.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
    }));
    assert.ok(editorBounds.scroll <= editorBounds.client + 1, JSON.stringify(editorBounds));
    await editor.getByRole('button', { name: 'Save & Connect', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await disconnect.waitFor();
    await assertConsoleFocused(page);
    await assertNoHorizontalOverflow(page);
    assert.equal((await readLog(page)).opens.length, 1);
}

/** Empty groups stay hidden until the normal connection workflow saves their first profile. */
async function runEmptySidebarChecks(page: Page, baseUrl: string) {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${baseUrl}${fixture}?sidebar&empty`, { waitUntil: 'domcontentloaded' });
    const sidebar = page.locator('[data-shared-sidebar]');
    const serialHeader = sidebar.getByRole('button', { name: /^Serial profiles/ });
    const vncHeader = sidebar.getByRole('button', { name: /^VNC profiles/ });
    await sidebar.getByRole('button', { name: /^All Hosts/ }).waitFor();
    assert.equal(await serialHeader.count(), 0);
    assert.equal(await vncHeader.count(), 0);

    for (const kind of ['Serial', 'VNC'] as const) {
        await sidebar.getByRole('button', { name: 'Create in All Hosts', exact: true }).click();
        await page.getByRole('menuitem', { name: 'New host', exact: true }).click();
        const chooser = page.getByRole('dialog', { name: 'Add connection', exact: true });
        await chooser.getByRole('button', { name: `${kind} connection`, exact: false }).click();
        const editor = page.getByRole('dialog', { name: `Add ${kind} profile`, exact: true });
        await editor.getByLabel('Profile name', { exact: true }).fill(`First ${kind} profile`);
        if (kind === 'VNC') {
            await editor.getByLabel('Host or IP address', { exact: true }).fill('127.0.0.1');
        }
        await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        const header = kind === 'Serial' ? serialHeader : vncHeader;
        await header.waitFor();
        assert.equal(await header.getAttribute('aria-expanded'), 'false');
        if (kind === 'Serial') {
            assert.equal(
                await vncHeader.count(),
                0,
                'Saving Serial does not reveal an empty VNC group',
            );
        } else {
            assert.equal(
                await serialHeader.count(),
                1,
                'Saving VNC preserves the existing Serial group',
            );
        }
    }

    for (const kind of ['Serial', 'VNC'] as const) {
        const header = kind === 'Serial' ? serialHeader : vncHeader;
        await header.click();
        const row = sidebar.getByRole('button', {
            name: `Open ${kind} profile First ${kind} profile`,
            exact: true,
        });
        await row.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click();
        const confirmation = page.getByRole('dialog', {
            name: `Delete ${kind} profile?`,
            exact: true,
        });
        await confirmation.getByRole('button', { name: 'Delete profile', exact: true }).click();
        await confirmation.waitFor({ state: 'hidden' });
        await header.waitFor({ state: 'hidden' });
        assert.equal(await header.count(), 0, 'Deleting the last profile removes its section');
        if (kind === 'Serial') {
            assert.equal(
                await vncHeader.count(),
                1,
                'Deleting Serial preserves the populated VNC group',
            );
        }
    }
    assert.equal(await serialHeader.count(), 0);
    assert.equal(await vncHeader.count(), 0);
    assert.equal((await readLog(page)).opens.length, 0, 'Profile visibility never opens hardware');
}

/** Compare real sidebar sections and profile rows with the SSH host presentation they accompany. */
async function runSidebarChecks(page: Page, baseUrl: string, screenshotDirectory: string) {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${baseUrl}${fixture}?sidebar`, { waitUntil: 'domcontentloaded' });
    const sidebar = page.locator('[data-shared-sidebar]');
    const allHosts = sidebar.getByRole('button', { name: /^All Hosts/ });
    const vnc = sidebar.getByRole('button', { name: /^VNC profiles/ });
    const serial = sidebar.getByRole('button', { name: /^Serial profiles/ });
    const serialRow = sidebar.getByRole('button', {
        name: 'Open Serial profile Console 1',
        exact: true,
    });
    const vncRow = sidebar.getByRole('button', { name: 'Open VNC profile Desktop 1', exact: true });
    await serial.waitFor();
    for (const [header, label] of [
        [vnc, 'Saved VNC profiles'],
        [serial, 'Saved Serial profiles'],
    ] as const) {
        assert.equal(await header.getAttribute('aria-expanded'), 'false');
        assert.equal(await sidebar.getByRole('list', { name: label, exact: true }).count(), 0);
    }
    await sidebar.screenshot({
        path: path.join(screenshotDirectory, 'sidebar-default-collapsed.png'),
    });
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
    const beforeExpansion = (await readLog(page)).commands;
    for (const header of [vnc, serial]) {
        await header.click();
    }
    await serialRow.waitFor();
    assert.deepEqual(
        (await readLog(page)).commands,
        beforeExpansion,
        'Expanding profile sections only changes presentation',
    );
    for (const header of [vnc, serial]) {
        await header.click();
        assert.equal(await header.getAttribute('aria-expanded'), 'false');
        await header.click();
    }
    assert.deepEqual(
        (await readLog(page)).commands,
        beforeExpansion,
        'Collapsing and reopening profile sections never opens a connection',
    );
    for (const label of ['Saved VNC profiles', 'Saved Serial profiles']) {
        const frame = await sidebar
            .getByRole('list', { name: label, exact: true })
            .evaluate((element) => {
                const style = getComputedStyle(element);
                return { border: style.borderTopWidth, background: style.backgroundColor };
            });
        assert.equal(frame.border, '0px', 'Profile rows do not have a second surrounding card');
        assert.equal(frame.background, 'rgba(0, 0, 0, 0)');
    }
    const initialCalls = (await readLog(page)).commands;
    await serialRow.hover();
    await serialRow.focus();
    assert.deepEqual(
        (await readLog(page)).commands,
        initialCalls,
        'Hover and keyboard focus do not perform native work',
    );

    const hostRow = sidebar
        .getByText('Host 1', { exact: true })
        .locator('xpath=ancestor::*[@role="button"][1]');
    const presentation = async (row: Locator, name: string) => ({
        row: await row.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
                height: element.getBoundingClientRect().height,
                paddingTop: style.paddingTop,
                paddingBottom: style.paddingBottom,
                paddingLeft: style.paddingLeft,
                radius: style.borderRadius,
                background: getComputedStyle(
                    element.tagName === 'BUTTON' ? element.parentElement! : element,
                ).backgroundColor,
            };
        }),
        text: await row.getByText(name, { exact: true }).evaluate((element) => {
            const style = getComputedStyle(element);
            return { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight };
        }),
    });
    const hostPresentation = await presentation(hostRow, 'Host 1');
    const hostLabelBounds = await hostRow.getByText('Host 1', { exact: true }).boundingBox();
    assert.ok(hostLabelBounds);
    for (const [row, name, kind] of [
        [serialRow, 'Console 1', 'Serial'],
        [vncRow, 'Desktop 1', 'VNC'],
    ] as const) {
        const current = await presentation(row, name);
        const hasSubtitle = (await row.innerText()).trim() !== name;
        if (hasSubtitle) {
            assert.ok(
                Math.abs(current.row.height - hostPresentation.row.height) <= 1,
                JSON.stringify({ host: hostPresentation, current }),
            );
        } else {
            assert.ok(
                current.row.height < hostPresentation.row.height,
                'A profile without an address does not reserve an empty subtitle line',
            );
        }
        assert.equal(current.row.paddingTop, hostPresentation.row.paddingTop);
        assert.equal(current.row.paddingBottom, hostPresentation.row.paddingBottom);
        assert.equal(current.row.paddingLeft, hostPresentation.row.paddingLeft);
        assert.equal(current.row.radius, hostPresentation.row.radius);
        assert.deepEqual(current.text, hostPresentation.text);
        const [labelBounds, editBounds] = await Promise.all([
            row.getByText(name, { exact: true }).boundingBox(),
            sidebar
                .getByRole('button', { name: `Edit ${kind} profile ${name}`, exact: true })
                .boundingBox(),
        ]);
        assert.ok(labelBounds && editBounds);
        assert.ok(
            Math.abs(labelBounds.x - hostLabelBounds.x) <= 2,
            'Profile labels share the host-list indentation without adding another card',
        );
        assert.ok(
            Math.abs(
                labelBounds.y + labelBounds.height / 2 - editBounds.y - editBounds.height / 2,
            ) <= 5,
            'Edit actions align with the primary label for single- and two-line rows',
        );
    }
    await serialRow.click();
    await page.mouse.move(900, 650);
    let workspace = await page.evaluate(() => window.__SERIAL_FIXTURE__.workspace());
    assert.equal(workspace.tabs.find(({ id }) => id === workspace.activeTabId)?.type, 'serial');
    assert.equal(workspace.activeConnectionId, null);
    assert.equal(
        (await readLog(page)).opens.length,
        0,
        'Sidebar opening a Serial profile remains idle',
    );
    await page.waitForFunction((expected) => {
        const row = document.querySelector('[aria-label="Open Serial profile Console 1"]');
        return (
            row?.parentElement && getComputedStyle(row.parentElement).backgroundColor === expected
        );
    }, hostPresentation.row.background);
    await sidebar.screenshot({ path: path.join(screenshotDirectory, 'sidebar-expanded.png') });
    await vncRow.click();
    workspace = await page.evaluate(() => window.__SERIAL_FIXTURE__.workspace());
    assert.equal(workspace.tabs.find(({ id }) => id === workspace.activeTabId)?.type, 'vnc');
    assert.equal(workspace.activeConnectionId, null);
    assert.equal(
        (await readLog(page)).commands.some((command) => command.startsWith('vnc_start')),
        false,
    );

    const beforeEdit = workspace.tabs.length;
    const beforeEditTabId = workspace.activeTabId;
    await sidebar
        .getByRole('button', { name: 'Edit Serial profile Console 1', exact: true })
        .click();
    const editSerial = page.getByRole('dialog', { name: 'Edit Serial profile', exact: true });
    await editSerial.waitFor();
    assert.equal(
        (await page.evaluate(() => window.__SERIAL_FIXTURE__.workspace())).tabs.length,
        beforeEdit,
        'Editing does not activate the profile row',
    );
    assert.equal(
        (await page.evaluate(() => window.__SERIAL_FIXTURE__.workspace())).activeTabId,
        beforeEditTabId,
        'Editing an inactive profile leaves the selected workspace unchanged',
    );
    await editSerial.getByRole('button', { name: 'Cancel', exact: true }).click();
    await editSerial.waitFor({ state: 'hidden' });
    await sidebar.getByRole('button', { name: 'Edit VNC profile Desktop 1', exact: true }).click();
    const editVnc = page.getByRole('dialog', { name: 'Edit VNC profile', exact: true });
    await editVnc.waitFor();
    assert.equal(
        (await page.evaluate(() => window.__SERIAL_FIXTURE__.workspace())).tabs.length,
        beforeEdit,
    );
    await editVnc.getByRole('button', { name: 'Cancel', exact: true }).click();
    await editVnc.waitFor({ state: 'hidden' });

    await serialRow.focus();
    await serialRow.press('Shift+F10');
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: 'Delete profile', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await serialRow.evaluate((element) => element === document.activeElement), true);
    await serialRow.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Open profile', exact: true }).click();
    workspace = await page.evaluate(() => window.__SERIAL_FIXTURE__.workspace());
    assert.equal(workspace.tabs.find(({ id }) => id === workspace.activeTabId)?.type, 'serial');
    assert.equal((await readLog(page)).opens.length, 0, 'The profile menu opens an idle tab');
    await serialRow.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Delete profile', exact: true }).click();
    const deleteSerial = page.getByRole('dialog', { name: 'Delete Serial profile?', exact: true });
    await deleteSerial.waitFor();
    await deleteSerial.getByRole('button', { name: 'Cancel', exact: true }).click();
    await deleteSerial.waitFor({ state: 'hidden' });
    assert.equal(await serialRow.count(), 1, 'Cancel keeps the saved profile');
    await serialRow.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Delete profile', exact: true }).click();
    await deleteSerial.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await deleteSerial.waitFor({ state: 'hidden' });
    await serialRow.waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => window.__SERIAL_FIXTURE__.profiles())).length, 2);
    await vncRow.focus();
    await vncRow.press('Shift+F10');
    await menu.getByRole('menuitem', { name: 'Delete profile', exact: true }).click();
    const deleteVnc = page.getByRole('dialog', { name: 'Delete VNC profile?', exact: true });
    await deleteVnc.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await deleteVnc.waitFor({ state: 'hidden' });
    await vncRow.waitFor({ state: 'hidden' });

    await allHosts.click();
    const collapsedHostsBounds = await allHosts.boundingBox();
    const expandedVncBounds = await vnc.boundingBox();
    assert.ok(collapsedHostsBounds && expandedVncBounds);
    assert.ok(
        expandedVncBounds.y - collapsedHostsBounds.y - collapsedHostsBounds.height <= 24,
        'Collapsing All Hosts must release its unused height while profiles stay expanded',
    );
    for (const header of [vnc, serial]) {
        if ((await header.getAttribute('aria-expanded')) === 'true') {
            await header.click();
        }
    }
    const bounds = await Promise.all([allHosts, vnc, serial].map((header) => header.boundingBox()));
    assert.ok(bounds.every(Boolean));
    for (let index = 1; index < bounds.length; index++) {
        const previous = bounds[index - 1]!;
        const current = bounds[index]!;
        const gap = current.y - previous.y - previous.height;
        assert.ok(gap >= 0 && gap <= 24, `Collapsed sections should stack; got ${gap}px gap`);
    }
    await sidebar.screenshot({ path: path.join(screenshotDirectory, 'sidebar-collapsed.png') });

    await page.setViewportSize({ width: 520, height: 420 });
    await page.goto(`${baseUrl}${fixture}?sidebar&many&compact&light&width=260`, {
        waitUntil: 'domcontentloaded',
    });
    await allHosts.waitFor();
    await allHosts.click();
    for (const header of [vnc, serial]) {
        await header.click();
    }
    for (const label of ['Saved VNC profiles', 'Saved Serial profiles']) {
        const list = sidebar.getByRole('list', { name: label, exact: true });
        const sizes = await list.evaluate((element) => ({
            height: element.clientHeight,
            scroll: element.scrollHeight,
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
        }));
        assert.ok(
            sizes.height > 0 && sizes.scroll > sizes.height,
            `${label}: ${JSON.stringify(sizes)}`,
        );
        assert.ok(sizes.scrollWidth <= sizes.width + 1, `${label} must fit the narrow sidebar`);
        await list
            .getByRole('button', { name: /^Open .* profile (Console|Desktop) 80$/, exact: false })
            .scrollIntoViewIfNeeded();
        assert.ok(await list.evaluate((element) => element.scrollTop > 0));
    }
    await sidebar.screenshot({ path: path.join(screenshotDirectory, 'sidebar-compact-many.png') });
    await page.setViewportSize({ width: 520, height: 350 });
    await page.goto(`${baseUrl}${fixture}?sidebar&many&width=260`, {
        waitUntil: 'domcontentloaded',
    });
    await serial.waitFor();
    for (const header of [vnc, serial]) {
        await header.click();
    }
    await sidebar.screenshot({
        path: path.join(screenshotDirectory, 'sidebar-short-expanded-top.png'),
    });
    for (const header of [allHosts, vnc, serial]) {
        await header.scrollIntoViewIfNeeded();
        assert.equal(
            await header.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return element.contains(
                    document.elementFromPoint(
                        bounds.left + bounds.width / 2,
                        bounds.top + bounds.height / 2,
                    ),
                );
            }),
            true,
            'Every expanded section header must remain reachable in a short window',
        );
    }
    const hostList = sidebar
        .getByText('Host 1', { exact: true })
        .locator('xpath=ancestor::*[@role="button"][1]/parent::*');
    const shortHostList = await hostList.evaluate((element) => ({
        visibleHeight: element.clientHeight,
        firstRowHeight: element.firstElementChild!.getBoundingClientRect().height,
        padding:
            parseFloat(getComputedStyle(element).paddingTop) +
            parseFloat(getComputedStyle(element).paddingBottom),
        scrollHeight: element.scrollHeight,
    }));
    assert.ok(
        shortHostList.visibleHeight >= shortHostList.firstRowHeight + shortHostList.padding,
        JSON.stringify(shortHostList),
    );
    assert.ok(
        shortHostList.scrollHeight > shortHostList.visibleHeight,
        'Long host lists keep their own bounded viewport',
    );
    for (const row of [
        hostList.locator('[role="button"]').first(),
        sidebar.getByRole('button', { name: 'Open VNC profile Desktop 80', exact: true }),
        sidebar.getByRole('button', { name: 'Open Serial profile Console 80', exact: true }),
    ]) {
        await row.scrollIntoViewIfNeeded();
        assert.equal(
            await row.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return element.contains(
                    document.elementFromPoint(
                        bounds.left + bounds.width / 2,
                        bounds.top + bounds.height / 2,
                    ),
                );
            }),
            true,
            'Host and profile rows must remain reachable through their scroll containers',
        );
    }
    await sidebar.screenshot({
        path: path.join(screenshotDirectory, 'sidebar-short-expanded.png'),
    });
    assert.equal((await readLog(page)).opens.length, 0);
    assert.equal(
        (await readLog(page)).commands.some((command) => command.startsWith('vnc_start')),
        false,
    );
}

let browser: Browser | undefined;
try {
    await server?.listen();
    const address = server?.httpServer?.address();
    assert.ok(externalServer || (address && typeof address !== 'string'));
    const baseUrl =
        externalServer ||
        `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    browser = await chromium.launch({
        channel: process.env.ZYNC_BROWSER_CHANNEL || 'msedge',
        headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.setDefaultNavigationTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const screenshotDirectory = path.resolve('.tmp-agent-tests/serial-ui-screenshots');
    await mkdir(screenshotDirectory, { recursive: true });

    if (!process.argv.includes('--sidebar-only')) {
        await page.goto(`${baseUrl}${fixture}`, { waitUntil: 'domcontentloaded' });
        const pane = page.getByRole('region', { name: 'Serial Terminal', exact: true });
        const connect = pane.getByRole('button', { name: 'Connect', exact: true });
        await pane.getByRole('heading', { name: 'Connect to serial port', exact: true }).waitFor();
        await connect.waitFor();
        await page.waitForFunction(() => document.querySelector('.xterm') !== null);
        const terminal = await page.locator('.xterm').elementHandle();
        assert.ok(terminal);
        assert.equal(await pane.getByLabel('Baud rate', { exact: true }).inputValue(), '115200');
        const beforeRefresh = await readLog(page);
        await pane.getByRole('button', { name: 'Refresh ports', exact: true }).click();
        await page.waitForFunction(
            (previous) => window.__SERIAL_FIXTURE__.log().scans > previous,
            beforeRefresh.scans,
        );
        assert.equal(
            (await readLog(page)).opens.length,
            0,
            'Port refresh must not connect automatically',
        );
        await assertNoHorizontalOverflow(page);
        await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-setup.png') });

        await connect.click();
        const disconnect = pane.getByRole('button', { name: 'Disconnect', exact: true });
        await disconnect.waitFor();
        await page.waitForFunction(() => window.__SERIAL_FIXTURE__.log().outputCredits.length > 0);
        assert.equal(
            await terminal.evaluate((node) => node === document.querySelector('.xterm')),
            true,
        );
        await assertConsoleFocused(page);
        await page.keyboard.type('serial input');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__SERIAL_FIXTURE__.log().input.length > 0);

        await pane.getByRole('button', { name: 'Serial settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Serial connection', exact: true });
        await settings.waitFor();
        await settings.locator('summary').click();
        assert.equal(await settings.getByLabel('Baud rate', { exact: true }).isDisabled(), true);
        assert.equal(await settings.getByLabel('Enter sends', { exact: true }).isDisabled(), false);
        await settings.getByLabel('Enter sends', { exact: true }).click();
        const crlf = page.getByRole('option', { name: 'CRLF', exact: true });
        await assertOptionReachable(crlf);
        await crlf.click();
        await settings.getByRole('button', { name: 'Done', exact: true }).click();
        await settings.waitFor({ state: 'hidden' });
        await page.locator('.xterm-helper-textarea').press('Enter');
        await page.waitForFunction(() =>
            window.__SERIAL_FIXTURE__
                .log()
                .input.some((bytes) => bytes.length === 2 && bytes[0] === 13 && bytes[1] === 10),
        );
        assert.equal(
            await terminal.evaluate((node) => node === document.querySelector('.xterm')),
            true,
        );
        await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-connected.png') });

        await disconnect.click();
        const reconnect = pane.getByRole('button', { name: 'Reconnect', exact: true });
        await reconnect.waitFor();
        assert.equal(
            await terminal.evaluate((node) => node === document.querySelector('.xterm')),
            true,
        );
        assert.ok(
            await page.locator('.xterm').isVisible(),
            'Disconnect preserves the visible transcript',
        );
        assert.equal((await readLog(page)).opens.length, 1);
        await reconnect.click();
        await disconnect.waitFor();
        assert.equal((await readLog(page)).opens.length, 2);

        await disconnect.click();
        await reconnect.waitFor();
        await pane.getByRole('button', { name: 'Serial settings', exact: true }).click();
        await settings.waitFor();
        const beforeModalCancel = await readLog(page);
        await page.evaluate(() => window.__SERIAL_FIXTURE__.deferNextOpen());
        await settings.getByRole('button', { name: 'Connect', exact: true }).click();
        await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.waitForFunction(
            (previous) => window.__SERIAL_FIXTURE__.log().closes.length === previous + 1,
            beforeModalCancel.closes.length,
        );
        await page.evaluate(() => window.__SERIAL_FIXTURE__.completeOpen());
        await settings.getByRole('button', { name: 'Connect', exact: true }).waitFor();
        const modalCancelled = await readLog(page);
        assert.equal(modalCancelled.opens.length, beforeModalCancel.opens.length + 1);
        const cancelledModalSession = modalCancelled.opens.at(-1)!.sessionId;
        assert.deepEqual(modalCancelled.closes.slice(beforeModalCancel.closes.length), [
            cancelledModalSession,
            cancelledModalSession,
        ]);
        assert.equal(modalCancelled.outputCredits.length, beforeModalCancel.outputCredits.length);
        assert.equal(
            await terminal.evaluate((node) => node === document.querySelector('.xterm')),
            true,
        );
        await settings.getByRole('button', { name: 'Done', exact: true }).click();
        await settings.waitFor({ state: 'hidden' });
        await reconnect.waitFor();

        await page.goto(`${baseUrl}${fixture}?width=320`, { waitUntil: 'domcontentloaded' });
        await connect.waitFor();
        await assertNoHorizontalOverflow(page);
        const port = pane.getByLabel('Serial port', { exact: true });
        await port.click();
        const secondPort = page.getByRole('option', {
            name: 'COM2 · Virtual serial bridge',
            exact: true,
        });
        await secondPort.waitFor();
        await assertOptionReachable(secondPort);
        await secondPort.click();
        await secondPort.waitFor({ state: 'hidden' });
        assert.equal(await port.innerText(), 'COM2 · Virtual serial bridge');
        await page
            .locator('#serial-fixture-pane')
            .screenshot({ path: path.join(screenshotDirectory, 'narrow-setup.png') });

        await page.evaluate(() => window.__SERIAL_FIXTURE__.deferNextOpen());
        await connect.click();
        await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.waitForFunction(() => window.__SERIAL_FIXTURE__.log().closes.length === 1);
        await page.evaluate(() => window.__SERIAL_FIXTURE__.completeOpen());
        await connect.waitFor();
        const cancelled = await readLog(page);
        assert.equal(cancelled.opens.length, 1, 'Cancellation does not start another port session');
        assert.deepEqual(cancelled.closes, [
            cancelled.opens[0].sessionId,
            cancelled.opens[0].sessionId,
        ]);
        assert.equal(
            cancelled.outputCredits.length,
            0,
            'Late canceled output is fenced before xterm',
        );

        await page.setViewportSize({ width: 520, height: 350 });
        await page.goto(`${baseUrl}${fixture}?width=320&light`, { waitUntil: 'domcontentloaded' });
        await connect.waitFor();
        await assertNoHorizontalOverflow(page);
        await page
            .locator('#serial-fixture-pane')
            .screenshot({ path: path.join(screenshotDirectory, 'short-light-setup.png') });
        await connect.scrollIntoViewIfNeeded();
        await page
            .locator('#serial-fixture-pane')
            .screenshot({ path: path.join(screenshotDirectory, 'short-light-setup-scrolled.png') });
        await connect.click();
        await disconnect.waitFor();
        await pane.getByRole('button', { name: 'Serial settings', exact: true }).click();
        await settings.waitFor();
        await settings.locator('summary').click();
        await settings.getByLabel('Enter sends', { exact: true }).click();
        await assertOptionReachable(crlf);
        await crlf.click();
        await crlf.waitFor({ state: 'hidden' });
        await page.screenshot({ path: path.join(screenshotDirectory, 'short-light-settings.png') });
        await settings.getByRole('button', { name: 'Done', exact: true }).click();
        await settings.waitFor({ state: 'hidden' });
        await assertNoHorizontalOverflow(page);
        await page
            .locator('#serial-fixture-pane')
            .screenshot({ path: path.join(screenshotDirectory, 'short-light-connected.png') });
        await runStandaloneChecks(page, baseUrl, screenshotDirectory);
    }
    await runEmptySidebarChecks(page, baseUrl);
    await runSidebarChecks(page, baseUrl, screenshotDirectory);
    assert.deepEqual(errors, []);
    console.log('Serial terminal UI checks passed.');
} finally {
    await browser?.close();
    await server?.close();
}
