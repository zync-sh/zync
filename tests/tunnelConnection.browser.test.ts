export {};
declare const process: { env: Record<string, string | undefined> };
const assertModule = 'node:assert/strict';
const { default: assert } = await import(assertModule);
const { chromium } = await import(process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.ZYNC_BROWSER_CHANNEL || 'msedge', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 850 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto((process.env.ZYNC_BROWSER_BASE_URL || 'http://127.0.0.1:1426') + '/tests/tunnelConnection.browser.html');
    const panel = page.locator('[data-tunnel-fixture-panel]');
    const notice = panel.getByRole('region', { name: 'Host connection', exact: true });
    const trace = async (): Promise<string[]> => JSON.parse(await page.locator('body').getAttribute('data-tunnel-trace') || '[]');
    const count = async (command: string) => (await trace()).filter(item => item === command).length;
    /** Scope actions to a rendered list row, keeping host-level controls distinct from forward controls. */
    const row = (name: string) => panel.locator('div.group.grid').filter({ has: page.getByText(name, { exact: true }) });
    /** Open the actual existing edit modal from either list; all changes remain synthetic local configuration. */
    async function edit(name: string, replacement: string) {
        await row(name).hover(); await row(name).getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Update Port Forward', exact: true });
        await dialog.getByLabel('Name (optional)', { exact: true }).fill(replacement);
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' }); await panel.getByText(replacement, { exact: true }).waitFor();
    }

    await panel.getByText('Saved API', { exact: true }).waitFor();
    await notice.getByText('Host is offline', { exact: true }).waitFor();
    assert.equal(await count('connect:begin'), 0, 'Per-host saved records list without connecting');
    assert.equal(await count('tunnel:reconcileConnection'), 0, 'Mounting the list never requests stop-all reconciliation');

    await panel.getByRole('button', { name: 'New Forward', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Create Port Forward', exact: true });
    await creation.getByLabel('Name (optional)', { exact: true }).fill('Offline added forward');
    await creation.getByLabel('Local port', { exact: true }).fill('41001');
    await creation.getByRole('button', { name: 'Save forward', exact: true }).click();
    await creation.waitFor({ state: 'hidden' }); await panel.getByText('Offline added forward', { exact: true }).waitFor();
    await edit('Saved API', 'Saved API updated');
    assert.equal(await count('tunnel:save'), 2, 'Creating and editing use local saved configuration');
    assert.equal(await count('connect:begin'), 0, 'Offline configuration changes never connect to the host');

    await page.getByRole('button', { name: 'Toggle narrow pane fixture', exact: true }).click();
    assert.equal(await notice.evaluate((element: HTMLElement) => {
        const parent = element.closest('[data-tunnel-fixture-panel]')!.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return bounds.left >= parent.left && bounds.right <= parent.right + 1 && element.scrollWidth <= element.clientWidth + 1;
    }), true, 'Connection recovery and its action fit a 320px split pane in a wide window');
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) await notice.screenshot({ path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/tunnel-disconnected-notice-narrow.png' });
    await page.getByRole('button', { name: 'Toggle narrow pane fixture', exact: true }).click();

    await row('Saved API updated').getByRole('button', { name: 'Start', exact: true }).click();
    await notice.getByRole('button', { name: 'Connecting…', exact: true }).waitFor();
    assert.equal(await count('tunnel:start'), 0, 'Start waits for host connection to complete');
    assert.equal(await count('tunnel:reconcileConnection'), 0, 'Entering connecting state cannot stop another runtime consumer');
    await page.getByRole('button', { name: 'Cancel connection fixture', exact: true }).click();
    await notice.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
    assert.equal(await count('tunnel:start'), 0, 'Cancelling authentication leaves forwarding stopped');

    await row('Saved API updated').getByRole('button', { name: 'Start', exact: true }).click();
    await notice.getByRole('button', { name: 'Connecting…', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await row('Saved API updated').getByRole('button', { name: 'Stop', exact: true }).waitFor();
    assert.equal(await count('tunnel:start'), 1, 'A completed explicit connect starts exactly one forward');
    const connectedTrace = await trace();
    assert.equal(connectedTrace.indexOf('connect:completed') < connectedTrace.indexOf('tunnel:start'), true, 'The live connection precedes the forwarding command');
    assert.equal(connectedTrace.slice(connectedTrace.indexOf('connect:completed') + 1, connectedTrace.indexOf('tunnel:start')).includes('tunnel:list'), true, 'Authoritative runtime refresh prevents a duplicate reconnect auto-start');
    await row('Saved API updated').getByRole('button', { name: 'Stop', exact: true }).click();
    await row('Saved API updated').getByRole('button', { name: 'Start', exact: true }).waitFor();
    await page.waitForTimeout(1250);
    assert.equal(await count('disconnect'), 0, 'Stopping forwarding retains the host for dashboard/audit/other panes');
    await page.getByRole('button', { name: 'Disconnect fixture', exact: true }).click();
    await notice.waitFor();
    assert.equal(await count('tunnel:reconcileConnection'), 0, 'Disconnected list updates are read-only');

    await page.getByRole('button', { name: 'Show global tunnels fixture', exact: true }).click();
    await panel.getByText('Saved API updated', { exact: true }).waitFor();
    await edit('Saved API updated', 'Global API updated');
    assert.equal(await count('connect:begin'), 2, 'Global offline editing retains the same configuration-only behavior');
    await row('Global API updated').getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForFunction(() => (JSON.parse(document.body.dataset.tunnelTrace || '[]') as string[]).filter(item => item === 'connect:begin').length === 3);
    assert.equal(await count('tunnel:start'), 1, 'The global list also waits for its explicit connect to complete');
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await row('Global API updated').getByRole('button', { name: 'Stop', exact: true }).waitFor();
    assert.equal(await count('tunnel:start'), 2, 'The global list uses the same connected-only forwarding start');
    await row('Global API updated').getByRole('button', { name: 'Stop', exact: true }).click();
    await row('Global API updated').getByRole('button', { name: 'Start', exact: true }).waitFor();
    await page.waitForTimeout(1250);
    assert.equal(await count('disconnect'), 0, 'Global Stop never closes unrelated host consumers');
    assert.equal(await count('tunnel:reconcileConnection'), 0);
    assert.deepEqual(errors, []);
    console.log('Tunnel disconnected browser checks passed.');
} finally { await browser.close(); }
