import assert from 'node:assert/strict';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import type { Browser } from 'playwright-core';
import { createServer } from 'vite';

const { chromium } = (await import(
    process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright-core'
)) as typeof import('playwright-core');
const server = await createServer({
    configFile: false,
    plugins: [
        {
            name: 'conversation-render-probe',
            enforce: 'pre',
            transform(code, id) {
                if (
                    !id.replaceAll('\\', '/').endsWith('/src/components/ai/ConversationThread.tsx')
                ) {
                    return;
                }
                const marker = 'const deferredText = useDeferredValue(text);';
                assert.ok(code.includes(marker));
                return code.replace(
                    marker,
                    `globalThis.conversationMarkdownRenders ??= 0; globalThis.conversationMarkdownRenders++; ${marker}`,
                );
            },
        },
        react(),
    ],
    cacheDir: path.resolve('node_modules/.vite-conversation-performance-tests'),
    server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/.tmp*/**'] } },
    optimizeDeps: {
        entries: ['tests/ai/conversationPerformance.browser.html'],
        exclude: ['@enjoys/context-engine'],
    },
});
let browser: Browser | undefined;
try {
    await server.listen();
    browser = await chromium.launch({
        channel: process.env.ZYNC_BROWSER_CHANNEL || 'msedge',
        headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    page.setDefaultTimeout(60000);
    await page.addInitScript(() => {
        Object.assign(window, {
            ipcRenderer: { invoke: async () => undefined, on: () => () => {}, off() {}, send() {} },
        });
    });
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)
            ? route.continue()
            : route.abort();
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => {
        errors.push(error.message);
        console.error('Conversation fixture:', error.message);
    });
    page.on('requestfailed', (request) =>
        console.error('Conversation fixture request:', request.url(), request.failure()),
    );
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    await page.goto(
        `http://127.0.0.1:${address.port}/tests/ai/conversationPerformance.browser.html`,
        { waitUntil: 'domcontentloaded' },
    );
    await page.getByText('First fragment', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-agent-message-id]').count(), 100);
    const renders = await page.evaluate(
        () =>
            (globalThis as unknown as { conversationMarkdownRenders: number })
                .conversationMarkdownRenders,
    );
    await page.evaluate(() =>
        (
            window as unknown as { conversationFixture: { append(): void } }
        ).conversationFixture.append(),
    );
    await page.getByText('First fragment and final fragment', { exact: true }).waitFor();
    assert.equal(
        await page.evaluate(
            () =>
                (globalThis as unknown as { conversationMarkdownRenders: number })
                    .conversationMarkdownRenders,
        ),
        renders,
        'streaming one tool must not reparse unchanged Markdown rows',
    );
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await page.getByText('Fixture message 0', { exact: true }).waitFor();
    await page.locator('[data-agent-message-id="fixture-5"]').getByRole('button').click();
    await page.getByText('Complete historical output', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    await page.getByText('First fragment and final fragment', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await page.getByText('Complete historical output', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-agent-message-id]').count(), 100);
    assert.equal(
        await page.evaluate(() =>
            (
                window as unknown as { conversationFixture: { count(): number } }
            ).conversationFixture.count(),
        ),
        205,
    );

    await page.evaluate(() =>
        (
            window as unknown as { conversationFixture: { finishRun(): void } }
        ).conversationFixture.finishRun(),
    );
    await page.getByRole('navigation', { name: 'Conversation pages' }).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-agent-message-id]').count(), 100);
    const finished = await page.getByText('Finished fixture run', { exact: true }).elementHandle();
    await page.waitForFunction(
        (element) => {
            const { top, bottom } = element.getBoundingClientRect();
            return top >= 0 && bottom <= window.innerHeight;
        },
        finished,
        { timeout: 5000 },
    );
    assert.deepEqual(errors, []);
    console.log(
        'PASS bounded pages, full output access, expansion retention, stable Markdown, and resumed auto-scroll',
    );
} finally {
    await browser?.close();
    await server.close();
}
