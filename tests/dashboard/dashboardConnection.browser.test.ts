export {};

import assert from 'node:assert/strict';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import type { Browser, Locator, Page } from 'playwright-core';
import { createServer } from 'vite';

import { DASHBOARD_PROCESS_REFRESH_MS } from '../../src/components/dashboard/dashboardDetails.js';

const { chromium } = (await import(
    process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright-core'
)) as typeof import('playwright-core');
const server = process.env.ZYNC_BROWSER_BASE_URL
    ? undefined
    : await createServer({
          root: process.cwd(),
          configFile: false,
          plugins: [react()],
          cacheDir: path.resolve('node_modules/.vite-dashboard-tests'),
          server: {
              host: '127.0.0.1',
              port: 0,
              watch: { ignored: ['**/src-tauri/**', '**/.tmp-agent-tests/**'] },
          },
          optimizeDeps: {
              entries: ['tests/dashboard/dashboardConnection.browser.html'],
              exclude: ['@enjoys/context-engine'],
          },
      });
await server?.listen();
const address = server?.httpServer?.address();
assert.ok(process.env.ZYNC_BROWSER_BASE_URL || (address && typeof address !== 'string'));
const baseUrl =
    process.env.ZYNC_BROWSER_BASE_URL ||
    `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
const fixtureUrl = `${baseUrl}/tests/dashboard/dashboardConnection.browser.html`;
let browser: Browser | undefined;

/** Check actual rendered text against composited ancestor surfaces, including portalled dialogs. */
async function assertReadableText(target: Locator, label: string): Promise<void> {
    const ratio = await target.evaluate((element) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('A canvas context is required to resolve rendered colors');
        }
        /** Let the browser resolve CSS color syntax before applying the contrast calculation. */
        const rgba = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data);
        };
        const ancestors: Element[] = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
            ancestors.unshift(node);
        }
        let background = [255, 255, 255];
        for (const node of ancestors) {
            const color = rgba(getComputedStyle(node).backgroundColor);
            const alpha = color[3] / 255;
            background = background.map(
                (channel, index) => color[index] * alpha + channel * (1 - alpha),
            );
        }
        const foreground = rgba(getComputedStyle(element).color);
        const opacity = foreground[3] / 255;
        const text = background.map(
            (channel, index) => foreground[index] * opacity + channel * (1 - opacity),
        );
        const luminance = (channels: number[]) =>
            channels
                .map((channel) => channel / 255)
                .map((channel) =>
                    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
                )
                .reduce(
                    (sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index],
                    0,
                );
        const a = luminance(background);
        const b = luminance(text);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(
        ratio >= 4.5,
        `${label} must meet 4.5:1 text contrast, received ${ratio.toFixed(2)}:1`,
    );
}

/** Validate the pane's own scroll and grid geometry without relying on viewport breakpoints. */
async function resourceLayout(dashboard: Locator) {
    const root = dashboard.locator('[data-dashboard-state]').first();
    const resources = dashboard
        .getByRole('group', { name: 'Resource metrics', exact: true })
        .first();
    return {
        pane: await root.evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        })),
        cards: await resources.locator(':scope > *').evaluateAll((elements) =>
            elements.map((element) => {
                const rect = element.getBoundingClientRect();
                return { top: rect.top, left: rect.left, right: rect.right, width: rect.width };
            }),
        ),
    };
}

/** Count rendered action columns and rows, rather than inspecting responsive utility classes. */
async function quickActionLayout(dashboard: Locator) {
    return dashboard
        .getByRole('region', { name: 'Quick actions', exact: true })
        .getByRole('button')
        .evaluateAll((buttons) => {
            const boxes = buttons.map((button) => button.getBoundingClientRect());
            return {
                actions: boxes.length,
                columns: new Set(boxes.map((box) => Math.round(box.left))).size,
                rows: new Set(boxes.map((box) => Math.round(box.top))).size,
            };
        });
}

/** Locate a resource card's main reading separately from its optional detail values. */
function resourceValue(card: Locator): Locator {
    return card.locator(':scope > div').first().locator('span').first();
}

/** Read actual SVG coordinates to check the visible chart rather than its styling classes. */
async function traceCoordinates(chart: Locator) {
    return chart
        .locator('polyline')
        .evaluateAll((lines) =>
            lines.map((line) =>
                Array.from((line as SVGPolylineElement).points).map(({ x, y }) => ({ x, y })),
            ),
        );
}

/** Check deterministic history charts before the longer polling and lifecycle scenarios. */
async function testHistoryCharts(page: Page, fixtureUrl: string): Promise<void> {
    await page.goto(`${fixtureUrl}?history=1`, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1440, height: 1100 });
    const examples = page.getByRole('main', { name: 'History examples', exact: true });
    await examples.waitFor();
    const historyCard = (name: string) => examples.getByRole('region', { name, exact: true });
    const historyChart = (name: string) => historyCard(name).getByRole('img');
    const rising = (await traceCoordinates(historyChart('Rising usage')))[0];
    assert.equal(rising.length, 3, 'Each measured rising observation is represented');
    assert.ok(rising[0].y > rising[1].y && rising[1].y > rising[2].y);
    const bottom = rising[0].y;
    const top = rising[2].y;
    assert.ok(Math.abs(rising[1].y - (top + bottom) / 2) < 0.1, '50% uses the fixed midpoint');
    for (const [name, percentage] of [
        ['Flat full usage', 100],
        ['Flat steady usage', 43.4],
    ] as const) {
        const card = historyCard(name);
        const points = (await traceCoordinates(card.getByRole('img')))[0];
        assert.equal(points.length, 3);
        const expected = bottom - (percentage / 100) * (bottom - top);
        assert.ok(
            points.every((point) => Math.abs(point.y - expected) < 0.1),
            `${percentage}% stays flat at its actual position on the fixed scale`,
        );
        await card.getByText(`Steady at ${percentage.toFixed(1)}%`, { exact: true }).waitFor();
        for (const label of ['100%', '50%', '0%']) {
            await card
                .getByRole('button', { name: `Inspect ${name} history`, exact: true })
                .getByText(label, { exact: true })
                .waitFor();
        }
        assert.equal(await card.getByRole('img').locator('polygon').count(), 1);
        const currentY = Number(
            await card.getByRole('img').locator('circle[data-current]').getAttribute('cy'),
        );
        assert.ok(Math.abs(currentY - expected) < 0.1, 'The latest dot aligns with the trace');
    }
    const uneven = (await traceCoordinates(historyChart('Uneven timing')))[0];
    assert.ok(
        Math.abs((uneven[1].x - uneven[0].x) / (uneven[2].x - uneven[0].x) - 0.25) < 0.01,
        'A 3-second then 9-second interval uses elapsed-time spacing',
    );
    const interrupted = await traceCoordinates(historyChart('Interrupted usage'));
    assert.deepEqual(
        interrupted.map((segment) => segment.length),
        [2, 2],
        'An unobserved 30-second gap is not joined by a trace',
    );
    assert.equal(
        await historyChart('Interrupted usage').locator('polygon').count(),
        2,
        'Area fills do not bridge an unobserved gap',
    );
    const single = historyChart('One measured sample');
    assert.equal(await single.locator('polyline, polygon').count(), 0);
    assert.equal(await single.locator('circle[data-current]').count(), 1);
    const bounded = await traceCoordinates(historyChart('Bounded history'));
    assert.equal(
        bounded.reduce((count, segment) => count + segment.length, 0),
        20,
        'The visible chart bounds history and rejects duplicate or invalid observations',
    );
    const inspectedCard = historyCard('Uneven timing');
    const inspect = inspectedCard.getByRole('button', {
        name: 'Inspect Uneven timing history',
        exact: true,
    });
    const readout = inspectedCard.getByRole('status', { name: 'Uneven timing inspected sample' });
    const acquiredAt = (seconds: number) =>
        new Date(Date.UTC(2026, 10, 8, 12, 0, seconds)).toISOString();
    assert.equal(await inspectedCard.getByRole('button').count(), 1, 'A chart has one focus stop');
    await inspect.focus();
    for (const [key, seconds, percentage] of [
        ['Home', 0, '20.0%'],
        ['ArrowRight', 3, '40.0%'],
        ['ArrowLeft', 0, '20.0%'],
        ['End', 12, '60.0%'],
    ] as const) {
        await inspect.press(key);
        await readout.locator(`time[datetime="${acquiredAt(seconds)}"]`).waitFor();
        assert.ok(
            (await readout.innerText()).includes(percentage),
            'Inspection reports the measured value',
        );
    }
    const middlePoint = await historyChart('Uneven timing').evaluate((element, point) => {
        const svg = element as SVGSVGElement;
        const screen = svg.getScreenCTM();
        if (!screen) {
            throw new Error('The visible SVG must expose its rendered coordinate transform');
        }
        const position = new DOMPoint(point.x, point.y).matrixTransform(screen);
        return { x: position.x, y: position.y };
    }, uneven[1]);
    await page.mouse.move(middlePoint.x, middlePoint.y);
    await readout.locator('time').filter({ hasText: /./ }).waitFor();
    await page.waitForFunction(
        (timestamp: string) =>
            document
                .querySelector('output[aria-label="Uneven timing inspected sample"] time')
                ?.getAttribute('datetime') === timestamp,
        acquiredAt(3),
    );
    assert.equal(await page.locator('body').getAttribute('data-metric-calls'), null);
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await examples.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-history-wide-dark.png',
        });
    }
    await page.getByRole('button', { name: 'Narrow history fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Light history fixture', exact: true }).click();
    for (const card of await examples.getByRole('region').all()) {
        const width = await card.evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
        assert.ok(width.scroll <= width.client + 1, 'History labels fit a narrow card');
    }
    await assertReadableText(readout, 'Light chart inspection readout');
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await examples.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-history-narrow-light.png',
        });
    }
    console.log(
        'Measured chart scales, timestamps, gaps, bounded history and keyboard/pointer inspection passed.',
    );
}

try {
    browser = await chromium.launch({
        channel: process.env.ZYNC_BROWSER_CHANNEL || 'msedge',
        headless: true,
    });
    const page = await browser.newPage({
        viewport: { width: 1080, height: 820 },
        reducedMotion: 'reduce',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DashboardFixture/1.0',
    });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await testHistoryCharts(page, fixtureUrl);
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 1080, height: 820 });
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    const dashboard = page.locator('[data-dashboard-fixture]');
    const calls = async () =>
        Number((await page.locator('body').getAttribute('data-metric-calls')) || 0);
    await dashboard.getByRole('heading', { name: 'System overview', exact: true }).waitFor();
    assert.equal(
        await dashboard.getByText('CPU Usage', { exact: true }).count(),
        0,
        'Offline hosts do not show zero or stale live widgets',
    );
    assert.equal(
        await dashboard.getByRole('heading', { name: 'Quick actions', exact: true }).count(),
        0,
        'Offline dashboard does not expose remote actions',
    );
    await page.waitForTimeout(3250);
    assert.equal(await calls(), 0, 'Opening an offline dashboard never polls the host');

    await dashboard.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    assert.equal(
        await page.locator('body').getAttribute('data-connect-calls'),
        '1',
        'Connection is an explicit user action',
    );
    await dashboard.getByRole('button', { name: /Connecting/ }).waitFor();
    assert.equal(await calls(), 0, 'An unfinished connection never starts polling');
    assert.equal(await dashboard.getByText('CPU Usage', { exact: true }).count(), 0);
    const cancel = dashboard.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.waitFor();
    await page.setViewportSize({ width: 340, height: 750 });
    assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
        'Connecting and Cancel fit a narrow pane',
    );
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await page.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-connecting-narrow.png',
        });
    }
    await cancel.click();
    await dashboard.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
    assert.equal(
        await page.locator('body').getAttribute('data-cancel-calls'),
        '1',
        'Cancel uses the existing host cancellation action exactly once',
    );
    assert.equal(await calls(), 0, 'Cancelling never starts metric collection');
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.ignoredLateCompletion === 'true');
    assert.equal(
        await dashboard.getByText('CPU Usage', { exact: true }).count(),
        0,
        'A late completion cannot resurrect the cancelled attempt',
    );
    assert.equal(await calls(), 0);

    await page.setViewportSize({ width: 1080, height: 820 });
    await dashboard.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await cancel.waitFor();
    assert.equal(
        await page.locator('body').getAttribute('data-connect-calls'),
        '2',
        'The host can be connected again after cancellation',
    );

    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await dashboard.getByText('CPU Usage', { exact: true }).waitFor();
    await page.waitForFunction(() => Number(document.body.dataset.metricCalls || 0) > 0);
    await dashboard.getByRole('heading', { name: 'Quick actions', exact: true }).waitFor();
    const beforeDisconnect = await calls();
    await page.getByRole('button', { name: 'Disconnect fixture', exact: true }).click();
    await dashboard.getByRole('heading', { name: 'System overview', exact: true }).waitFor();
    assert.equal(
        await dashboard.getByText('CPU Usage', { exact: true }).count(),
        0,
        'Disconnect hides previously collected live metrics',
    );
    await page.waitForTimeout(3250);
    assert.equal(await calls(), beforeDisconnect, 'Disconnect stops scheduled polling');

    await page.getByRole('button', { name: 'Fail connection fixture', exact: true }).click();
    await dashboard.getByRole('button', { name: /Retry/ }).waitFor();
    await dashboard.getByText('Connection timed out.', { exact: true }).waitFor();
    const timeoutDetails = dashboard.getByText(
        'Connection timed out while connecting to dashboard.invalid:22 (synthetic socket timeout).',
        { exact: true },
    );
    assert.equal(
        await timeoutDetails.isVisible(),
        false,
        'A known failure has a concise reason without expanded technical detail',
    );
    await dashboard.locator('summary').filter({ hasText: 'Connection details' }).click();
    await timeoutDetails.waitFor({ state: 'visible' });
    await dashboard.locator('summary').filter({ hasText: 'Connection details' }).click();
    await dashboard.getByRole('button', { name: 'Edit host', exact: true }).click();
    assert.equal(
        await page.locator('body').getAttribute('data-edited-host'),
        'dashboard-fixture',
        'Edit retains the existing saved-host flow',
    );
    await dashboard.getByRole('button', { name: 'Retry connection', exact: true }).click();
    await cancel.waitFor();
    assert.equal(
        await page.locator('body').getAttribute('data-connect-calls'),
        '3',
        'Retry uses the same explicit connection action',
    );
    await cancel.click();
    await dashboard.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-cancel-calls'), '2');
    await page.getByRole('button', { name: 'Unknown failure fixture', exact: true }).click();
    await dashboard.getByText('Could not connect to this host.', { exact: true }).waitFor();
    assert.equal(
        await dashboard
            .getByText(
                'Synthetic transport diagnostic: opaque failure 0xF17; fixture-only details that do not belong in the summary.',
                { exact: true },
            )
            .isVisible(),
        false,
        'Unknown failures keep broad raw diagnostics out of the summary',
    );
    assert.equal(await calls(), beforeDisconnect, 'Connection errors do not restart polling');
    await page.setViewportSize({ width: 340, height: 750 });
    assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
        'Offline recovery fits a narrow pane',
    );
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await page.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-disconnected-narrow.png',
        });
    }
    await page.getByRole('button', { name: 'Remove host fixture', exact: true }).click();
    assert.equal(await dashboard.getByText('CPU Usage', { exact: true }).count(), 0);
    assert.equal(
        await calls(),
        beforeDisconnect,
        'A removed host cannot receive telemetry requests',
    );
    assert.deepEqual(errors, []);
    console.log('Dashboard disconnected browser checks passed.');

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page
        .getByRole('button', { name: 'Activate other workspace fixture', exact: true })
        .click();
    await dashboard.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await dashboard.getByText('Fixture Linux x86_64', { exact: true }).waitFor();
    assert.equal(await calls(), 1, 'A nonactive host pane still owns its live sample');
    await page.getByRole('button', { name: 'Show second dashboard fixture', exact: true }).click();
    await dashboard.getByText('Fixture Linux x86_64', { exact: true }).nth(1).waitFor();
    assert.equal(await dashboard.getByText('Fixture Linux x86_64', { exact: true }).count(), 2);
    assert.equal(await calls(), 1, 'Two host dashboards share the current sample');

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page
        .getByRole('button', { name: 'Show two local dashboards fixture', exact: true })
        .click();
    await page.waitForFunction(() => document.body.dataset.pendingSamples === '1');
    assert.equal(
        await calls(),
        1,
        'Two local Windows dashboards share one in-flight native request',
    );
    assert.equal(await page.locator('body').getAttribute('data-last-metric-target'), 'local');
    await page.getByRole('button', { name: 'Release sample fixture', exact: true }).click();
    await dashboard.getByText('Fixture Windows fixture-arch', { exact: true }).first().waitFor();
    assert.equal(
        await dashboard.getByText('Fixture Windows fixture-arch', { exact: true }).count(),
        2,
    );
    await page.getByRole('button', { name: 'Toggle visibility fixture', exact: true }).click();
    const hiddenCalls = await calls();
    await page.waitForTimeout(3250);
    assert.equal(await calls(), hiddenCalls, 'Hidden dashboards do not create a sampler loop');
    await page.getByRole('button', { name: 'Toggle visibility fixture', exact: true }).click();
    await page.waitForFunction(
        (before: number) => Number(document.body.dataset.metricCalls) > before,
        hiddenCalls,
    );
    assert.equal(await calls(), hiddenCalls + 1, 'Showing both panes shares one fresh sample');

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await dashboard.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await dashboard.getByText('Fixture Linux x86_64', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hold next sample fixture', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.pendingSamples === '1');
    await page.getByRole('button', { name: 'Disconnect fixture', exact: true }).click();
    await dashboard.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await page.waitForFunction(() => Number(document.body.dataset.metricCalls) >= 3);
    await page.getByRole('button', { name: 'Reject old sample fixture', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(
        await page.locator('body').getAttribute('data-unexpected-disconnect'),
        null,
        'An old Connection not found error must not disconnect its replacement',
    );
    await dashboard.getByText('CPU Usage', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Dashboard shared sampling, visibility, split-owner and reconnect checks passed.');

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await dashboard.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await dashboard.getByText('Fixture Linux x86_64', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hold next sample fixture', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.pendingSamples === '1');
    const beforeReplacement = await calls();
    await page.getByRole('button', { name: 'Replace transport fixture', exact: true }).click();
    await page.waitForFunction(
        (before: number) => Number(document.body.dataset.metricCalls || 0) > before,
        beforeReplacement,
        { timeout: 5000 },
    );
    assert.equal(
        await calls(),
        beforeReplacement + 1,
        'A changed transport starts a fresh sample without waiting for the old request',
    );
    await dashboard
        .getByRole('region', { name: 'CPU Usage', exact: true })
        .locator(':scope > div')
        .first()
        .getByText('Not available', { exact: true })
        .waitFor();
    await page.getByRole('button', { name: 'Reject old sample fixture', exact: true }).click();
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
    );
    await dashboard.getByRole('status').filter({ hasText: 'Live Monitoring' }).waitFor();
    assert.equal(
        await page.locator('body').getAttribute('data-unexpected-disconnect'),
        null,
        'A failed old sample cannot disconnect a replacement that stayed connected',
    );
    assert.equal(
        await dashboard
            .getByRole('heading', { name: 'Metrics update failed', exact: true })
            .count(),
        0,
        'The old epoch does not publish an error in the replacement dashboard',
    );
    console.log(
        'Dashboard restarts sampling when a connected host receives a new transport epoch.',
    );

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await dashboard.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await dashboard.getByText('Fixture Linux x86_64', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show second dashboard fixture', exact: true }).click();
    await dashboard.getByText('Fixture Linux x86_64', { exact: true }).nth(1).waitFor();
    await page.getByRole('button', { name: 'Clear sampled icon fixture', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.metadataWrites === '1');
    assert.equal(
        await page.locator('body').getAttribute('data-current-icon'),
        'linux',
        'The first automatic update claims the current missing field immediately',
    );
    await page.waitForTimeout(3250);
    assert.equal(
        await page.locator('body').getAttribute('data-metadata-writes'),
        '1',
        'Two polling panes cannot repeat a pending metadata save',
    );
    await page.getByRole('button', { name: 'Release metadata save fixture', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('Dashboard dual-pane pending metadata save checks passed.');

    await dashboard
        .getByRole('button', { name: /Check Disk Space/ })
        .first()
        .click();
    await page.getByText('Quick action fixture output', { exact: true }).waitFor();
    assert.equal(
        await page.locator('body').getAttribute('data-last-quick-action-target'),
        'dashboard-fixture',
    );
    assert.equal(
        await page.locator('body').getAttribute('data-last-quick-action-command'),
        'df -h',
    );

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page
        .getByRole('button', { name: 'Show two local dashboards fixture', exact: true })
        .click();
    await dashboard
        .getByRole('button', { name: /Check Disk Space/ })
        .first()
        .click();
    await page.getByText('Quick action fixture output', { exact: true }).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-last-quick-action-target'), 'local');
    assert.match(
        (await page.locator('body').getAttribute('data-last-quick-action-command')) || '',
        /Get-PSDrive/,
    );
    assert.deepEqual(errors, []);
    console.log('Dashboard Quick Actions preserve remote and local connection targets.');

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: 'Hold next sample fixture', exact: true }).click();
    await dashboard.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.pendingSamples === '1');
    const liveDashboard = dashboard.locator('[data-dashboard-state]').first();
    const cpu = dashboard.getByRole('region', { name: 'CPU Usage', exact: true });
    const cpuValue = resourceValue(cpu);
    await dashboard.getByText('Collecting metrics…', { exact: true }).waitFor();
    assert.equal(await liveDashboard.getAttribute('data-dashboard-state'), 'loading');
    await cpuValue.filter({ hasText: /^Waiting for sample$/ }).waitFor();
    assert.equal(
        await cpu.getByText(/^0(?:\.0)?%$/).count(),
        0,
        'Pending CPU is never presented as measured zero',
    );
    assert.equal(
        await cpu.getByRole('img').count(),
        0,
        'Pending CPU has no manufactured chart history',
    );

    const summaryCards = [
        ['Disk usage', '20%'],
        ['System uptime', '3 hours'],
        ['Processes', '81'],
    ].map(([name, value]) => ({
        card: dashboard.getByRole('region', { name, exact: true }),
        value,
    }));
    for (const { card } of summaryCards) {
        await card.getByText('Waiting for sample', { exact: true }).waitFor();
    }
    const otherSummaryValues = [
        cpuValue,
        resourceValue(dashboard.getByRole('region', { name: 'Memory Usage', exact: true })),
        dashboard.getByRole('region', { name: 'System Info', exact: true }).locator('p').first(),
    ];
    for (const value of otherSummaryValues) {
        await value.filter({ hasText: /^Waiting for sample$/ }).waitFor();
    }
    const initialNetwork = dashboard.getByRole('region', {
        name: 'Network interfaces',
        exact: true,
    });
    await initialNetwork.getByText('Waiting for network sample', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hold next sample fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Reject sample fixture', exact: true }).click();
    await dashboard.getByRole('heading', { name: 'Metrics update failed', exact: true }).waitFor();
    for (const { card } of summaryCards) {
        await card.getByText('Unavailable', { exact: true }).waitFor();
    }
    for (const value of otherSummaryValues) {
        await value.filter({ hasText: /^Not available$/ }).waitFor();
    }
    await initialNetwork.getByText('Network readings are unavailable.', { exact: true }).waitFor();
    assert.equal(await liveDashboard.getAttribute('data-dashboard-state'), 'unavailable');
    await page.waitForFunction(() => document.body.dataset.pendingSamples === '1');

    await page.getByRole('button', { name: 'Release sample fixture', exact: true }).click();
    await dashboard.getByText('Fixture Linux x86_64', { exact: true }).waitFor();
    for (const { card, value } of summaryCards) {
        await card.getByText(value, { exact: true }).waitFor();
    }
    await cpuValue.filter({ hasText: /^Not available$/ }).waitFor();
    assert.equal(await liveDashboard.getAttribute('data-dashboard-state'), 'live');
    assert.equal(
        await cpu.getByText(/^0(?:\.0)?%$/).count(),
        0,
        'One Linux kernel snapshot is not a utilization measurement',
    );
    assert.equal(
        await cpu.getByRole('img').count(),
        0,
        'An unavailable CPU reading does not create a zero history point',
    );
    await cpuValue.filter({ hasText: /^30\.0%$/ }).waitFor();
    assert.equal(
        await cpu.getByRole('img').locator('polyline').count(),
        0,
        'One real CPU sample does not manufacture a historical line',
    );
    assert.equal(
        await cpu.getByRole('img').locator('circle[data-current]').count(),
        1,
        'One real CPU observation appears as a single measured point',
    );
    const cachedCalls = await calls();
    const cachedTimestamp = await liveDashboard
        .getByText(/^Last updated /)
        .getAttribute('datetime');
    assert.ok(cachedTimestamp, 'Successful samples expose their acquisition timestamp');
    await page.getByRole('button', { name: 'Toggle visibility fixture', exact: true }).click();
    await dashboard.getByRole('status').filter({ hasText: 'Monitoring paused' }).waitFor();
    await page.getByRole('button', { name: 'Toggle visibility fixture', exact: true }).click();
    await dashboard.getByRole('status').filter({ hasText: 'Live Monitoring' }).waitFor();
    // Allow the cached promise and React commit to finish before inspecting retained history.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
    );
    assert.equal(
        await calls(),
        cachedCalls,
        'Showing a pane within the sample TTL reuses its cached reading',
    );
    assert.equal(
        await liveDashboard.getByText(/^Last updated /).getAttribute('datetime'),
        cachedTimestamp,
        'Cached reuse does not refresh the acquisition timestamp',
    );
    assert.equal(
        await cpu.getByRole('img').locator('polyline').count(),
        0,
        'Cached reuse cannot append a duplicate CPU history point',
    );
    await cpu
        .getByRole('img', { name: /CPU Usage recent samples/ })
        .locator('polyline')
        .waitFor({ state: 'attached' });
    await cpu.getByRole('img', { name: /CPU Usage recent samples/ }).waitFor();
    assert.equal(
        await cpu.getByRole('img').locator('polyline').getAttribute('stroke'),
        'currentColor',
    );
    for (const name of ['Processes', 'System uptime']) {
        const card = dashboard.getByRole('region', { name, exact: true });
        assert.equal(await card.getByRole('img').count(), 0, `${name} has no fabricated history`);
        assert.equal(
            await card.getByRole('meter').count(),
            0,
            `${name} is not presented as a percentage`,
        );
    }
    await dashboard.getByText(/^Last updated /).waitFor();

    const wide = await resourceLayout(dashboard);
    assert.ok(wide.cards.length >= 3, 'The resource group contains CPU, memory and disk cards');
    assert.ok(
        Math.abs(wide.cards[0].top - wide.cards[1].top) < 2,
        'A wide pane uses available columns',
    );
    assert.deepEqual(
        await quickActionLayout(dashboard),
        { actions: 6, columns: 3, rows: 2 },
        'Wide Quick Actions use three balanced columns and two rows',
    );
    await page.getByRole('button', { name: 'Narrow dashboard pane fixture', exact: true }).click();
    await page.waitForFunction(
        () => document.querySelector<HTMLElement>('[data-dashboard-fixture]')?.clientWidth === 340,
    );
    const narrow = await resourceLayout(dashboard);
    assert.equal(
        await page.evaluate(() => window.innerWidth),
        1440,
        'The window stays wide while the dashboard pane narrows',
    );
    assert.ok(
        narrow.pane.scroll <= narrow.pane.client + 1,
        'A narrow dashboard pane does not scroll horizontally',
    );
    assert.ok(
        narrow.cards[1].top > narrow.cards[0].top,
        'Cards stack according to pane width instead of window width',
    );
    assert.ok(
        narrow.cards.every((card) => card.width <= 340),
        'No resource card extends beyond the pane',
    );
    assert.deepEqual(
        await quickActionLayout(dashboard),
        { actions: 6, columns: 1, rows: 6 },
        'A narrow pane stacks Quick Actions even in a wide window',
    );
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await page.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-live-narrow-pane.png',
        });
    }
    await page.getByRole('button', { name: 'Medium dashboard pane fixture', exact: true }).click();
    await page.waitForFunction(
        () => document.querySelector<HTMLElement>('[data-dashboard-fixture]')?.clientWidth === 700,
    );
    assert.deepEqual(
        await quickActionLayout(dashboard),
        { actions: 6, columns: 2, rows: 3 },
        'A medium pane uses two Quick Action columns',
    );
    await page.getByRole('button', { name: 'Wide dashboard pane fixture', exact: true }).click();
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await liveDashboard.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-live-wide.png',
        });
    }

    await page.getByRole('button', { name: 'Hold next sample fixture', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.pendingSamples === '1');
    await dashboard.getByText('Metrics out of date', { exact: true }).waitFor({ timeout: 12_000 });
    await cpuValue.filter({ hasText: /^30\.0%$/ }).waitFor();
    await page.getByRole('button', { name: 'Reject sample fixture', exact: true }).click();
    await dashboard.getByRole('heading', { name: 'Metrics update failed', exact: true }).waitFor();
    assert.equal(await liveDashboard.getAttribute('data-dashboard-state'), 'stale');
    await cpuValue.filter({ hasText: /^30\.0%$/ }).waitFor();
    const metricDetails = dashboard.getByText(
        'Synthetic metrics refresh failed: the dashboard retained its last successful sample; inspect this complete diagnostic in Metric details.',
        { exact: true },
    );
    assert.equal(
        await metricDetails.isVisible(),
        false,
        'Metric diagnostics stay collapsed until explicitly opened',
    );
    await dashboard.locator('summary').filter({ hasText: 'Metric details' }).click();
    await metricDetails.waitFor({ state: 'visible' });
    assert.equal(
        await page.locator('body').getAttribute('data-unexpected-disconnect'),
        null,
        'A metrics refresh failure does not disconnect the host',
    );
    console.log(
        'Dashboard loading, Linux CPU deltas, truthful histories, pane layout and stale-detail checks passed.',
    );

    for (const theme of ['Light', 'Dark']) {
        await page.getByRole('button', { name: `${theme} theme fixture`, exact: true }).click();
        const action = dashboard.getByRole('button', { name: /Check Disk Space/ }).first();
        await assertReadableText(action, `${theme} Quick Action button`);
        await action.click();
        const output = page.getByRole('dialog', { name: 'Check Disk Space', exact: true });
        await output.getByText('Quick action fixture output', { exact: true }).waitFor();
        await assertReadableText(output.locator('pre'), `${theme} Quick Action output`);
        const close = output
            .getByRole('button', { name: 'Close', exact: true })
            .filter({ hasText: /^Close$/ });
        await assertReadableText(close, `${theme} Quick Action close button`);
        await close.click();
        await output.waitFor({ state: 'hidden' });
    }
    assert.deepEqual(errors, []);
    console.log(
        'Dashboard Quick Actions and output dialogs remain readable in light and dark themes.',
    );

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await dashboard.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
    await page.getByRole('button', { name: 'Complete connection fixture', exact: true }).click();
    const primary = dashboard.getByRole('region', { name: 'System overview', exact: true }).first();
    await primary.getByText('Fixture Linux x86_64', { exact: true }).waitFor();
    const detailCalls = async (kind: 'process' | 'filesystem') =>
        Number((await page.locator('body').getAttribute(`data-${kind}-calls`)) || 0);
    const richCpu = primary.getByRole('region', { name: 'CPU Usage', exact: true });
    const memory = primary.getByRole('region', { name: 'Memory Usage', exact: true });
    await richCpu.getByText('4', { exact: true }).waitFor();
    await richCpu.getByText('0.30 / 0.20 / 0.10', { exact: true }).waitFor();
    await memory.getByText('6.0 GiB', { exact: true }).waitFor();
    await memory.getByText('1.0 GiB', { exact: true }).waitFor();
    await memory.getByText('512 MiB / 2.0 GiB', { exact: true }).waitFor();
    const network = primary.getByRole('region', { name: 'Network interfaces', exact: true });
    const ethernet = network.getByRole('row').filter({ hasText: 'eth0' });
    assert.equal(
        await ethernet.getByText('Waiting for rate sample', { exact: true }).count(),
        2,
        'The first network counter snapshot is not a zero rate',
    );
    const processes = primary.getByRole('region', { name: 'Process details', exact: true });
    const filesystems = primary.getByRole('region', { name: 'Filesystems', exact: true });
    assert.equal(await detailCalls('process'), 0, 'Closed process details issue no commands');
    assert.equal(await detailCalls('filesystem'), 0, 'Closed filesystem details issue no commands');
    assert.equal(
        await processes.getByRole('table').count(),
        0,
        'Closed process rows are not mounted',
    );
    assert.equal(
        await filesystems.getByRole('table').count(),
        0,
        'Closed filesystem rows are not mounted',
    );
    await page
        .getByRole('button', { name: 'Hold next process sample fixture', exact: true })
        .click();
    const processSummary = processes.locator('details > summary').first();
    await processSummary.press('Enter');
    await page.waitForFunction(() => document.body.dataset.pendingProcesses === '1');
    await processes.getByText('Collecting process sample…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show second dashboard fixture', exact: true }).click();
    const secondary = dashboard
        .getByRole('region', { name: 'System overview', exact: true })
        .nth(1);
    const secondProcesses = secondary.getByRole('region', { name: 'Process details', exact: true });
    const secondProcessSummary = secondProcesses.locator('details > summary').first();
    await secondProcessSummary.press('Enter');
    await secondProcesses.getByText('Collecting process sample…', { exact: true }).waitFor();
    assert.equal(
        await detailCalls('process'),
        1,
        'Two expanded panes share the in-flight process scan',
    );
    await page.getByRole('button', { name: 'Release process sample fixture', exact: true }).click();
    await processes.getByRole('table').waitFor();
    await secondProcesses.getByRole('table').waitFor();
    assert.equal(
        await processes.getByText('Waiting for CPU sample', { exact: true }).count(),
        10,
        'Process CPU waits for a second counter snapshot',
    );
    assert.equal(
        await processes.locator('tbody tr').count(),
        10,
        'Only selected process rows are rendered',
    );
    await processes.getByText(/The process scan was limited/).waitFor();
    assert.equal(
        await processes.locator('time').getAttribute('datetime'),
        await secondProcesses.locator('time').getAttribute('datetime'),
        'Shared process views keep the same acquisition time',
    );
    assert.equal(
        await page.locator('body').getAttribute('data-last-process-target'),
        'dashboard-fixture',
    );
    await page.waitForFunction(
        () => Number(document.body.dataset.processCalls || 0) >= 2,
        undefined,
        { timeout: DASHBOARD_PROCESS_REFRESH_MS + 5000 },
    );
    const cpuProcess = processes.getByRole('row').filter({ hasText: 'cpu-burner fixture' });
    await cpuProcess.getByRole('cell', { name: '10.0%', exact: true }).waitFor();
    assert.equal(
        await detailCalls('process'),
        2,
        'Both open panes share each scheduled process refresh',
    );
    assert.equal(
        await processes.getByText('memory-heavy <fixture>', { exact: true }).count(),
        0,
        'CPU sorting selects candidates from the complete collected sample',
    );
    const processTime = await processes.locator('time').getAttribute('datetime');
    const processSort = processes.getByRole('combobox', {
        name: 'Sort process sample',
        exact: true,
    });
    await processSort.click();
    await page.getByRole('option', { name: 'Memory usage', exact: true }).click();
    await processes.getByRole('cell', { name: 'memory-heavy <fixture>', exact: true }).waitFor();
    assert.equal(
        await processes.locator('fixture').count(),
        0,
        'Process names render as text rather than markup',
    );
    assert.equal(
        await detailCalls('process'),
        2,
        'Changing sort within the cache window issues no extra command',
    );
    assert.equal(
        await processes.locator('time').getAttribute('datetime'),
        processTime,
        'Cached sorting preserves acquisition time',
    );
    await processSort.click();
    await page.getByRole('option', { name: 'CPU usage', exact: true }).click();
    await cpuProcess.getByRole('cell', { name: '10.0%', exact: true }).waitFor();

    await page.waitForFunction(() => {
        const rows = Array.from(
            document.querySelectorAll('section[aria-label="Network interfaces"] tbody tr'),
        );
        const row = rows.find((element) => element.textContent?.includes('eth0'));
        return (
            row &&
            Array.from(row.querySelectorAll('td')).every(
                (cell) =>
                    /\/s$/.test(cell.textContent || '') &&
                    Number.parseFloat(cell.textContent || '') > 0,
            )
        );
    });
    assert.equal(
        await network
            .getByRole('row')
            .filter({ hasText: 'lo' })
            .getByText('0 B/s', { exact: true })
            .count(),
        2,
        'A measured idle interface remains distinguishable from an unavailable rate',
    );
    const filesystemSummary = filesystems.locator('details > summary').first();
    await filesystemSummary.press('Enter');
    await filesystems
        .getByRole('rowheader', { name: '/srv/data with spaces', exact: true })
        .waitFor();
    await filesystems
        .getByRole('cell', { name: '/dev/fixture disk café <unsafe>', exact: true })
        .waitFor();
    assert.equal(
        await filesystems.locator('unsafe').count(),
        0,
        'Filesystem labels are escaped text',
    );
    assert.equal(
        await detailCalls('filesystem'),
        1,
        'Opening filesystem details admits one separate slow collection',
    );
    assert.equal(
        await page.locator('body').getAttribute('data-last-filesystem-target'),
        'dashboard-fixture',
    );
    const emptyFilesystem = filesystems.getByRole('row').filter({ hasText: '/srv/empty fixture' });
    await emptyFilesystem.getByRole('cell', { name: '0 B', exact: true }).waitFor();
    await emptyFilesystem.getByRole('cell', { name: '0.0%', exact: true }).waitFor();
    await emptyFilesystem.getByRole('cell', { name: 'Unavailable', exact: true }).waitFor();
    const filesystemTime = await filesystems.locator('time').getAttribute('datetime');
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await processes.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-processes-wide-dark.png',
        });
        await filesystems.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-filesystems-wide-dark.png',
        });
    }
    await page.getByRole('button', { name: 'Narrow dashboard pane fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Light theme fixture', exact: true }).click();
    const expandedWidth = await primary.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
    }));
    assert.ok(
        expandedWidth.scroll <= expandedWidth.client + 1,
        'Expanded data tables keep horizontal scrolling inside their panels',
    );
    for (const tableRegion of [
        processes.getByRole('region', { name: 'Process table', exact: true }),
        filesystems.getByRole('region', { name: 'Filesystem table', exact: true }),
    ]) {
        const dimensions = await tableRegion.evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
        assert.ok(
            dimensions.scroll > dimensions.client,
            'Narrow tables retain a local horizontal scroll target',
        );
    }
    await assertReadableText(
        processes.getByRole('columnheader', { name: 'Process', exact: true }),
        'Light process table header',
    );
    await assertReadableText(
        filesystems.getByRole('rowheader', { name: '/srv/data with spaces', exact: true }),
        'Light filesystem mount label',
    );
    if (process.env.ZYNC_BROWSER_SCREENSHOT_DIR) {
        await processes.screenshot({
            path: process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-processes-narrow-light.png',
        });
        await filesystems.screenshot({
            path:
                process.env.ZYNC_BROWSER_SCREENSHOT_DIR + '/dashboard-filesystems-narrow-light.png',
        });
    }
    await page.getByRole('button', { name: 'Wide dashboard pane fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Hide document fixture', exact: true }).click();
    const pausedFast = await calls();
    const pausedProcesses = await detailCalls('process');
    const pausedFilesystems = await detailCalls('filesystem');
    await page.waitForTimeout(DASHBOARD_PROCESS_REFRESH_MS + 250);
    assert.equal(await calls(), pausedFast, 'A hidden document stops summary polling');
    assert.equal(
        await detailCalls('process'),
        pausedProcesses,
        'A hidden document stops open process polling',
    );
    assert.equal(
        await detailCalls('filesystem'),
        pausedFilesystems,
        'A hidden document admits no filesystem work',
    );
    await page
        .getByRole('button', { name: 'Hold next process sample fixture', exact: true })
        .click();
    await page.getByRole('button', { name: 'Show document fixture', exact: true }).click();
    await page.waitForFunction(
        (previous: number) => Number(document.body.dataset.processCalls || 0) > previous,
        pausedProcesses,
    );
    assert.equal(
        await detailCalls('filesystem'),
        pausedFilesystems,
        'Restoring a recent filesystem view reuses its cached scan',
    );
    assert.equal(
        await filesystems.locator('time').getAttribute('datetime'),
        filesystemTime,
        'Cached filesystem reuse preserves acquisition time',
    );
    await processSummary.press('Enter');
    await secondProcessSummary.press('Enter');
    await filesystemSummary.press('Enter');
    await processes.getByRole('table').waitFor({ state: 'detached' });
    await secondProcesses.getByRole('table').waitFor({ state: 'detached' });
    await filesystems.getByRole('table').waitFor({ state: 'detached' });
    const closedProcesses = await detailCalls('process');
    const closedFilesystems = await detailCalls('filesystem');
    const visibleFast = await calls();
    await page.waitForTimeout(DASHBOARD_PROCESS_REFRESH_MS + 250);
    assert.equal(
        await detailCalls('process'),
        closedProcesses,
        'Collapsed process panels stop scheduled collection',
    );
    assert.equal(
        await detailCalls('filesystem'),
        closedFilesystems,
        'Collapsed filesystem panels admit no work',
    );
    assert.ok(
        (await calls()) > visibleFast,
        'Closing expensive details leaves the visible summary running',
    );

    await processSummary.press('Enter');
    await page.waitForFunction(() => document.body.dataset.pendingProcesses === '1');
    await processes
        .getByRole('status')
        .filter({ hasText: 'Process readings are out of date. Waiting for a fresh sample.' })
        .waitFor();
    assert.equal(
        await processes.getByText('Process update failed', { exact: true }).count(),
        0,
        'An old successful reading is stale, not a failed collection',
    );

    const cpuSortedTable = processes.getByRole('table', {
        name: 'Sampled processes sorted by CPU usage',
        exact: true,
    });
    await processSort.click();
    await page.getByRole('option', { name: 'Memory usage', exact: true }).click();
    await processSort.getByText('Memory usage', { exact: true }).waitFor();
    await processes.getByText('Showing rows sorted by CPU usage.', { exact: true }).waitFor();
    await cpuSortedTable.getByRole('cell', { name: 'cpu-burner fixture', exact: true }).waitFor();
    const rejectProcessSample = page.getByRole('button', {
        name: 'Reject process sample fixture',
        exact: true,
    });
    await rejectProcessSample.click();
    await processes.getByText('Process update failed', { exact: true }).waitFor();
    await processSort.getByText('Memory usage', { exact: true }).waitFor();
    await processes.getByText('Showing rows sorted by CPU usage.', { exact: true }).waitFor();
    await cpuSortedTable.getByRole('cell', { name: 'cpu-burner fixture', exact: true }).waitFor();

    await page
        .getByRole('button', { name: 'Hold next process sample fixture', exact: true })
        .click();
    await processSort.click();
    await page.getByRole('option', { name: 'CPU usage', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.pendingProcesses === '1');
    await processSummary.press('Enter');
    await processes.getByRole('table').waitFor({ state: 'detached' });
    await rejectProcessSample.click();
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
    assert.equal(
        await page.locator('body').getAttribute('data-unexpected-disconnect'),
        null,
        'A late detail error after closing cannot disconnect the host',
    );
    assert.equal(
        await processes.getByRole('alert').count(),
        0,
        'A closed panel does not publish obsolete detail errors',
    );
    assert.deepEqual(errors, []);
    console.log(
        'Expanded dashboard metrics, shared on-demand details, cached sort, safe tables, visibility and collapse checks passed.',
    );
} finally {
    await browser?.close();
    await server?.close();
}
