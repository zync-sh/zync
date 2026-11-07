import assert from 'node:assert/strict';

import react from '@vitejs/plugin-react';
import type { Browser } from 'playwright-core';
import { createServer } from 'vite';

const { chromium } = (await import(
    process.env.ZYNC_PLAYWRIGHT_MODULE || 'playwright-core'
)) as typeof import('playwright-core');
const fixture = '/tests/vault/vaultSshCertificate.browser.html';
const externalServer = process.env.ZYNC_BROWSER_BASE_URL;
const server = externalServer
    ? undefined
    : await createServer({
          configFile: false,
          plugins: [react()],
          cacheDir: 'node_modules/.vite-vault-credential-tests',
          server: {
              host: '127.0.0.1',
              port: 0,
              watch: null,
          },
          optimizeDeps: { entries: [fixture.slice(1)], exclude: ['@enjoys/context-engine'] },
      });
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
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${baseUrl}${fixture}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add fixture', exact: true }).click();
    await page.getByLabel('Label', { exact: true }).fill('Fixture key');
    await page.locator('#vault-add-private-key').fill('fixture key, not a real secret');
    await page
        .getByLabel('Private key passphrase (optional)', { exact: true })
        .fill(' fixture passphrase ');
    const certificateTop = await page.getByLabel('SSH user certificate (optional)').boundingBox();
    const passphraseTop = await page.getByLabel('Private key passphrase (optional)').boundingBox();
    assert.ok(
        certificateTop && passphraseTop && certificateTop.y < passphraseTop.y,
        'Certificate precedes the passphrase',
    );
    await page.getByLabel('SSH user certificate (optional)').fill(' fixture certificate ');
    await page.getByRole('button', { name: 'Add Credential', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    let calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.deepEqual(calls[0].args.secret_values, {
        privateKey: 'fixture key, not a real secret',
        passphrase: ' fixture passphrase ',
        sshCertificate: 'fixture certificate',
    });

    // Closing/reopening resets optional certificate input, and password payloads never include it.
    await page.getByRole('button', { name: 'Add fixture', exact: true }).click();
    assert.equal(await page.getByLabel('SSH user certificate (optional)').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: /^(SSH|VNC) password\b/i }).count(), 0);
    const passwordKind = page.getByRole('button', { name: /^Password\b/ });
    assert.equal(await passwordKind.count(), 1);
    await passwordKind.click();
    assert.equal(await page.getByLabel('SSH user certificate (optional)').count(), 0);
    await page.getByLabel('Label', { exact: true }).fill('Password fixture');
    await page.getByLabel('Password', { exact: true }).fill('fixture password');
    await page.getByRole('button', { name: 'Add Credential', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.equal(calls.at(-1).args.kind, 'ssh-password');
    assert.deepEqual(calls.at(-1).args.secret_values, { password: 'fixture password' });

    await page.getByRole('button', { name: 'Rotate legacy password fixture', exact: true }).click();
    const newPassword = page.getByLabel('New Password', { exact: true });
    assert.equal(await newPassword.getAttribute('type'), 'password');
    await newPassword.fill(' fixture replacement ');
    await page.getByRole('button', { name: 'Rotate Credential', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.equal(calls.at(-1).command, 'vault_item_update');
    assert.equal(calls.at(-1).args.item_id, 'legacy-vnc-item');
    assert.deepEqual(calls.at(-1).args.secret_values, { password: ' fixture replacement ' });

    await page.getByRole('button', { name: 'Rotate fixture', exact: true }).click();
    await page.locator('#vault-rotate-private-key').fill('replacement key');
    await page.getByLabel('SSH user certificate (optional)').fill('replacement certificate');
    await page.getByRole('button', { name: 'Rotate Credential', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.deepEqual(calls.at(-1).args.secret_values, {
        privateKey: 'replacement key',
        sshCertificate: 'replacement certificate',
    });

    await page.getByRole('button', { name: 'Edit certificate fixture', exact: true }).click();
    await page.getByLabel('SSH user certificate (optional)').fill('wrong certificate');
    await page.getByRole('button', { name: 'Replace certificate', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /does not match/);
    await page.getByLabel('SSH user certificate (optional)').fill('renewed certificate');
    await page.getByRole('button', { name: 'Replace certificate', exact: true }).click();
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLTextAreaElement>('#vault-details-ssh-certificate')?.value ===
            '',
    );
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.deepEqual(calls.at(-1), {
        command: 'vault_item_set_ssh_certificate',
        args: {
            item_id: 'fixture-item',
            expected_revision: 3,
            expected_secret_fingerprint: 'fixture-fingerprint',
            certificate: 'renewed certificate',
        },
    });
    await page.getByRole('button', { name: 'Remove certificate', exact: true }).click();
    await page.getByText('SSH certificate · Not attached', { exact: true }).waitFor();
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.deepEqual(calls.at(-1).args, {
        item_id: 'fixture-item',
        expected_revision: 4,
        expected_secret_fingerprint: 'updated-fingerprint',
        certificate: null,
    });

    // Import only fills the editor; writes still require the user's explicit save action.
    await page.getByRole('button', { name: 'Add fixture', exact: true }).click();
    const privateKeyFile =
        '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-file-key\n-----END OPENSSH PRIVATE KEY-----';
    const certificateFile = 'ssh-ed25519-cert-v01@openssh.com fixture-file-certificate fixture';
    await page.evaluate((text: string) => {
        document.body.dataset.fileText = text;
    }, privateKeyFile);
    await page.getByRole('button', { name: 'Import private key file', exact: true }).click();
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-add-private-key')?.value === text,
        privateKeyFile,
    );
    await page.evaluate((text: string) => {
        document.body.dataset.fileText = text;
    }, certificateFile);
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-add-ssh-certificate')?.value ===
            text,
        certificateFile,
    );
    let reads = await page.evaluate(() => JSON.parse(document.body.dataset.fileReads || '[]'));
    assert.deepEqual(
        reads.map((read: { args: unknown }) => read.args),
        [
            { connectionId: 'local', path: '/fixture/selected-file', maxBytes: 1024 * 1024 },
            { connectionId: 'local', path: '/fixture/selected-file', maxBytes: 65536 },
        ],
    );
    assert.equal(
        (await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'))).length,
        calls.length,
        'Importing does not persist a credential',
    );

    await page.evaluate(() => {
        document.body.dataset.fileMode = 'cancel';
    });
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    await page.waitForFunction(
        () =>
            !document.querySelector<HTMLButtonElement>('[aria-label="Import SSH certificate file"]')
                ?.disabled,
    );
    assert.equal(
        await page.getByLabel('SSH user certificate (optional)').inputValue(),
        certificateFile,
    );
    reads = await page.evaluate(() => JSON.parse(document.body.dataset.fileReads || '[]'));
    assert.equal(reads.length, 2, 'Cancelling a picker never reads a file');
    assert.equal(
        await page.getByRole('button', { name: 'Add Credential', exact: true }).isDisabled(),
        false,
        'Cancelling an import releases the save guard',
    );

    for (const mode of ['picker-error', 'read-error', 'invalid-file', 'empty-file']) {
        await page.evaluate((value: string) => {
            document.body.dataset.fileMode = value;
            document.body.dataset.fileText = value === 'empty-file' ? '' : 'not a certificate';
        }, mode);
        await page
            .getByRole('button', { name: 'Import SSH certificate file', exact: true })
            .click();
        await page.getByRole('alert').waitFor();
        assert.equal(
            await page.getByLabel('SSH user certificate (optional)').inputValue(),
            certificateFile,
            'Failed imports preserve the previous editor value',
        );
        assert.equal(
            await page.getByRole('button', { name: 'Add Credential', exact: true }).isDisabled(),
            false,
            'Failed imports release the save guard',
        );
    }
    // A delayed import cannot overwrite text typed after the file read started.
    await page.evaluate((text: string) => {
        document.body.dataset.fileMode = 'delayed';
        document.body.dataset.fileText = text;
    }, certificateFile);
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    await page.getByLabel('SSH user certificate (optional)').fill('newer certificate edit');
    await page
        .getByRole('button', { name: 'Finish file read', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await page.waitForTimeout(50);
    assert.equal(
        await page.getByLabel('SSH user certificate (optional)').inputValue(),
        'newer certificate edit',
    );

    // Closing and reopening cannot receive the abandoned import from the old editor.
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Add fixture', exact: true }).click();
    await page
        .getByRole('button', { name: 'Finish file read', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await page.waitForTimeout(50);
    assert.equal(await page.getByLabel('SSH user certificate (optional)').inputValue(), '');

    // Both concurrent imports must finish before either the button or direct hook submission can save.
    await page.getByLabel('Label', { exact: true }).fill('Delayed import fixture');
    await page.locator('#vault-add-private-key').fill('existing draft key');
    await page.getByRole('button', { name: 'Import private key file', exact: true }).click();
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    const addButton = page.getByRole('button', { name: 'Add Credential', exact: true });
    assert.equal(await addButton.isDisabled(), true);
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    await page
        .getByRole('button', { name: 'Submit add directly', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    assert.equal(
        (await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'))).length,
        calls.length,
        'The hook also rejects direct submission during imports',
    );
    await page.evaluate((text: string) => {
        document.body.dataset.fileText = text;
    }, privateKeyFile);
    await page
        .getByRole('button', { name: 'Finish file read', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-add-private-key')?.value === text,
        privateKeyFile,
    );
    assert.equal(
        await addButton.isDisabled(),
        true,
        'Finishing one import must not release the other',
    );
    await page.evaluate((text: string) => {
        document.body.dataset.fileText = text;
    }, certificateFile);
    await page
        .getByRole('button', { name: 'Finish file read', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-add-ssh-certificate')?.value ===
            text,
        certificateFile,
    );
    assert.equal(await addButton.isDisabled(), false);
    await addButton.click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.deepEqual(calls.at(-1).args.secret_values, {
        privateKey: privateKeyFile,
        sshCertificate: certificateFile,
    });

    // Rotation has the same protection, for both private-key and certificate imports.
    await page.getByRole('button', { name: 'Rotate fixture', exact: true }).click();
    await page.locator('#vault-rotate-private-key').fill('existing rotation draft');
    await page.getByRole('button', { name: 'Import private key file', exact: true }).click();
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    const rotateButton = page.getByRole('button', { name: 'Rotate Credential', exact: true });
    assert.equal(await rotateButton.isDisabled(), true);
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    await page
        .getByRole('button', { name: 'Submit rotation directly', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    assert.equal(
        (await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'))).length,
        calls.length,
    );
    await page.evaluate((text: string) => {
        document.body.dataset.fileText = text;
    }, privateKeyFile);
    await page
        .getByRole('button', { name: 'Finish file read', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-rotate-private-key')?.value ===
            text,
        privateKeyFile,
    );
    assert.equal(await rotateButton.isDisabled(), true);
    await page.evaluate((text: string) => {
        document.body.dataset.fileText = text;
    }, certificateFile);
    await page
        .getByRole('button', { name: 'Finish file read', exact: true })
        .evaluate((button: HTMLElement) => button.click());
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-rotate-ssh-certificate')?.value ===
            text,
        certificateFile,
    );
    await rotateButton.click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.deepEqual(calls.at(-1).args.secret_values, {
        privateKey: privateKeyFile,
        sshCertificate: certificateFile,
    });

    // Pending certificate imports block replacing AND removing an existing attachment.
    await page.getByRole('button', { name: 'Edit certificate fixture', exact: true }).click();
    await page.getByLabel('SSH user certificate (optional)').fill('previous certificate draft');
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    assert.equal(
        await page.getByRole('button', { name: 'Replace certificate', exact: true }).isDisabled(),
        true,
    );
    assert.equal(
        await page.getByRole('button', { name: 'Remove certificate', exact: true }).isDisabled(),
        true,
    );
    await page.getByRole('button', { name: 'Finish file read', exact: true }).click();
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-details-ssh-certificate')?.value ===
            text,
        certificateFile,
    );
    assert.equal(
        await page.getByRole('button', { name: 'Remove certificate', exact: true }).isDisabled(),
        false,
    );
    await page.getByRole('button', { name: 'Replace certificate', exact: true }).click();
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLTextAreaElement>('#vault-details-ssh-certificate')?.value ===
            '',
    );
    calls = await page.evaluate(() => JSON.parse(document.body.dataset.calls || '[]'));
    assert.equal(calls.at(-1).args.certificate, certificateFile);
    await page.getByRole('button', { name: 'Remove certificate', exact: true }).click();
    await page.getByText('SSH certificate · Not attached', { exact: true }).waitFor();
    await page.getByLabel('SSH user certificate (optional)').fill('new attachment draft');
    await page.getByRole('button', { name: 'Import SSH certificate file', exact: true }).click();
    assert.equal(
        await page.getByRole('button', { name: 'Attach certificate', exact: true }).isDisabled(),
        true,
    );
    await page.getByRole('button', { name: 'Finish file read', exact: true }).click();
    await page.waitForFunction(
        (text: string) =>
            document.querySelector<HTMLTextAreaElement>('#vault-details-ssh-certificate')?.value ===
            text,
        certificateFile,
    );
    await page.getByRole('button', { name: 'Attach certificate', exact: true }).click();
    await page.getByText('SSH certificate · Attached', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Vault SSH certificate browser regressions passed');
} finally {
    await browser?.close();
    await server?.close();
}
