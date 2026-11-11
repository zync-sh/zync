import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import type { Browser, WebSocketRoute } from 'playwright-core';
import { createServer } from 'vite';

const greeting = Buffer.from('RFB 003.008\n', 'ascii');
const screenName = Buffer.from('Zync RFB fixture', 'ascii');
const pixel = [28, 90, 170, 255];
const passwordChallenge = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const fixturePassword = 'zyncpass';
// The RFB DES response for this challenge and the bit-reversed fixture password key.
const passwordResponse = Buffer.from('80e8c0a9d42904a7bc348b1be27369e8', 'hex');

interface DesktopSize {
    width: number;
    height: number;
}

interface PointerCoordinates {
    x: number;
    y: number;
}

/** RFB ServerInit for a 2×2 desktop using the viewer's RGBX pixel format. */
function serverInit(): Buffer {
    const message = Buffer.alloc(24 + screenName.length);
    message.writeUInt16BE(2, 0);
    message.writeUInt16BE(2, 2);
    message.set([32, 24, 0, 1], 4);
    message.writeUInt16BE(255, 8);
    message.writeUInt16BE(255, 10);
    message.writeUInt16BE(255, 12);
    message.set([0, 8, 16], 14);
    message.writeUInt32BE(screenName.length, 20);
    screenName.copy(message, 24);
    return message;
}

/** One uncompressed rectangle makes a decoder regression visible as a wrong canvas pixel. */
function framebufferUpdate(color = pixel): Buffer {
    const message = Buffer.alloc(16 + color.length * 4);
    message.writeUInt16BE(1, 2);
    message.writeUInt16BE(2, 8);
    message.writeUInt16BE(2, 10);
    for (let offset = 16; offset < message.length; offset += color.length) {
        message.set(color, offset);
    }
    return message;
}

/** Build a framebuffer update containing one desktop-size pseudo-rectangle. */
function desktopSize({ width, height }: DesktopSize, encoding = -223, payloadLength = 0): Buffer {
    const message = Buffer.alloc(16 + payloadLength);
    message.writeUInt16BE(1, 2);
    message.writeUInt16BE(width, 8);
    message.writeUInt16BE(height, 10);
    message.writeInt32BE(encoding, 12);
    return message;
}

/** Advertise the ExtendedDesktopSize encoding or acknowledge a client resize. */
function extendedDesktopSize(
    { width, height }: DesktopSize,
    clientRequested = false,
    status = 0,
): Buffer {
    const message = desktopSize({ width, height }, -308, 20);
    message.writeUInt16BE(Number(clientRequested), 4); // Reason for the resize.
    message.writeUInt16BE(status, 6);
    message[16] = 1; // One screen.
    message.writeUInt16BE(width, 28);
    message.writeUInt16BE(height, 30);
    return message;
}

/** Exercise the library's version negotiation, RFB security, pixels and input handling. */
function serveRfb(
    socket: WebSocketRoute,
    errors: unknown[],
    input: { keyEvents: number[]; onPointerDown: (position: PointerCoordinates) => void },
    onResize?: (size: DesktopSize) => void,
    framebufferRequests?: number[],
    onAuthenticate?: () => void,
) {
    const securityType = onAuthenticate ? 2 : 1;
    let phase: 'version' | 'security' | 'challenge' | 'init' | 'request' | 'streaming' = 'version';
    socket.onMessage((message) => {
        try {
            assert.ok(Buffer.isBuffer(message), 'RFB uses binary frames');
            switch (phase) {
                case 'version':
                    assert.deepEqual(message, greeting);
                    phase = 'security';
                    socket.send(Buffer.from([1, securityType]));
                    break;
                case 'security':
                    assert.deepEqual(message, Buffer.from([securityType]));
                    if (onAuthenticate) {
                        phase = 'challenge';
                        socket.send(passwordChallenge);
                        break;
                    }
                    phase = 'init';
                    socket.send(Buffer.alloc(4)); // Successful SecurityResult.
                    break;
                case 'challenge':
                    assert.deepEqual(message, passwordResponse);
                    onAuthenticate?.();
                    phase = 'init';
                    socket.send(Buffer.alloc(4)); // Successful SecurityResult.
                    break;
                case 'init':
                    assert.deepEqual(
                        message,
                        Buffer.from([1]),
                        'ClientInit requests a shared session',
                    );
                    phase = 'request';
                    socket.send(serverInit());
                    break;
                case 'request':
                    if (message[0] === 3) {
                        framebufferRequests?.push(message[1]);
                        phase = 'streaming';
                        socket.send(framebufferUpdate());
                    }
                    break;
                case 'streaming':
                    if (message[0] === 3) {
                        framebufferRequests?.push(message[1]);
                    }
                    if (message[0] === 4 && message[1] === 1) {
                        input.keyEvents.push(message.readUInt32BE(4));
                    }
                    if (message[0] === 5 && message[1] === 1) {
                        input.onPointerDown({
                            x: message.readUInt16BE(2),
                            y: message.readUInt16BE(4),
                        });
                    }
                    if (message[0] === 251) {
                        assert.ok(onResize, 'The server must advertise resize support first');
                        onResize({
                            width: message.readUInt16BE(2),
                            height: message.readUInt16BE(4),
                        });
                    }
                    break;
            }
        } catch (error) {
            errors.push(error);
        }
    });
    socket.send(greeting);
}

