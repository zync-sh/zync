import assert from 'node:assert/strict';

import react from '@vitejs/plugin-react';
import type { Browser, Locator, Page } from 'playwright-core';
import { createServer } from 'vite';

import type { VncFixtureWrite } from './connectionForm.browser';

const { chromium } = (await import(
    process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright-core'
)) as typeof import('playwright-core');
const fixture = '/tests/connections/connectionForm.browser.html';
const externalServer = process.env.ZYNC_BROWSER_BASE_URL;
const server = externalServer
    ? undefined
    : await createServer({
          configFile: false,
          plugins: [react()],
          cacheDir: 'node_modules/.vite-connection-form-tests',
          server: {
              host: '127.0.0.1',
              port: 0,
              watch: null,
          },
          optimizeDeps: { entries: [fixture.slice(1)], exclude: ['@enjoys/context-engine'] },
      });

/** Wait for the mocked native request before replying, regardless of rendering or preflight timing. */
async function finishNextConnectionTest(page: Page, action: 'Finish test' | 'Reject test') {
    await page.waitForFunction(() => Number(document.body.dataset.pendingSshTests) > 0);
    await page
        .getByRole('button', { name: action, exact: true })
        .evaluate((button: HTMLElement) => button.click());
}

/** Flush queued ancestor scroll events before focus; Radix dismisses help on scrolling. */
async function focusHelp(button: Locator) {
    await button.scrollIntoViewIfNeeded();
    await button.evaluate(
        (element: HTMLElement) =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        element.focus({ preventScroll: true });
                        resolve();
                    });
                });
            }),
    );
}

/** Keep connection types distinct from imports and usable by keyboard in a bounded dialog. */
async function checkConnectionChooser(page: Page, dialog: Locator, screenshots?: string) {
    const connectionTypes = dialog.getByRole('group', { name: 'Connection type', exact: true });
    const imports = dialog.getByRole('group', { name: 'Import connections', exact: true });
    await connectionTypes.waitFor();
    await imports.waitFor();
    assert.equal(await connectionTypes.getByRole('button').count(), 3);
    assert.equal(await imports.getByRole('button').count(), 2);
    assert.equal(await connectionTypes.getByRole('button', { name: /^Import/ }).count(), 0);
    assert.equal(
        await imports.getByRole('button', { name: /^(?:SSH|VNC|Serial) connection/ }).count(),
        0,
    );
    const choices = [
        connectionTypes.getByRole('button', { name: /^SSH connection/ }),
        connectionTypes.getByRole('button', { name: /^VNC connection/ }),
        connectionTypes.getByRole('button', { name: /^Serial connection/ }),
        imports.getByRole('button', { name: /^Import SSH config/ }),
        imports.getByRole('button', { name: /^Import file/ }),
    ];
    await choices[0].focus();
    for (const choice of choices.slice(1)) {
        await page.keyboard.press('Tab');
        assert.equal(await choice.evaluate((element) => element === document.activeElement), true);
    }
    if (screenshots) {
        await choices[0].focus();
        await dialog.screenshot({
            path: `${screenshots}/connection-chooser-dark.png`,
            animations: 'disabled',
        });
    }
    for (const scenario of [
        { viewport: { width: 390, height: 700 }, theme: 'light' },
        { viewport: { width: 520, height: 350 }, theme: 'dark' },
    ]) {
        const { viewport, theme } = scenario;
        await page.evaluate((value) => {
            document.body.dataset.overlayGalleryTheme = value;
        }, theme);
        await page.setViewportSize(viewport);
        for (const choice of choices) {
            await choice.scrollIntoViewIfNeeded();
            const reachable = await choice.evaluate((element) => {
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
            });
            assert.equal(reachable, true, 'Every chooser action remains reachable after scrolling');
        }
        const bounds = await dialog.evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
        }));
        assert.ok(bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
        if (screenshots) {
            await choices[0].scrollIntoViewIfNeeded();
            await dialog.screenshot({
                path: `${screenshots}/connection-chooser-${viewport.width}x${viewport.height}.png`,
                animations: 'disabled',
            });
        }
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await choices[2].focus();
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
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.addInitScript((platform: string) => {
        Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
    }, process.env.ZYNC_BROWSER_PLATFORM || 'Linux x86_64');
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${baseUrl}${fixture}`, { waitUntil: 'domcontentloaded' });
    const screenshots = process.env.ZYNC_BROWSER_SCREENSHOT_DIR;
    const dialog = page.getByRole('dialog', { name: /^Add (?:connection|host)$/ });
    await dialog.waitFor().catch((cause: unknown) => {
        if (errors.length > 0) {
            throw new Error(errors.join('\n'), { cause });
        }
        throw cause;
    });
    await dialog.getByRole('button', { name: /^SSH connection/ }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /^Import SSH config/ }).count(), 1);
    assert.equal(await dialog.getByRole('button', { name: /^Import file/ }).count(), 1);
    assert.equal(
        await page.getByLabel('Host', { exact: true }).count(),
        0,
        'New hosts start at the entry selector',
    );

    await checkConnectionChooser(page, dialog, screenshots);

    await page.keyboard.press('Enter');
    const serialProfile = page.getByRole('dialog', { name: 'Add Serial profile', exact: true });
    await serialProfile.getByLabel('Profile name', { exact: true }).waitFor();
    await serialProfile.getByRole('button', { name: 'Back', exact: true }).click();
    await serialProfile.waitFor({ state: 'hidden' });
    await dialog.getByRole('button', { name: /^Serial connection/ }).waitFor();

    await dialog.getByRole('button', { name: /^VNC connection/ }).click();
    const vncProfile = page.getByRole('dialog', { name: 'Add VNC profile', exact: true });
    await vncProfile.getByRole('button', { name: 'Back', exact: true }).click();
    await vncProfile.waitFor({ state: 'hidden' });
    await dialog.getByRole('button', { name: /^VNC connection/ }).click();
    const vncRoute = vncProfile.getByLabel('Connection route', { exact: true });
    assert.equal(await vncRoute.innerText(), 'Direct TLS');
    assert.equal(await vncProfile.getByLabel('VNC username', { exact: true }).isVisible(), true);
    await vncRoute.click();
    await page.getByRole('option', { name: 'Direct', exact: true }).click();
    const resolution = vncProfile.getByLabel('Remote resolution', { exact: true });
    const scale = vncProfile.getByLabel('Viewer scale', { exact: true });
    await resolution.waitFor();
    assert.equal(await resolution.innerText(), 'Keep server resolution');
    assert.equal(await scale.innerText(), 'Fit to pane');
    await resolution.click();
    await page.getByRole('option', { name: '1920 × 1080', exact: true }).click();
    assert.equal(await resolution.innerText(), '1920 × 1080');
    await resolution.click();
    await page.getByRole('option', { name: 'Custom resolution', exact: true }).click();
    await vncProfile.getByLabel('Width (pixels)').fill('1440');
    await vncProfile.getByLabel('Height (pixels)').fill('900');
    await scale.click();
    await page.getByRole('option', { name: '125%', exact: true }).click();
    await vncProfile.getByLabel('Profile name', { exact: true }).fill('Fixture desktop');
    await vncProfile
        .getByLabel('Host or IP address', { exact: true })
        .fill('desktop.fixture.invalid');
    await vncProfile.getByLabel('VNC authentication').click();
    await page.getByRole('option', { name: 'Saved Vault credential', exact: true }).click();
    await vncProfile.getByLabel('Vault credential').click();
    await page.getByRole('option', { name: 'Fixture VNC password', exact: true }).waitFor();
    assert.equal(
        await page.getByRole('option', { name: /Fixture private key|Fixture API token/ }).count(),
        0,
    );
    await page.getByRole('option', { name: 'Fixture SSH password', exact: true }).click();
    await vncProfile.getByRole('button', { name: 'Save profile', exact: true }).click();
    await vncProfile.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('body').getAttribute('data-vnc-open'), null);
    await page.getByRole('button', { name: 'Edit reloaded VNC profile', exact: true }).click();
    const editVnc = page.getByRole('dialog', { name: 'Edit VNC profile', exact: true });
    await editVnc.waitFor();
    assert.equal(await editVnc.getByRole('button', { name: 'Back', exact: true }).count(), 0);
    assert.equal(await editVnc.getByLabel('Connection route').innerText(), 'Direct');
    assert.equal(await editVnc.getByLabel('Remote resolution').innerText(), 'Custom resolution');
    assert.equal(await editVnc.getByLabel('Width (pixels)').inputValue(), '1440');
    assert.equal(await editVnc.getByLabel('Height (pixels)').inputValue(), '900');
    assert.equal(await editVnc.getByLabel('Viewer scale').innerText(), '125%');
    assert.equal(await editVnc.getByLabel('Vault credential').innerText(), 'Fixture SSH password');
    await editVnc.getByLabel('Host or IP address').fill('other.fixture.invalid');
    await editVnc.getByText('Choose a credential again for the new address.').waitFor();
    await editVnc.getByRole('button', { name: 'Save profile', exact: true }).click();
    await editVnc
        .getByRole('alert')
        .filter({ hasText: 'Select a Vault credential for the new address before saving.' })
        .waitFor();
    await editVnc.getByRole('button', { name: 'Cancel', exact: true }).click();
    await editVnc.waitFor({ state: 'hidden' });

    const readVncWrites = async (): Promise<VncFixtureWrite[]> =>
        JSON.parse((await page.locator('body').getAttribute('data-vnc-writes')) ?? '[]');
    const inlinePassword = ' vnc-fixture-secret-59 ';
    async function fillInlineVncDraft(host: string, name: string) {
        await page.getByRole('button', { name: 'New host fixture', exact: true }).click();
        await dialog.getByRole('button', { name: /^VNC connection/ }).click();
        await vncRoute.click();
        await page.getByRole('option', { name: 'Direct', exact: true }).click();
        await vncProfile.getByLabel('Profile name', { exact: true }).fill(name);
        await vncProfile.getByLabel('Host or IP address', { exact: true }).fill(host);
        await vncProfile.getByLabel('VNC authentication').click();
        await page.getByRole('option', { name: 'Save password to Vault', exact: true }).click();
        const input = vncProfile.getByLabel('Password', { exact: true });
        assert.equal(await input.getAttribute('type'), 'password');
        await input.fill(inlinePassword);
        await vncProfile.getByLabel('Name in Vault', { exact: true }).fill(name);
    }

    const beforeInline = await readVncWrites();
    await fillInlineVncDraft('cancel-inline.fixture.invalid', 'Cancelled inline password');
    await vncProfile.getByRole('button', { name: 'Cancel', exact: true }).click();
    await vncProfile.waitFor({ state: 'hidden' });
    assert.deepEqual(await readVncWrites(), beforeInline, 'Cancel leaves both stores untouched');

    const inlineHost = 'save-inline.fixture.invalid';
    const inlineLabel = 'Inline fixture password';
    await fillInlineVncDraft(inlineHost, inlineLabel);
    await vncProfile.getByRole('button', { name: 'Save profile', exact: true }).click();
    await vncProfile.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('body').getAttribute('data-vnc-open'), null);
    const savedInline = (await readVncWrites()).slice(beforeInline.length);
    assert.deepEqual(
        savedInline.map(({ type }) => type),
        ['create', 'save-profile'],
    );
    const [created, saved] = savedInline;
    assert.ok(created?.type === 'create' && saved?.type === 'save-profile');
    assert.equal(created.item.kind, 'ssh-password');
    assert.equal(created.item.label, inlineLabel);
    assert.deepEqual(created.secretValues, { password: inlinePassword });
    const linkedProfile = saved.profiles.find(({ host }) => host === inlineHost);
    assert.ok(linkedProfile);
    assert.equal(linkedProfile.credentialId, created.item.logicalId);
    assert.equal('password' in linkedProfile, false);
    assert.equal(JSON.stringify(linkedProfile).includes(inlinePassword.trim()), false);

    await page.getByRole('button', { name: 'New host fixture', exact: true }).click();
    await dialog.getByRole('button', { name: /^VNC connection/ }).click();
    await vncProfile.getByLabel('Profile name', { exact: true }).fill('Connect after saving');
    await vncProfile.getByLabel('VNC username', { exact: true }).fill('desktop-user');
    const vncHost = vncProfile.getByLabel('Host or IP address', { exact: true });
    await vncHost.fill('fail-save.fixture.invalid');
    const saveAndConnect = vncProfile.getByRole('button', { name: 'Save & Connect', exact: true });
    await saveAndConnect.click();
    await vncProfile.getByRole('alert').filter({ hasText: 'Fixture could not save' }).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-vnc-open'), null);
    await vncHost.fill('connect.fixture.invalid');
    await saveAndConnect.click();
    await vncProfile.waitFor({ state: 'hidden' });
    const tlsSave = (await readVncWrites()).at(-1);
    assert.ok(tlsSave?.type === 'save-profile');
    assert.equal(
        tlsSave.profiles.find(({ host }) => host === 'connect.fixture.invalid')?.tlsUsername,
        'desktop-user',
    );
    assert.deepEqual(
        JSON.parse((await page.locator('body').getAttribute('data-vnc-open')) ?? 'null'),
        {
            host: 'connect.fixture.invalid',
            connect: true,
        },
    );

    const beforeFailedSave = (await readVncWrites()).length;
    const manualViewer = await page.locator('body').getAttribute('data-vnc-open');
    const retryLabel = 'Inline retry password';
    await fillInlineVncDraft('fail-save.fixture.invalid', retryLabel);
    await saveAndConnect.click();
    const profileSaveError = vncProfile
        .getByRole('alert')
        .filter({ hasText: 'Fixture could not save' });
    await profileSaveError.waitFor();
    assert.match(await profileSaveError.innerText(), /Password saved in Vault/);
    assert.equal(await vncProfile.getByLabel('Password', { exact: true }).count(), 0);
    await vncProfile
        .getByLabel('Vault credential')
        .getByText(retryLabel, { exact: true })
        .waitFor();
    const failedInline = (await readVncWrites()).slice(beforeFailedSave);
    assert.deepEqual(
        failedInline.map(({ type }) => type),
        ['create', 'save-profile'],
    );
    const [savedPassword, failedProfile] = failedInline;
    assert.ok(savedPassword?.type === 'create' && failedProfile?.type === 'save-profile');
    assert.deepEqual(savedPassword.secretValues, { password: inlinePassword });
    assert.equal(
        failedProfile.profiles.find(({ host }) => host === 'fail-save.fixture.invalid')
            ?.credentialId,
        savedPassword.item.logicalId,
    );
    assert.equal(await page.locator('body').getAttribute('data-vnc-open'), manualViewer);

    const retryHost = 'connect-inline.fixture.invalid';
    await vncHost.fill(retryHost);
    await vncProfile.getByText('Choose a credential again for the new address.').waitFor();
    await vncProfile.getByLabel('Vault credential').click();
    await page.getByRole('option', { name: retryLabel, exact: true }).click();
    await saveAndConnect.click();
    await vncProfile.waitFor({ state: 'hidden' });
    const retryWrites = (await readVncWrites()).slice(beforeFailedSave + failedInline.length);
    assert.deepEqual(
        retryWrites.map(({ type }) => type),
        ['save-profile'],
    );
    const [retrySave] = retryWrites;
    assert.ok(retrySave?.type === 'save-profile');
    assert.equal(
        retrySave.profiles.find(({ host }) => host === retryHost)?.credentialId,
        savedPassword.item.logicalId,
    );
    assert.deepEqual(
        JSON.parse((await page.locator('body').getAttribute('data-vnc-open')) ?? 'null'),
        { host: retryHost, connect: true },
    );

    const beforeReloadConflict = (await readVncWrites()).length;
    const viewerBeforeReload = await page.locator('body').getAttribute('data-vnc-open');
    const reloadHost = 'post-commit-reload.fixture.invalid';
    const reloadLabel = 'Password for committed profile';
    await fillInlineVncDraft(reloadHost, reloadLabel);
    await saveAndConnect.click();
    const reloadConflict = vncProfile
        .getByRole('alert')
        .filter({ hasText: 'VNC profiles changed' });
    await reloadConflict.waitFor();
    assert.match(await reloadConflict.innerText(), /Password saved in Vault/);
    await vncProfile
        .getByLabel('Vault credential')
        .getByText(reloadLabel, { exact: true })
        .waitFor();
    assert.equal(await page.locator('body').getAttribute('data-vnc-open'), viewerBeforeReload);
    const committedWrites = (await readVncWrites()).slice(beforeReloadConflict);
    assert.deepEqual(
        committedWrites.map(({ type }) => type),
        ['create', 'save-profile'],
    );
    const [reloadPassword, committedSave] = committedWrites;
    assert.ok(reloadPassword?.type === 'create' && committedSave?.type === 'save-profile');
    const committedProfiles = committedSave.profiles.filter(({ host }) => host === reloadHost);
    assert.equal(committedProfiles.length, 1);
    const [committedProfile] = committedProfiles;
    assert.equal(committedProfile.credentialId, reloadPassword.item.logicalId);

    await saveAndConnect.click();
    await vncProfile.waitFor({ state: 'hidden' });
    const reloadRetryWrites = (await readVncWrites()).slice(
        beforeReloadConflict + committedWrites.length,
    );
    assert.deepEqual(
        reloadRetryWrites.map(({ type }) => type),
        ['save-profile'],
    );
    const [reloadRetry] = reloadRetryWrites;
    assert.ok(reloadRetry?.type === 'save-profile');
    const retryProfiles = reloadRetry.profiles.filter(({ host }) => host === reloadHost);
    assert.equal(
        retryProfiles.length,
        1,
        'Retry updates the profile already committed before reload',
    );
    assert.equal(retryProfiles[0].id, committedProfile.id);
    assert.equal(retryProfiles[0].credentialId, reloadPassword.item.logicalId);
    assert.deepEqual(
        JSON.parse((await page.locator('body').getAttribute('data-vnc-open')) ?? 'null'),
        { host: reloadHost, connect: true },
    );

    await page.getByRole('button', { name: 'Edit reloaded VNC profile', exact: true }).click();
    await editVnc.waitFor();
    await page
        .getByRole('button', { name: 'Delete first VNC profile', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await page.waitForFunction(() => Boolean(document.body.dataset.deletedVncProfile));
    const beforeDeletedEdit = await readVncWrites();
    const viewerBeforeDeletedEdit = await page.locator('body').getAttribute('data-vnc-open');
    await editVnc.getByRole('button', { name: 'Save & Connect', exact: true }).click();
    await editVnc.getByRole('alert').filter({ hasText: 'no longer exists' }).waitFor();
    assert.deepEqual(await readVncWrites(), beforeDeletedEdit);
    assert.equal(await page.locator('body').getAttribute('data-vnc-open'), viewerBeforeDeletedEdit);
    await editVnc.getByRole('button', { name: 'Cancel', exact: true }).click();
    await editVnc.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: 'New host fixture', exact: true }).click();
    await dialog.getByRole('button', { name: /^SSH connection/ }).click();
    await dialog.getByLabel('Host', { exact: true }).fill('shared-vault.fixture.invalid');
    await dialog.getByLabel('Username', { exact: true }).fill('fixture');
    await dialog.getByRole('button', { name: 'Saved credential', exact: true }).click();
    const sshCredential = dialog.getByLabel('Vault credential');
    await sshCredential.click();
    await page.getByRole('option', { name: /^Fixture SSH password/ }).waitFor();
    await page.getByRole('option', { name: /^Inline fixture password/ }).waitFor();
    await page.getByRole('option', { name: /^Fixture private key/ }).waitFor();
    assert.equal(await page.getByRole('option', { name: /^Fixture API token/ }).count(), 0);
    await page.getByRole('option', { name: /^Fixture VNC password/ }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const savedSsh = JSON.parse(
        (await page.locator('body').getAttribute('data-saved-ssh-connection')) ?? '{}',
    );
    assert.equal(savedSsh.host, 'shared-vault.fixture.invalid');
    assert.equal(savedSsh.password, undefined);
    assert.deepEqual(savedSsh.authRef, {
        credentialId: 'vnc-logical',
        itemId: 'vnc-item',
        itemKind: 'ssh-password',
        purpose: 'ssh-auth',
        vaultId: 'fixture-vault',
    });

    await page.getByRole('button', { name: 'New host fixture', exact: true }).click();
    await dialog.getByRole('button', { name: /^Import SSH config/ }).click();
    const importDialog = page.getByRole('dialog', { name: 'Import SSH Connections', exact: true });
    await importDialog
        .getByText(
            'Multiple CertificateFile entries: only the first is imported. Review the certificate after import.',
            { exact: true },
        )
        .waitFor();
    await importDialog.getByText('Encrypted key needs a passphrase', { exact: true }).waitFor();
    await importDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await importDialog.waitFor({ state: 'hidden' });
    await dialog.getByRole('button', { name: /^SSH connection/ }).click();
    await page.getByLabel('Host', { exact: true }).fill('fixture.invalid');
    await page.getByLabel('Username', { exact: true }).fill('fixture');
    await page.getByLabel('Password', { exact: true }).fill('fixture-only');
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await dialog.getByRole('button', { name: /^SSH connection/ }).click();
    assert.equal(
        await page.getByLabel('Host', { exact: true }).inputValue(),
        'fixture.invalid',
        'Back preserves the manual draft',
    );
    if (screenshots) {
        await page.screenshot({ path: `${screenshots}/host-form-dark.png` });
        await page.evaluate(() => {
            document.body.dataset.overlayGalleryTheme = 'light';
        });
        await page.waitForTimeout(250); // Let shared color transitions settle before visual inspection.
        await page.screenshot({ path: `${screenshots}/host-form-light.png` });
        await page.evaluate(() => {
            document.body.dataset.overlayGalleryTheme = 'dark';
        });
    }

    // A delayed result belongs to the tested snapshot, never to newly edited inputs.
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await page.getByLabel('Host', { exact: true }).fill('changed.invalid');
    await finishNextConnectionTest(page, 'Finish test');
    await page.waitForTimeout(100);
    assert.equal(await page.getByText('Connection successful!', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await page
        .getByRole('button', { name: 'Update connection status', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await finishNextConnectionTest(page, 'Finish test');
    await page.getByText('Connection successful!', { exact: true }).waitFor();
    await page
        .getByRole('button', { name: 'Update connection status', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    assert.equal(
        await page.getByText('Connection successful!', { exact: true }).count(),
        1,
        'Unrelated connection status updates do not invalidate the tested result',
    );
    await page.getByLabel('Username', { exact: true }).fill('other');
    assert.equal(await page.getByText('Connection successful!', { exact: true }).count(), 0);

    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await finishNextConnectionTest(page, 'Reject test');
    await page
        .getByText(
            'Connection refused. Check the host, port and whether the SSH server is running.',
            { exact: true },
        )
        .waitFor();
    const rawError = page.getByText('Connection refused (os error 10061)', { exact: true });
    assert.equal(await rawError.isVisible(), false);
    await page.getByText('Details', { exact: true }).click();
    assert.equal(await rawError.isVisible(), true);

    await page.evaluate(() => {
        document.body.dataset.legacyKexFixture = 'enabled';
    });
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    const legacyPrompt = page.getByRole('dialog', { name: 'Allow legacy SSH key exchange?' });
    await legacyPrompt.getByText(/diffie-hellman-group14-sha1/).waitFor();
    await legacyPrompt.getByRole('button', { name: 'Cancel', exact: true }).click();
    await legacyPrompt.waitFor({ state: 'hidden' });
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await legacyPrompt.getByRole('button', { name: 'Allow & retry', exact: true }).click();
    await dialog
        .getByText('Connection successful. Save this host to remember the legacy SSH exception.')
        .waitFor();
    assert.equal(
        await page.evaluate(() =>
            Object.keys(localStorage).some((key) => key.startsWith('zync:legacy-kex:')),
        ),
        false,
    );
    await page.evaluate(() => {
        delete document.body.dataset.legacyKexFixture;
    });

    await page
        .getByRole('button', { name: 'Enable SSH verification fixture' })
        .evaluate((button: HTMLElement) => button.click());
    const requestVerification = async () => {
        await page
            .getByRole('button', { name: 'Request SSH verification' })
            .evaluate((button: HTMLElement) => button.click());
    };
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await requestVerification();
    const verification = page.getByRole('dialog', { name: 'SSH verification', exact: true });
    await verification.getByText('fixture@jump.fixture.invalid:2222', { exact: true }).waitFor();
    const label = verification.getByLabel('Account label', { exact: true });
    const code = verification.getByLabel('Verification code', { exact: true });
    assert.equal(await label.getAttribute('type'), 'text');
    assert.equal(await code.getAttribute('type'), 'password');
    await label.fill('account');
    await code.fill('界'.repeat(1400));
    await code.press('Enter');
    await verification
        .getByRole('alert')
        .getByText('A response is too long. Shorten it and try again.')
        .waitFor();
    await code.fill('012345');
    await code.press('Enter');
    const backup = verification.getByLabel('Backup code', { exact: true });
    await backup.waitFor();
    assert.equal(await backup.inputValue(), '', 'Each challenge round starts with a fresh input');
    await backup.fill('backup');
    await verification.getByRole('button', { name: 'Continue', exact: true }).click();
    await verification.waitFor({ state: 'hidden' });
    await page.getByText('Connection successful!', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.body.dataset.verificationReply), 'accepted');

    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await requestVerification();
    await code.waitFor();
    await verification.getByRole('button', { name: 'Cancel', exact: true }).click();
    await verification.waitFor({ state: 'hidden' });
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.body.dataset.verificationReply), 'cancelled');

    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Key host fixture', exact: true }).click();
    await page.getByText('Valid unencrypted private key.', { exact: true }).waitFor();
    const appearanceDialog = page.getByRole('dialog', { name: 'Edit host', exact: true });
    await appearanceDialog.getByRole('button', { name: /^Appearance/ }).click();
    const hostIcon = appearanceDialog.getByRole('combobox', { name: 'Icon', exact: true });
    assert.equal(await hostIcon.innerText(), 'Automatic');
    await appearanceDialog.getByText('Detected OS: Ubuntu', { exact: true }).waitFor();
    await hostIcon.click();
    const iconFilter = page.getByRole('combobox', { name: 'Filter Icon', exact: true });
    await iconFilter.fill('Debian');
    await page.getByRole('option', { name: 'Debian', exact: true }).click();
    assert.equal(await hostIcon.innerText(), 'Debian');
    await iconFilter.waitFor({ state: 'hidden' });
    await hostIcon.click();
    await page.getByRole('option', { name: 'Automatic', exact: true }).click();
    await appearanceDialog.getByText('Detected OS: Ubuntu', { exact: true }).waitFor();
    const blueLabel = appearanceDialog.getByRole('button', { name: 'Dev', exact: true });
    await blueLabel.click();
    assert.equal(await blueLabel.getAttribute('aria-pressed'), 'true');
    await appearanceDialog.getByRole('button', { name: /^Appearance/ }).click();
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await finishNextConnectionTest(page, 'Finish test');
    await page.waitForTimeout(100);
    assert.equal(
        await page.getByRole('button', { name: 'Testing…', exact: true }).isDisabled(),
        true,
        "Old completion cannot release the reopened editor's pending owner",
    );
    assert.equal(await page.getByText('Connection successful!', { exact: true }).count(), 0);
    await finishNextConnectionTest(page, 'Finish test');
    await page.getByText('Connection successful!', { exact: true }).waitFor();
    assert.equal(
        await page
            .getByText('Key filename is uncommon. Confirm this is a private key.', { exact: true })
            .count(),
        0,
    );
    assert.equal(await page.getByLabel('User certificate (optional)', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Add certificate file', exact: true }).click();
    const certificateInput = page.getByLabel('User certificate (optional)', { exact: true });
    await certificateInput.fill('C:\\fixture\\existing-cert.pub');
    const certificateBrowse = page.getByRole('button', { name: 'Browse', exact: true }).last();
    await certificateBrowse.click();
    await page.waitForFunction(
        () =>
            document.body.dataset.fixtureToast ===
            'error:Failed to select certificate: fixture dialog failure',
    );
    assert.equal(
        await certificateInput.inputValue(),
        'C:\\fixture\\existing-cert.pub',
        'Picker failure preserves the configured certificate',
    );
    await certificateBrowse.click();
    await page.waitForFunction(
        () =>
            document.body.dataset.fixtureToast ===
            'error:Failed to select certificate: fixture string failure',
    );
    await certificateBrowse.click();
    assert.equal(
        await certificateInput.inputValue(),
        'C:\\fixture\\picked-cert.pub',
        'String picker result updates the certificate',
    );
    await certificateBrowse.click();
    assert.equal(
        await certificateInput.inputValue(),
        'C:\\fixture\\picked-cert.pub',
        'Cancelling the picker preserves the certificate',
    );
    await page.getByLabel('User certificate (optional)', { exact: true }).fill('bad\0certificate');
    await page
        .getByText('Certificate path contains invalid characters.', { exact: true })
        .first()
        .waitFor();
    assert.equal(
        await page
            .getByLabel('User certificate (optional)', { exact: true })
            .getAttribute('aria-invalid'),
        'true',
    );
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await page
        .getByLabel('User certificate (optional)', { exact: true })
        .fill('C:\\fixture\\client-cert.pub');
    if (screenshots) {
        await page.screenshot({ path: `${screenshots}/host-form-certificate.png` });
    }
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    assert.equal(await page.getByLabel('User certificate (optional)', { exact: true }).count(), 0);

    await page.getByRole('button', { name: /^Advanced/ }).click();
    await page.getByLabel('Network interface', { exact: true }).click();
    await page.getByRole('option', { name: /Wi-Fi fixture/ }).click();
    await page
        .getByRole('dialog', { name: 'Edit host', exact: true })
        .getByText('192.0.2.5, fe80::12', { exact: true })
        .waitFor();
    await page
        .getByRole('dialog', { name: 'Edit host', exact: true })
        .getByText('Fixture wireless driver', { exact: true })
        .waitFor();
    await page.getByLabel('Network interface', { exact: true }).click();
    await page.getByRole('option', { name: 'Ask every time', exact: true }).click();
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    const networkDialog = page.getByRole('dialog', {
        name: 'Choose network interface',
        exact: true,
    });
    await networkDialog.waitFor();
    assert.equal(await networkDialog.getByText(/fixture@fixture.invalid:22222/).count(), 1);
    await networkDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await networkDialog.waitFor({ state: 'hidden' });

    for (const viewport of [
        { width: 1100, height: 900 },
        { width: 640, height: 520 },
        { width: 390, height: 700 },
    ]) {
        await page.setViewportSize(viewport);
        const bounds = await page
            .getByRole('dialog', { name: 'Edit host', exact: true })
            .boundingBox();
        assert.ok(
            bounds &&
                bounds.x >= 0 &&
                bounds.y >= 0 &&
                bounds.x + bounds.width <= viewport.width + 1 &&
                bounds.y + bounds.height <= viewport.height + 1,
            'Dialog stays within the viewport',
        );
        assert.equal(
            await page.getByRole('button', { name: 'Save & Connect', exact: true }).isVisible(),
            true,
        );
        const footerStyle = await page
            .getByRole('group', { name: 'Save connection actions' })
            .evaluate((toolbar: HTMLElement) => {
                const footer = toolbar.parentElement!.parentElement!;
                const style = getComputedStyle(footer);
                return {
                    blur: style.backdropFilter,
                    left: parseFloat(style.borderBottomLeftRadius),
                    right: parseFloat(style.borderBottomRightRadius),
                };
            });
        assert.equal(
            footerStyle.blur,
            'none',
            'Footer must not create a backdrop-filter layer outside the modal clip',
        );
        assert.ok(
            footerStyle.left > 0 && footerStyle.right > 0,
            'Both footer corners follow the dialog radius',
        );
    }
    await page.getByRole('button', { name: 'SSH key', exact: true }).click();
    await page.getByRole('button', { name: 'Add certificate file', exact: true }).click();
    await page.getByLabel('User certificate (optional)', { exact: true }).fill('/fixture-cert.pub');
    const hostDialog = page.getByRole('dialog', { name: 'Edit host', exact: true });
    await page.getByRole('button', { name: 'Local SSH agent', exact: true }).click();
    await hostDialog.getByRole('status').filter({ hasText: '0 keys found' }).waitFor();
    await page.getByText('No keys are available from this agent.', { exact: true }).waitFor();
    const agentHelp = hostDialog.getByRole('button', {
        name: 'About local SSH agent authentication',
    });
    await focusHelp(agentHelp);
    await page.getByRole('tooltip').filter({ hasText: 'New logins need the agent' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    assert.equal(await hostDialog.isVisible(), true, 'Dismissing help must preserve the editor');
    const forwarding = hostDialog.getByRole('switch', {
        name: 'SSH agent forwarding',
        exact: true,
    });
    const forwardingBefore = await forwarding.getAttribute('aria-checked');
    const forwardingHelp = hostDialog.getByRole('button', { name: 'About SSH agent forwarding' });
    await focusHelp(forwardingHelp);
    await page
        .getByRole('tooltip')
        .filter({ hasText: 'This does not choose how you log in' })
        .waitFor();
    assert.equal(await forwarding.getAttribute('aria-checked'), forwardingBefore);

    await page.evaluate(() => {
        document.body.dataset.agentFixture = 'error';
    });
    await hostDialog
        .getByRole('button', { name: 'Refresh local SSH agent keys', exact: true })
        .click();
    await hostDialog
        .getByRole('alert')
        .filter({ hasText: 'No local SSH agent is reachable.' })
        .waitFor();
    assert.equal(await hostDialog.getByText(/early eof/).count(), 0);
    const setupButton = hostDialog.getByRole('button', {
        name: 'SSH agent setup help',
        exact: true,
    });
    await setupButton.click();
    const setup = hostDialog.getByRole('region', { name: 'SSH agent setup help' });
    const originalPlatform = await page.evaluate(() => navigator.platform);
    await setup
        .getByText(/win/i.test(originalPlatform) ? /same agent endpoint/ : /SSH_AUTH_SOCK/)
        .waitFor();
    await setup.getByText('Technical details', { exact: true }).click();
    await setup.getByText('early eof', { exact: true }).waitFor();
    await setupButton.click();
    await setup.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    });
    await setupButton.click();
    await setup.getByText(/Windows OpenSSH Authentication Agent service/).waitFor();
    await setupButton.click();
    await page.evaluate((platform) => {
        Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
    }, originalPlatform);
    for (const scenario of [
        {
            mode: 'refused',
            message: 'The SSH agent refused to list keys.',
            help: 'allow it to share its key list',
        },
        {
            mode: 'accessDenied',
            message: 'Zync cannot access the local SSH agent.',
            help: 'Allow Zync to access the agent',
        },
        {
            mode: 'timeout',
            message: 'The local SSH agent did not respond in time.',
            help: 'Check for an agent prompt',
        },
        {
            mode: 'legacy',
            message: 'Could not read keys from the local SSH agent.',
            help: 'Enable the SSH agent',
        },
    ]) {
        await page.evaluate((mode) => {
            document.body.dataset.agentFixture = mode;
        }, scenario.mode);
        await hostDialog
            .getByRole('button', { name: 'Refresh local SSH agent keys', exact: true })
            .click();
        await hostDialog.getByRole('alert').filter({ hasText: scenario.message }).waitFor();
        await setupButton.click();
        await setup.getByText(new RegExp(scenario.help)).waitFor();
        await setupButton.click();
    }
    await page.evaluate(() => {
        document.body.dataset.agentFixture = 'key';
    });
    await hostDialog
        .getByRole('button', { name: 'Refresh local SSH agent keys', exact: true })
        .click();
    await hostDialog.getByRole('status').filter({ hasText: '1 key found' }).waitFor();
    const agentPanel = hostDialog.getByRole('group', { name: 'Local SSH agent authentication' });
    const picker = agentPanel.getByRole('combobox', { name: 'Local SSH agent key', exact: true });
    assert.equal(await setupButton.count(), 0);
    assert.equal(await picker.innerText(), 'Use agent’s first key');
    await picker
        .getByRole('img', { name: /Agent: 1Password \(process signature checked\)/ })
        .waitFor();
    const originalIconStyle = await picker
        .locator('img')
        .evaluate(async (image: HTMLImageElement) => {
            await image.decode();
            const style = getComputedStyle(image);
            return { width: image.naturalWidth, filter: style.filter, mask: style.maskImage };
        });
    assert.ok(originalIconStyle.width > 0, 'The original app icon loads');
    assert.equal(originalIconStyle.filter, 'none', 'Provider artwork retains its original colors');
    assert.equal(
        originalIconStyle.mask,
        'none',
        'Provider artwork is not rendered as a themed mask',
    );
    for (const mark of ['1password', 'bitwarden']) {
        const iconResponse = await page.request.get(`${baseUrl}/agent-providers/${mark}.png`);
        assert.equal(iconResponse.status(), 200);
        assert.equal(
            (await iconResponse.body()).subarray(0, 8).toString('hex'),
            '89504e470d0a1a0a',
        );
    }
    await focusHelp(
        agentPanel.getByRole('button', { name: 'About automatic agent key selection' }),
    );
    await page
        .getByRole('tooltip')
        .filter({ hasText: 'does not try the remaining keys' })
        .waitFor();
    await picker.focus();
    assert.equal(
        await picker.innerText(),
        'Use agent’s first key',
        'Help must not change selection',
    );
    await picker.click();
    await page
        .getByRole('option', { name: /Fixture key with a long comment/ })
        .getByRole('img', { name: /Agent: 1Password/ })
        .waitFor();
    await page.getByRole('option', { name: /Fixture key with a long comment/ }).click();
    await agentPanel.getByText('SHA256:fixture-public-fingerprint', { exact: true }).waitFor();
    const agentBounds = await agentPanel.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
    }));
    assert.ok(agentBounds.scroll <= agentBounds.client + 1, 'Long key labels fit a narrow form');

    await page.evaluate(() => {
        document.body.dataset.agentFixture = 'certificates';
    });
    await agentPanel.getByRole('button', { name: 'Refresh local SSH agent keys' }).click();
    await agentPanel.getByRole('status').filter({ hasText: '2 keys found' }).waitFor();
    await picker.click();
    const certificates = page.getByRole('option', { name: /Shared certificate label/ });
    assert.equal(await certificates.count(), 2);
    await certificates.nth(1).click();
    await picker.click();
    await certificates.nth(1).waitFor();
    assert.equal(
        await certificates.nth(1).getAttribute('aria-selected'),
        'true',
        'Reopening focuses the selected certificate even when display labels match',
    );
    assert.notEqual(await certificates.nth(0).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Enter');
    assert.equal(await picker.innerText(), 'Shared certificate label');

    // Many identities stay inside the shared, bounded popup and remain searchable by fingerprint.
    await page.evaluate(() => {
        document.body.dataset.agentFixture = 'many';
    });
    await hostDialog
        .getByRole('button', { name: 'Refresh local SSH agent keys', exact: true })
        .click();
    await hostDialog.getByRole('status').filter({ hasText: '40 keys found' }).waitFor();
    assert.equal(
        await picker.innerText(),
        'Saved key (not listed)',
        'Refresh preserves a missing saved selector',
    );
    await picker.click();
    const keyList = page.getByRole('listbox');
    await keyList.waitFor();
    const listBounds = await keyList.evaluate((element) => ({
        client: element.clientHeight,
        scroll: element.scrollHeight,
    }));
    assert.ok(listBounds.scroll > listBounds.client, 'Large key lists scroll inside the popup');
    const filter = page.getByRole('combobox', { name: 'Filter Local SSH agent key', exact: true });
    for (const hiddenValue of ['fixture-public-selector-37', 'option:']) {
        await filter.fill(hiddenValue);
        await page.getByText('No matches', { exact: true }).waitFor();
        assert.equal(await page.getByRole('option').count(), 0, 'Hidden IDs are not searchable');
    }
    await filter.fill('Fixture key 37');
    await page.getByRole('option', { name: /Fixture key 37/ }).waitFor();
    await filter.fill('SHA256:fixture-public-fingerprint-37');
    await page.getByRole('option', { name: /Fixture key 37/ }).waitFor();
    assert.equal(await page.getByRole('option').count(), 1);
    await page.keyboard.press('Enter');
    await agentPanel.getByText('SHA256:fixture-public-fingerprint-37', { exact: true }).waitFor();
    assert.equal(await picker.innerText(), 'Fixture key 37');
    await picker
        .getByRole('img', { name: /Agent: Bitwarden \(process signature checked\)/ })
        .waitFor();
    for (const scenario of [
        { mode: 'hint', label: /Agent: Bitwarden \(inferred from socket path\)/ },
        { mode: 'unknown', label: /Provider could not be identified/ },
        { mode: 'many', label: /Agent: Bitwarden \(process signature checked\)/ },
    ]) {
        await page.evaluate((mode) => {
            document.body.dataset.agentFixture = mode;
        }, scenario.mode);
        await hostDialog
            .getByRole('button', { name: 'Refresh local SSH agent keys', exact: true })
            .click();
        await hostDialog.getByRole('status').filter({ hasText: '40 keys found' }).waitFor();
        await picker.getByRole('img', { name: scenario.label }).waitFor();
        assert.equal(
            await picker.innerText(),
            'Fixture key 37',
            'Provider metadata never replaces the selected key',
        );
    }
    await hostDialog
        .getByRole('button', { name: 'Refresh local SSH agent keys', exact: true })
        .click();
    await hostDialog.getByRole('status').filter({ hasText: '40 keys found' }).waitFor();
    assert.equal(
        await picker.innerText(),
        'Fixture key 37',
        'Refresh keeps the selected public identity',
    );
    const forwardingBounds = await forwarding.evaluate((element) => {
        const row = element.parentElement!;
        return { client: row.clientWidth, scroll: row.scrollWidth };
    });
    assert.ok(
        forwardingBounds.scroll <= forwardingBounds.client + 1,
        'Forwarding help fits beside its switch',
    );
    if (screenshots) {
        await hostDialog.screenshot({ path: `${screenshots}/host-form-agent-narrow.png` });
    }
    assert.equal(
        await page.getByRole('button', { name: 'Add certificate file', exact: true }).count(),
        0,
    );
    assert.equal(await page.getByLabel('User certificate (optional)', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'SSH key', exact: true }).click();
    assert.equal(
        await page.getByLabel('User certificate (optional)', { exact: true }).inputValue(),
        '',
    );
    await page.evaluate(() => {
        document.body.dataset.agentFixture = 'error';
    });
    await page.getByRole('button', { name: 'Local SSH agent', exact: true }).click();
    await hostDialog
        .getByRole('alert')
        .filter({ hasText: 'No local SSH agent is reachable.' })
        .waitFor();
    await hostDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await hostDialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
        document.body.dataset.agentFixture = 'key';
    });
    await page
        .getByRole('button', { name: 'Selector-only agent host fixture', exact: true })
        .click();
    await hostDialog.getByRole('combobox', { name: 'Local SSH agent key', exact: true }).waitFor();
    await hostDialog.getByRole('status').filter({ hasText: '1 key found' }).waitFor();
    assert.match(
        await hostDialog
            .getByRole('combobox', { name: 'Local SSH agent key', exact: true })
            .innerText(),
        /^Fixture key with a long comment/,
        'A saved agent selector without the flag opens agent authentication with its key selected',
    );
    await hostDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await hostDialog.waitFor({ state: 'hidden' });
    const quickAuth = page.getByRole('region', { name: 'Quick connect authentication fixture' });
    const quickPrivateKey = quickAuth.getByRole('textbox', { name: 'Private key file path' });
    const quickPassword = quickAuth.getByLabel('SSH password', { exact: true });
    await quickPassword.fill('fixture password');
    await quickPrivateKey.fill('/fixture/key');
    const localAgent = quickAuth.getByRole('checkbox', { name: 'Use local SSH agent' });
    await localAgent.check();
    assert.equal(await quickPassword.isDisabled(), true);
    assert.equal(await quickPrivateKey.isDisabled(), true);
    assert.equal(
        await quickAuth.getByRole('button', { name: 'Browse for private key file' }).isDisabled(),
        true,
    );
    assert.equal(await quickAuth.getByLabel('Port override').isEnabled(), true);
    await focusHelp(
        quickAuth.getByRole('button', { name: 'About local SSH agent authentication' }),
    );
    await page.getByRole('tooltip').filter({ hasText: 'Agent forwarding is separate' }).waitFor();
    assert.equal(await localAgent.isChecked(), true);
    await page.keyboard.press('Escape');
    await localAgent.uncheck();
    assert.equal(await quickPassword.isEnabled(), true);
    assert.equal(await quickPrivateKey.isEnabled(), true);
    assert.equal(await quickPassword.inputValue(), 'fixture password');
    assert.equal(await quickPrivateKey.inputValue(), '/fixture/key');

    await page.getByRole('button', { name: 'Key host fixture', exact: true }).click();
    await hostDialog.getByRole('button', { name: 'Password', exact: true }).click();
    await hostDialog.getByLabel('Password', { exact: true }).fill('fixture-password');
    await page.evaluate(() => {
        document.body.dataset.legacyKexFixture = 'enabled';
    });
    await hostDialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await legacyPrompt.getByRole('button', { name: 'Allow & retry', exact: true }).click();
    await hostDialog
        .getByText('Connection successful. Save this host to remember the legacy SSH exception.')
        .waitFor();
    await hostDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await hostDialog.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: 'Key host fixture', exact: true }).click();
    await hostDialog.getByRole('button', { name: /^Advanced/ }).click();
    await hostDialog.getByText('diffie-hellman-group14-sha1', { exact: true }).waitFor();
    await hostDialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    const legacyTestSuccess = hostDialog.getByText('Connection successful!', { exact: true });
    await legacyTestSuccess.waitFor();
    await hostDialog.getByRole('button', { name: 'Remove exception on save', exact: true }).click();
    await legacyTestSuccess.waitFor({ state: 'hidden' });
    await hostDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await hostDialog.waitFor({ state: 'hidden' });
    assert.equal(
        await page.evaluate(() =>
            Object.keys(localStorage).some((key) => key.startsWith('zync:legacy-kex:')),
        ),
        false,
    );

    assert.deepEqual(errors, []);
    console.log('Host onboarding browser regressions passed');
} catch (error) {
    const directory = process.env.ZYNC_BROWSER_SCREENSHOT_DIR;
    const failedPage = browser?.contexts()[0]?.pages()[0];
    if (directory && failedPage) {
        try {
            await failedPage.screenshot({ path: `${directory}/host-form-failure.png` });
        } catch (screenshotError) {
            console.warn('Could not capture the failed connection form:', screenshotError);
        }
    }
    throw error;
} finally {
    await browser?.close();
    await server?.close();
}