const { chromium } = (await import(
    process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright-core'
)) as typeof import('playwright-core');
const server = process.env.ZYNC_BROWSER_BASE_URL
    ? undefined
    : await createServer({
          root: process.cwd(),
          configFile: false,
          plugins: [react()],
          cacheDir: path.resolve('node_modules/.vite-vnc-tests'),
          server: {
              host: '127.0.0.1',
              port: 0,
              watch: { ignored: ['**/src-tauri/**', '**/.tmp-agent-tests/**'] },
          },
          optimizeDeps: {
              entries: ['tests/vnc/vncViewer.browser.html'],
              exclude: ['@enjoys/context-engine', '@novnc/novnc'],
              include: ['cmdk'],
          },
      });
let browser: Browser | undefined;
try {
    await server?.listen();
    const address = server?.httpServer?.address();
    assert.ok(process.env.ZYNC_BROWSER_BASE_URL || (address && typeof address !== 'string'));
    const baseUrl =
        process.env.ZYNC_BROWSER_BASE_URL ||
        `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    browser = await chromium.launch({
        channel: process.env.ZYNC_BROWSER_CHANNEL || 'msedge',
        headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    const errors: unknown[] = [];
    const browserErrors: string[] = [];
    const keyEvents: number[] = [];
    const socketAttempts: string[] = [];
    const resizeRequests: DesktopSize[] = [];
    const directResizeRequests: DesktopSize[] = [];
    const directFramebufferRequests: number[] = [];
    const authenticatedAttempts: string[] = [];
    const unknownCloseReason = 'untrusted fixture failure text';
    let directSocket: WebSocketRoute | undefined;
    let directMode = false;
    let directOutcome: 'connected' | 'refused' | 'unknown' | 'password' | 'vault-rejected' =
        'connected';
    let directResizeStatus = 0;
    let onPointerDown: ((position: PointerCoordinates) => void) | undefined;
    let resizable = false;
    let resizeSocket: WebSocketRoute | undefined;
    let rejectResize = false;
    page.on('pageerror', (error) => errors.push(error));
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
            browserErrors.push(message.text());
        }
    });
    await page.routeWebSocket(
        (url) => url.pathname.startsWith('/vnc-fixture/'),
        async (socket) => {
            const attemptId = new URL(socket.url()).pathname.split('/').at(-1)!;
            socketAttempts.push(attemptId);
            if (directMode) {
                directSocket = socket;
                if (directOutcome === 'vault-rejected') {
                    await socket.close({ code: 1011, reason: 'vnc-vault-auth-rejected' });
                    return;
                }
                if (directOutcome === 'refused' || directOutcome === 'unknown') {
                    await socket.close({
                        code: 1011,
                        reason:
                            directOutcome === 'refused'
                                ? 'vnc-endpoint-refused'
                                : unknownCloseReason,
                    });
                    return;
                }
            }
            if (resizable) {
                resizeSocket = socket;
            }
            const sessionResizeRequests = directMode ? directResizeRequests : resizeRequests;
            serveRfb(
                socket,
                errors,
                { keyEvents, onPointerDown: (position) => onPointerDown?.(position) },
                resizable || directMode
                    ? (size) => {
                          sessionResizeRequests.push(size);
                          socket.send(
                              extendedDesktopSize(
                                  size,
                                  true,
                                  directMode ? directResizeStatus : Number(rejectResize),
                              ),
                          );
                      }
                    : undefined,
                directMode ? directFramebufferRequests : undefined,
                directMode && directOutcome === 'password'
                    ? () => authenticatedAttempts.push(attemptId)
                    : undefined,
            );
        },
    );
    await page.goto(`${baseUrl}/tests/vnc/vncViewer.browser.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
    });
    const open = page.getByRole('button', { name: 'Open VNC', exact: true });
    const port = page.getByLabel('Remote loopback port');
    const viewer = page.getByRole('region', { name: 'VNC viewer' });
    const canvas = viewer.locator('canvas');
    const cornerPixel = () =>
        canvas.evaluate((screen: HTMLCanvasElement) =>
            Array.from(screen.getContext('2d')!.getImageData(0, 0, 1, 1).data),
        );
    const waitForCornerPixel = (expected: number[]) =>
        page.waitForFunction((color) => {
            const context = document.querySelector('canvas')?.getContext('2d');
            return context
                ?.getImageData(0, 0, 1, 1)
                .data.every((byte, index) => byte === color[index]);
        }, expected);
    const primaryTab = page.getByRole('button', { name: 'VNC Viewer 1 tab', exact: true });
    const siblingTab = page.getByRole('button', { name: 'VNC Viewer 2 tab', exact: true });
    const menu = page.getByRole('menu');
    const resize = menu.getByRole('menuitemcheckbox', { name: 'Auto-resize', exact: true });
    const disconnect = menu.getByRole('menuitem', { name: 'Disconnect', exact: true });
    const started = async (): Promise<
        {
            sessionId: string;
            connectionId?: string;
            host?: string;
            port: number;
            profileId?: string;
            useVault?: boolean;
        }[]
    > => JSON.parse((await page.locator('body').getAttribute('data-vnc-starts')) || '[]');
    const stopped = async (): Promise<string[]> =>
        JSON.parse((await page.locator('body').getAttribute('data-vnc-stops')) || '[]');

    await port.fill('5901');
    await open.click();
    await page.waitForFunction(() => Boolean(document.body.dataset.vncStarts));
    const [cancelled] = await started();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Release pending bridge', exact: true }).click();
    await page.waitForFunction(
        () =>
            JSON.parse(document.body.dataset.vncStops || '[]').length >= 2 ||
            JSON.parse(document.body.dataset.vncStarts || '[]').length > 1,
    );
    assert.deepEqual(await started(), [cancelled], 'Cancel must not resubmit the form');
    assert.deepEqual(
        await stopped(),
        [cancelled.sessionId, cancelled.sessionId],
        'Cancel closes both the pending offer and its late native result',
    );
    assert.deepEqual(socketAttempts, [], 'A late native result cannot open the cancelled viewer');

    await port.fill('5900');
    await open.click();
    try {
        await viewer.getByText('Connected', { exact: true }).waitFor();
    } catch (cause) {
        throw new Error(
            `RFB did not connect. Attempts: ${JSON.stringify(socketAttempts)}. Errors: ${[...errors, ...browserErrors].join(' | ')}. Pane: ${await page.locator('body').innerText()}`,
            { cause },
        );
    }
    const [, active] = await started();
    assert.equal(active.port, 5900);
    assert.equal(active.connectionId, 'vnc-test-host');
    assert.notEqual(active.sessionId, cancelled.sessionId);
    assert.deepEqual(socketAttempts, [active.sessionId]);

    assert.equal(await port.count(), 0, 'The connection form collapses while viewing the desktop');
    assert.equal(
        await viewer.getByRole('button', { name: /^(Auto-resize|Disconnect)$/ }).count(),
        0,
        'Connected actions do not cover the remote desktop',
    );
    await canvas.waitFor();
    await waitForCornerPixel(pixel);
    await canvas.click();
    await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
    assert.equal(await canvas.getAttribute('width'), '2', 'Fixed desktops keep their resolution');

    await siblingTab.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Open with connection', exact: true }).waitFor();
    assert.equal(await disconnect.count(), 0, 'A sibling VNC tab cannot disconnect this viewer');
    assert.equal(await resize.count(), 0, 'A sibling VNC tab cannot resize this viewer');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await primaryTab.focus();
    await page.keyboard.press('Shift+F10');
    await disconnect.click();
    await open.waitFor();
    assert.equal(await port.inputValue(), '5900');
    assert.ok(keyEvents.includes(0x6e), 'The remote canvas owns Ctrl+N while focused');
    assert.equal((await stopped()).at(-1), active.sessionId);
    await primaryTab.click({ button: 'right' });
    await menu.waitFor();
    assert.equal(await disconnect.count(), 0, 'Disconnect retires this tab’s live session actions');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });

    resizable = true;
    await open.click();
    await waitForCornerPixel(pixel);
    assert.ok(resizeSocket);
    resizeSocket.send(extendedDesktopSize({ width: 2, height: 2 }));
    const fittedPixel = [40, 100, 160, 255];
    resizeSocket.send(framebufferUpdate(fittedPixel));
    await waitForCornerPixel(fittedPixel);
    assert.deepEqual(resizeRequests, [], 'An SSH viewer fits the server resolution on open');
    assert.equal(await canvas.getAttribute('width'), '2');

    await primaryTab.click({ button: 'right' });
    await resize.waitFor();
    assert.equal(await resize.getAttribute('aria-checked'), 'false');
    await resize.click();
    // The resize acknowledgement itself carries no pixels.
    await page.waitForFunction(() => {
        const screen = document.querySelector('canvas');
        return screen?.width === 640 && screen.height === 480;
    });
    assert.deepEqual(
        await cornerPixel(),
        [0, 0, 0, 0],
        'A resize must not display old desktop pixels',
    );
    const resizedPixel = [170, 90, 28, 255];
    resizeSocket.send(framebufferUpdate(resizedPixel));
    await waitForCornerPixel(resizedPixel);
    const workspace = page.locator('#vnc-fixture-workspace');
    await workspace.evaluate((element) => {
        element.style.width = '480px';
    });
    await page.waitForFunction(() => document.querySelector('canvas')?.width === 480);
    assert.deepEqual(resizeRequests, [
        { width: 640, height: 480 },
        { width: 480, height: 480 },
    ]);
    assert.deepEqual(await cornerPixel(), [0, 0, 0, 0], 'Shrinking also clears the old desktop');

    resizeSocket.send(framebufferUpdate(resizedPixel));
    await waitForCornerPixel(resizedPixel);
    const rejection = page.waitForEvent('console', {
        predicate: (message) => message.text().includes('Server did not accept the resize request'),
    });
    rejectResize = true;
    resizeSocket.send(extendedDesktopSize({ width: 480, height: 480 }));
    await workspace.evaluate((element) => {
        element.style.width = '400px';
    });
    await rejection;
    await viewer
        .getByText(
            'The VNC server rejected the requested resolution. Fitting the current desktop to the pane.',
        )
        .waitFor();
    assert.equal(
        await canvas.getAttribute('width'),
        '480',
        'A rejected resize keeps the framebuffer size',
    );
    assert.deepEqual(
        await cornerPixel(),
        resizedPixel,
        'Same-size announcements and rejected resizes keep the current pixels',
    );

    await primaryTab.click({ button: 'right' });
    await resize.waitFor();
    assert.equal(await resize.getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');
    const rejectedRequestCount = resizeRequests.length;
    await workspace.evaluate((element) => {
        element.style.width = '360px';
    });
    await page.waitForFunction(() => document.querySelector('canvas')?.clientWidth === 360);
    assert.equal(
        await canvas.getAttribute('width'),
        '480',
        'A rejected resize falls back to local fit',
    );
    assert.equal(
        resizeRequests.length,
        rejectedRequestCount,
        'Pane resizes do not retry a rejected request',
    );
    resizeSocket.send(desktopSize({ width: 320, height: 320 }));
    await page.waitForFunction(() => document.querySelector('canvas')?.width === 320);
    assert.deepEqual(await cornerPixel(), resizedPixel, 'Legacy DesktopSize keeps current pixels');
    await primaryTab.click({ button: 'right' });
    await resize.waitFor();
    assert.equal(await resize.getAttribute('aria-checked'), 'false');
    await disconnect.click();

    resizable = false;
    directMode = true;
    await page.goto(`${baseUrl}/tests/vnc/vncViewer.browser.html?direct`);
    const savedProfile = page.getByRole('button', { name: 'Open saved VNC' });
    await savedProfile.click();
    await viewer.getByRole('heading', { name: 'Connect to VNC', exact: true }).waitFor();
    await savedProfile.click();
    const directTab = page.getByRole('tab', { name: 'Direct VNC fixture' });
    const directMenu = page.getByRole('menu', { name: 'Workspace tab actions' });
    const editProfile = page.getByRole('dialog', { name: 'Edit VNC profile', exact: true });
    /** Exercise the saved display settings action and leave the profile as it was. */
    const checkDisplaySettings = async () => {
        await directTab.click({ button: 'right' });
        await directMenu.getByRole('menuitem', { name: 'Display settings…', exact: true }).click();
        await editProfile.waitFor();
        assert.equal(
            await editProfile.getByLabel('Profile name').inputValue(),
            'Direct VNC fixture',
        );
        const resolution = editProfile.getByLabel('Remote resolution');
        assert.equal(await resolution.innerText(), 'Keep server resolution');
        assert.equal(await editProfile.getByLabel('Viewer scale').innerText(), 'Fit to pane');
        const resolutionId = await resolution.getAttribute('id');
        assert.ok(resolutionId);
        await page.waitForFunction((id) => document.activeElement?.id === id, resolutionId);
        await editProfile.getByRole('button', { name: 'Cancel', exact: true }).click();
        await editProfile.waitFor({ state: 'hidden' });
    };
    assert.equal(await directTab.count(), 1, 'A saved profile owns one workspace tab');
    await checkDisplaySettings();
    assert.deepEqual(await started(), [], 'Opening a profile does not initiate network traffic');
    assert.equal(await port.count(), 0, 'Direct VNC uses the saved port');
    await open.click();
    await viewer.getByText('Connected', { exact: true }).waitFor();
    const [direct] = await started();
    assert.deepEqual(direct, { sessionId: direct.sessionId, host: 'vnc.fixture.test', port: 5999 });
    await checkDisplaySettings();
    assert.deepEqual(
        await started(),
        [direct],
        'Opening display settings keeps the existing bridge',
    );
    assert.deepEqual(
        await stopped(),
        [],
        'Opening display settings does not disconnect the viewer',
    );
    await page.getByRole('button', { name: 'Hide viewer' }).click();
    assert.ok(directSocket);
    const lastInFlightPixel = [40, 120, 200, 255];
    directSocket.send(framebufferUpdate(lastInFlightPixel));
    await page.waitForFunction((expected) => {
        const context = document.querySelector('canvas')?.getContext('2d');
        return context
            ?.getImageData(0, 0, 1, 1)
            .data.every((byte, index) => byte === expected[index]);
    }, lastInFlightPixel);
    await page.getByRole('button', { name: 'Show viewer' }).click();
    await directTab.click({ button: 'right' });
    assert.deepEqual(
        directFramebufferRequests,
        [0, 1, 0],
        'A hidden pane drains the in-flight frame and resumes with a full refresh',
    );
    assert.equal((await started()).length, 1, 'Returning to the pane keeps the bridge');
    const directResize = directMenu.getByRole('menuitemcheckbox', {
        name: 'Auto-resize',
        exact: true,
    });
    const verifyDirectLocalScaling = async (width: number) => {
        assert.ok(directSocket);
        const previousRequests = directResizeRequests.length;
        directSocket.send(
            Buffer.concat([
                extendedDesktopSize({ width: 2, height: 2 }),
                framebufferUpdate(resizedPixel),
            ]),
        );
        // The distinct pixel confirms noVNC has processed the preceding resize capability.
        await waitForCornerPixel(resizedPixel);
        await workspace.evaluate((element, paneWidth) => {
            element.style.width = `${paneWidth}px`;
        }, width);
        await page.waitForFunction(
            (paneWidth) => document.querySelector('canvas')?.clientWidth === paneWidth,
            width,
        );
        directSocket.send(framebufferUpdate(pixel));
        await waitForCornerPixel(pixel);
        assert.equal(await canvas.getAttribute('width'), '2', 'Saved profile scales locally');
        assert.equal(
            directResizeRequests.length,
            previousRequests,
            'Saved profile sends no resize request',
        );
    };
    assert.equal(await directResize.getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');
    await verifyDirectLocalScaling(400);
    await directTab.click({ button: 'right' });
    await directResize.click();
    await page.waitForFunction(() => document.querySelector('canvas')?.width === 400);
    assert.deepEqual(directResizeRequests, [{ width: 400, height: 480 }]);
    await directTab.click({ button: 'right' });
    await directMenu.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    await open.waitFor();
    assert.equal((await stopped()).at(-1), direct.sessionId);
    await open.click();
    await viewer.getByText('Connected', { exact: true }).waitFor();
    const [, replacement] = await started();
    await verifyDirectLocalScaling(360);
    await directTab.click({ button: 'right' });
    assert.equal(await directResize.getAttribute('aria-checked'), 'false');
    await directMenu.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
    await directTab.waitFor({ state: 'detached' });
    await page.waitForFunction(
        (id) => JSON.parse(document.body.dataset.vncStops || '[]').at(-1) === id,
        replacement.sessionId,
    );
    assert.equal((await stopped()).at(-1), replacement.sessionId);

    await page.getByRole('button', { name: 'Restore saved VNC' }).click();
    await directTab.waitFor();
    assert.equal(
        await page.getByRole('tab').count(),
        1,
        'Restore skips deleted and duplicate VNC profiles',
    );
    assert.equal((await started()).length, 2, 'Restoring the tab keeps the network idle');
    await open.waitFor();

    directOutcome = 'refused';
    await open.click();
    await viewer
        .getByText(
            'Connection refused at vnc.fixture.test:5999. Make sure the VNC server is running.',
            { exact: true },
        )
        .waitFor();
    const refusal = (await started()).at(-1)!;
    assert.equal((await stopped()).at(-1), refusal.sessionId);

    directOutcome = 'unknown';
    await open.click();
    const unknownFailure = viewer.getByRole('alert');
    await unknownFailure.waitFor();
    assert.ok(!(await unknownFailure.innerText()).includes(unknownCloseReason));

    directOutcome = 'password';
    const authentication = page.getByRole('dialog', { name: 'VNC authentication', exact: true });
    const password = authentication.getByLabel('VNC password', { exact: true });
    await open.click();
    await authentication.waitFor();
    assert.equal(await password.getAttribute('type'), 'password');
    await password.fill(fixturePassword);
    const cancelledAuthentication = (await started()).at(-1)!;
    await authentication.getByRole('button', { name: 'Cancel', exact: true }).click();
    await authentication.waitFor({ state: 'hidden' });
    await open.waitFor();
    assert.equal((await stopped()).at(-1), cancelledAuthentication.sessionId);
    assert.equal(await viewer.getByRole('alert').count(), 0, 'Manual cancellation is not an error');
    assert.deepEqual(authenticatedAttempts, [], 'Cancelling must never send an RFB response');

    await open.click();
    await authentication.waitFor();
    assert.equal(await password.inputValue(), '', 'The cancelled password is cleared on retry');
    await password.fill(fixturePassword);
    const acceptedAuthentication = (await started()).at(-1)!;
    await authentication.getByRole('button', { name: 'Continue', exact: true }).click();
    await authentication.waitFor({ state: 'hidden' });
    await viewer.getByText('Connected', { exact: true }).waitFor();
    assert.deepEqual(authenticatedAttempts, [acceptedAuthentication.sessionId]);
    assert.ok(directSocket);
    await directSocket.close({ code: 1000 });
    await viewer.getByText('The VNC connection closed unexpectedly.', { exact: true }).waitFor();
    await open.waitFor();
    assert.equal((await stopped()).at(-1), acceptedAuthentication.sessionId);

    directOutcome = 'connected';
    await page.goto(`${baseUrl}/tests/vnc/vncViewer.browser.html?direct&vault&locked`);
    const connectSavedProfile = page.getByRole('button', {
        name: 'Connect saved VNC',
        exact: true,
    });
    const unlockVault = page.getByRole('dialog', { name: 'Unlock Vault', exact: true });
    const socketsBeforeUnlock = socketAttempts.length;
    await connectSavedProfile.click();
    await unlockVault.waitFor();
    assert.deepEqual(await started(), [], 'Vault unlock precedes bridge admission');
    await unlockVault.getByRole('button', { name: 'Cancel', exact: true }).click();
    await unlockVault.waitFor({ state: 'hidden' });
    await open.waitFor();
    assert.deepEqual(await started(), [], 'Cancelling Vault unlock must not start a bridge');
    assert.equal(socketAttempts.length, socketsBeforeUnlock, 'Unlock cancellation opens no socket');
    assert.equal(
        await authentication.count(),
        0,
        'Unlock cancellation shows no VNC password prompt',
    );
    assert.equal(await viewer.getByRole('alert').count(), 0, 'Unlock cancellation is not an error');

    await connectSavedProfile.click();
    await unlockVault.waitFor();
    await unlockVault.getByLabel('Passphrase', { exact: true }).fill('fixture vault passphrase');
    await unlockVault.getByRole('button', { name: 'Unlock', exact: true }).click();
    await unlockVault.waitFor({ state: 'hidden' });
    await viewer.getByText('Connected', { exact: true }).waitFor();
    assert.equal((await started()).length, 1, 'A fresh attempt connects after successful unlock');
    assert.equal(
        (await started())[0].profileId,
        'vnc-fixture-direct',
        'Retry retains the Vault link',
    );
    assert.equal(await authentication.count(), 0, 'Unlocked saved credentials skip the VNC prompt');

    await page.goto(`${baseUrl}/tests/vnc/vncViewer.browser.html?direct&vault`);
    const socketAttemptsBeforeConnect = socketAttempts.length;
    await connectSavedProfile.dblclick();
    await viewer.getByText('Connected', { exact: true }).waitFor();
    await waitForCornerPixel(pixel);
    const vaultStarts = await started();
    assert.equal(vaultStarts.length, 1, 'Repeated connect requests start a new tab only once');
    const [vaultConnection] = vaultStarts;
    assert.deepEqual(vaultConnection, {
        sessionId: vaultConnection.sessionId,
        host: 'vnc.fixture.test',
        port: 5999,
        profileId: 'vnc-fixture-direct',
    });
    assert.equal(await authentication.count(), 0, 'A native-authenticated bridge skips the prompt');
    await connectSavedProfile.click();
    assert.equal(await directTab.count(), 1, 'Connecting again activates the same tab');
    await directTab.click({ button: 'right' });
    await directMenu.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    await open.waitFor();
    assert.deepEqual(
        await started(),
        vaultStarts,
        'Disconnect leaves the viewer idle after connect',
    );
    assert.deepEqual(socketAttempts.slice(socketAttemptsBeforeConnect), [
        vaultConnection.sessionId,
    ]);

    directOutcome = 'vault-rejected';
    await connectSavedProfile.click();
    await viewer.getByText('The VNC server rejected the saved Vault password.').waitFor();
    const rejectedVaultConnection = (await started()).at(-1)!;
    assert.equal(rejectedVaultConnection.profileId, 'vnc-fixture-direct');
    assert.equal((await stopped()).at(-1), rejectedVaultConnection.sessionId);
    assert.equal(
        await authentication.count(),
        0,
        'A rejected password waits for an explicit retry',
    );

    // Rotating a Vault password keeps its logical ID. A new saved connect must try it again.
    directOutcome = 'connected';
    await connectSavedProfile.click();
    await viewer.getByText('Connected', { exact: true }).waitFor();
    assert.equal(
        (await started()).at(-1)?.profileId,
        'vnc-fixture-direct',
        'An explicit saved connect uses Vault after the previous password was rejected',
    );
    await directTab.click({ button: 'right' });
    await directMenu.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    directOutcome = 'vault-rejected';
    await connectSavedProfile.click();
    await viewer.getByText('The VNC server rejected the saved Vault password.').waitFor();

    directOutcome = 'password';
    await viewer.getByRole('button', { name: 'Try password manually', exact: true }).click();
    await authentication.waitFor();
    assert.equal((await started()).at(-1)?.profileId, undefined, 'Manual retry skips Vault');
    await authentication.getByRole('button', { name: 'Cancel', exact: true }).click();
    await open.waitFor();
    directOutcome = 'connected';
    await open.click();
    await viewer.getByText('Connected', { exact: true }).waitFor();
    assert.equal(
        (await started()).at(-1)?.profileId,
        'vnc-fixture-direct',
        'Cancelling a manual retry restores the saved-password flow for the next attempt',
    );
    await directTab.click({ button: 'right' });
    await directMenu.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    directOutcome = 'vault-rejected';
    await connectSavedProfile.click();
    await viewer.getByText('The VNC server rejected the saved Vault password.').waitFor();
    directOutcome = 'password';
    await viewer.getByRole('button', { name: 'Try password manually', exact: true }).click();
    await authentication.waitFor();
    assert.equal((await started()).at(-1)?.profileId, undefined);
    await password.fill(fixturePassword);
    await authentication.getByRole('button', { name: 'Continue', exact: true }).click();
    await viewer.getByText('Connected', { exact: true }).waitFor();

    /** Start a fresh standalone profile and wait for its first server-rendered pixels. */
    const openDisplayProfile = async (settings: Record<string, string>) => {
        directOutcome = 'connected';
        const query = new URLSearchParams({ direct: '', ...settings });
        await page.goto(`${baseUrl}/tests/vnc/vncViewer.browser.html?${query}`);
        await savedProfile.click();
        await open.click();
        await viewer.getByText('Connected', { exact: true }).waitFor();
        await waitForCornerPixel(pixel);
        assert.ok(directSocket);
        return directSocket;
    };

    const originalDesktop = { width: 2, height: 2 };
    const fixedResolution = { width: 480, height: 320 };
    const fixedSettings = {
        width: String(fixedResolution.width),
        height: String(fixedResolution.height),
    };
    const fixedRequestStart = directResizeRequests.length;
    const fixedSocket = await openDisplayProfile(fixedSettings);
    assert.equal(directResizeRequests.length, fixedRequestStart, 'Wait for resize capability');
    fixedSocket.send(extendedDesktopSize(originalDesktop));
    await page.waitForFunction(({ width, height }) => {
        const screen = document.querySelector('canvas');
        return screen?.width === width && screen.height === height;
    }, fixedResolution);
    fixedSocket.send(framebufferUpdate(resizedPixel));
    await waitForCornerPixel(resizedPixel);
    await workspace.evaluate((element) => {
        element.style.width = '400px';
    });
    await page.waitForFunction(() => document.querySelector('canvas')?.clientWidth === 400);
    fixedSocket.send(framebufferUpdate(pixel));
    await waitForCornerPixel(pixel);
    assert.equal(await canvas.getAttribute('width'), String(fixedResolution.width));
    assert.deepEqual(directResizeRequests.slice(fixedRequestStart), [fixedResolution]);

    directResizeStatus = 3; // Invalid screen layout.
    const rejectedNotice = viewer.getByText(
        'The VNC server rejected the requested resolution. Fitting the current desktop to the pane.',
        { exact: true },
    );
    const rejectedRequestStart = directResizeRequests.length;
    const rejectedSocket = await openDisplayProfile({ ...fixedSettings, scale: '150' });
    rejectedSocket.send(extendedDesktopSize(originalDesktop));
    await rejectedNotice.waitFor();
    await page.waitForFunction(() => (document.querySelector('canvas')?.clientWidth ?? 0) > 100);
    assert.equal(await canvas.getAttribute('width'), String(originalDesktop.width));
    assert.deepEqual(directResizeRequests.slice(rejectedRequestStart), [fixedResolution]);
    await viewer.getByText('Connected', { exact: true }).waitFor();

    const unavailableRequestStart = directResizeRequests.length;
    await openDisplayProfile({ ...fixedSettings, scale: '150' });
    await viewer
        .getByText(
            'The VNC server could not apply the requested resolution. Fitting the current desktop to the pane.',
            { exact: true },
        )
        .waitFor();
    await page.waitForFunction(() => (document.querySelector('canvas')?.clientWidth ?? 0) > 100);
    assert.equal(await canvas.getAttribute('width'), String(originalDesktop.width));
    assert.equal(directResizeRequests.length, unavailableRequestStart);
    await viewer.getByText('Connected', { exact: true }).waitFor();

    const automaticRequestStart = directResizeRequests.length;
    const automaticSocket = await openDisplayProfile({ auto: '', scale: '150' });
    automaticSocket.send(extendedDesktopSize(originalDesktop));
    await rejectedNotice.waitFor();
    await directTab.click({ button: 'right' });
    assert.equal(await directResize.getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');
    await workspace.evaluate((element) => {
        element.style.width = '400px';
    });
    await page.waitForFunction(() => document.querySelector('canvas')?.clientWidth === 400);
    automaticSocket.send(framebufferUpdate(resizedPixel));
    await waitForCornerPixel(resizedPixel);
    assert.equal(await canvas.getAttribute('width'), String(originalDesktop.width));
    assert.equal(
        directResizeRequests.length,
        automaticRequestStart + 1,
        'A standalone Auto rejection stops later pane resizes from retrying',
    );

    const zoomRequestStart = directResizeRequests.length;
    const zoomSocket = await openDisplayProfile({ scale: '150' });
    zoomSocket.send(extendedDesktopSize({ width: 600, height: 400 }));
    await page.waitForFunction(() => {
        const screen = document.querySelector('canvas');
        return screen?.width === 600 && screen.clientWidth === 900 && screen.clientHeight === 600;
    });
    const scrolled = await canvas.evaluate((screen) => {
        const viewport = screen.parentElement!;
        viewport.scrollLeft = 100;
        viewport.scrollTop = 80;
        const { left, top } = screen.getBoundingClientRect();
        return {
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop,
            x: left + 300,
            y: top + 240,
        };
    });
    assert.equal(scrolled.scrollLeft, 100, 'A zoomed desktop can scroll horizontally');
    assert.equal(scrolled.scrollTop, 80, 'A zoomed desktop can scroll vertically');
    const pointerDown = new Promise<PointerCoordinates>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No RFB pointer press received')), 5_000);
        onPointerDown = (position) => {
            clearTimeout(timeout);
            onPointerDown = undefined;
            resolve(position);
        };
    });
    const [position] = await Promise.all([pointerDown, page.mouse.click(scrolled.x, scrolled.y)]);
    assert.deepEqual(position, { x: 200, y: 160 }, '150% zoom maps input after scrolling');
    assert.equal(
        directResizeRequests.length,
        zoomRequestStart,
        'Zoom sends no remote size request',
    );

    directOutcome = 'connected';
    await page.goto(`${baseUrl}/tests/vnc/vncViewer.browser.html?direct&via-ssh&vault`);
    await connectSavedProfile.click();
    await viewer.getByText('Connected', { exact: true }).waitFor();
    const [sshStart] = await started();
    assert.deepEqual(sshStart, {
        sessionId: sshStart.sessionId,
        connectionId: 'vnc-test-host',
        port: 5999,
        profileId: 'vnc-fixture-direct',
        useVault: true,
    });
    assert.deepEqual(
        JSON.parse((await page.locator('body').getAttribute('data-vnc-ssh-connect'))!),
        {
            id: 'vnc-test-host',
            preserveWorkspace: true,
            scoped: true,
        },
    );
    assert.equal(await viewer.getByText(/with or without a password/).count(), 0);

    directOutcome = 'vault-rejected';
    await directTab.click({ button: 'right' });
    await directMenu.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    await open.waitFor();
    await open.click();
    await viewer.getByText('The VNC server rejected the saved Vault password.').waitFor();
    assert.equal((await started()).at(-1)?.useVault, true);
    directOutcome = 'password';
    await viewer.getByRole('button', { name: 'Try password manually' }).click();
    await authentication.waitFor();
    const manual = (await started()).at(-1);
    assert.equal(manual?.connectionId, 'vnc-test-host');
    assert.equal(manual?.profileId, 'vnc-fixture-direct');
    assert.equal(manual?.useVault, false);

    await page.goto(`${baseUrl}/tests/vnc/vncViewer.browser.html?direct&via-ssh&changed-ssh`);
    await connectSavedProfile.click();
    await viewer.getByText(/SSH host changed or is unavailable/).waitFor();
    assert.equal(await open.isDisabled(), true);
    assert.deepEqual(await started(), []);
    assert.equal(await page.locator('body').getAttribute('data-vnc-ssh-connect'), null);

    for (const queued of ['', '&queued-ssh']) {
        await page.goto(
            `${baseUrl}/tests/vnc/vncViewer.browser.html?direct&via-ssh&hold-ssh${queued}`,
        );
        await connectSavedProfile.click();
        await page.waitForFunction(() => Boolean(document.body.dataset.vncSshConnect));
        await viewer.getByRole('button', { name: 'Cancel', exact: true }).click();
        await open.waitFor();
        assert.equal(
            await page.locator('body').getAttribute('data-vnc-ssh-cancel'),
            'vnc-test-host',
        );
        assert.deepEqual(await started(), []);
    }

    assert.deepEqual(errors, []);
    console.log('VNC browser checks passed.');
} finally {
    await browser?.close();
    await server?.close();
}
