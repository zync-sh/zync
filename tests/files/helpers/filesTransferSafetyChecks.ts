import type { Page } from 'playwright-core';
/** Exercise real FileManager conflict workflows; only native mutation outcomes are simulated. */
export async function runFilesTransferSafetyChecks({
    page,
    check,
}: {
    page: Page;
    check: (label: string, value: unknown) => void;
}) {
    const fixtureUrl = new URL(page.url());
    const snapshot = () => page.evaluate(() => window.filesTransferSafety.snapshot());
    const modal = page.getByRole('dialog', { name: 'File Name Collision', exact: true });
    const open = async ({
        names = ['README.md'],
        cut = false,
        sameEndpoint = false,
        cleanupFailure = false,
        sameTarget = false,
        nativeFiles = false,
        dottedPath = false,
        folder = false,
    } = {}) => {
        const url = new URL(fixtureUrl);
        url.searchParams.set('transferSafety', '1');
        if (dottedPath) {
            url.searchParams.set('transferDottedPath', '1');
        }
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.getByRole('listbox').waitFor();
        await page.evaluate(
            ({ names, cut, sameEndpoint, cleanupFailure, sameTarget, nativeFiles, folder }) => {
                if (nativeFiles) {
                    window.filesTransferSafety.nativeFiles();
                }
                window.filesTransferSafety.stage(
                    names,
                    cut ? 'cut' : 'copy',
                    sameEndpoint,
                    sameTarget ? window.filesTransferSafety.snapshot().rootPath : undefined,
                    folder ? 'd' : undefined,
                );
                if (cleanupFailure) {
                    window.filesTransferSafety.cleanupFailure();
                }
            },
            { names, cut, sameEndpoint, cleanupFailure, sameTarget, nativeFiles, folder },
        );
        await page.getByRole('listbox').focus();
        await page.keyboard.press('Control+V');
        await modal.waitFor();
    };
    const overwrite = async ({ twice = false, pendingCount = 1 } = {}) => {
        const choice = modal.getByRole('button', { name: /^(Overwrite|Replace folder)/ });
        if (twice) {
            await choice.evaluate((button: HTMLButtonElement) => {
                button.click();
                button.click();
            });
        } else {
            await choice.click();
        }
        await page.waitForFunction(
            (count) => window.filesTransferSafety.snapshot().pending.length >= count,
            pendingCount,
        );
    };
    const finish = async (outcome: boolean | 'cancelled', indexOrId: number | string = 0) => {
        const before = await snapshot();
        const write =
            typeof indexOrId === 'number'
                ? before.writes[indexOrId]
                : before.writes.find(
                      (write) => write.id === indexOrId || write.transferId === indexOrId,
                  )!;
        if (!write) {
            throw new Error('Expected a pending native write to settle');
        }
        await page.evaluate(
            ({ outcome, indexOrId }) => window.filesTransferSafety.settle(outcome, indexOrId),
            { outcome, indexOrId },
        );
        await page.waitForFunction(
            ({ outcome, destination, transferId, messageCount }) => {
                const state = window.filesTransferSafety.snapshot();
                const messages = state.messages.slice(messageCount);
                if (outcome === true) {
                    return (
                        !Object.keys(state.files).some((path) =>
                            path.startsWith(`${destination}.zync-backup-`),
                        ) ||
                        messages.some(
                            (message) =>
                                message.type === 'warning' && message.message.includes('backup'),
                        )
                    );
                }
                const transfer = state.transfers.find((transfer) => transfer.id === transferId)!;
                return (
                    (transfer && ['failed', 'cancelled'].includes(transfer.status)) ||
                    messages.some((message) => message.type === 'error')
                );
            },
            {
                outcome,
                destination: write.destination,
                transferId: write.transferId,
                messageCount: before.messages.length,
            },
        );
        await page.evaluate(
            () =>
                new Promise<number>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        );
    };
    const backups = (state: Awaited<ReturnType<typeof snapshot>>) =>
        Object.entries(state.files).filter(([path]) => path.includes('.zync-backup-'));
    const backupPath = (state: Awaited<ReturnType<typeof snapshot>>) =>
        backups(state)[0]?.[0].slice(state.host.length + 1);
    const openReceipts = async () => {
        await page.getByRole('button', { name: 'Transfer receipts', exact: true }).click();
        await page
            .getByRole('button', { name: 'Transfer receipts', exact: true, expanded: true })
            .waitFor();
        await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
    };
    const closeReceipts = async () => {
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page
            .getByRole('button', { name: 'Transfer receipts', exact: true, expanded: false })
            .waitFor();
        await page.getByRole('button', { name: 'Close', exact: true }).waitFor({ state: 'hidden' });
    };

    check(
        'native mutation simulation is unavailable without the explicit test query',
        await page.evaluate(async () => {
            if (window.filesTransferSafety !== undefined) {
                return false;
            }
            try {
                await window.ipcRenderer.invoke('fs_delete', {
                    connectionId: 'files-ui-fixture',
                    path: '/not-a-real-file',
                });
                return false;
            } catch (error) {
                return String(error).includes('Unexpected native operation');
            }
        }),
    );

    const mixedUrl = new URL(fixtureUrl);
    mixedUrl.searchParams.set('transferSafety', '1');
    await page.goto(mixedUrl.href, { waitUntil: 'domcontentloaded' });
    await page.getByRole('listbox').waitFor();
    const readsBeforeFailure = await page.evaluate(() => {
        const state = window.filesTransferSafety.snapshot();
        window.filesTransferSafety.stage(['README.md', 'package.json'], 'copy', true);
        window.filesTransferSafety.reportMissingOnce(`${state.rootPath}/README.md`);
        return window.filesUiTest.listingReads.length;
    });
    await page.getByRole('listbox').focus();
    await page.keyboard.press('Control+V');
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().pending.length === 1);
    await page.evaluate(() => window.filesTransferSafety.settle(false));
    await modal.waitFor();
    check(
        'an immediate paste failure refreshes the listing and still exposes queued collisions',
        (await modal
            .getByText('An item named "package.json" already exists.', { exact: true })
            .isVisible()) &&
            (await page.evaluate(() => window.filesUiTest.listingReads.length)) >
                readsBeforeFailure,
    );
    await modal.getByRole('button', { name: /^Skip/ }).click();
    await modal.waitFor({ state: 'hidden' });

    await open();
    await overwrite({ twice: true });
    await modal.waitFor({ state: 'hidden' });
    const pending = await snapshot();
    check(
        'real conflict overwrite explicitly awaits the native terminal result',
        pending.calls.some(
            (call) => call.command === 'sftp_put' && call.args.waitForCompletion === true,
        ),
    );
    check(
        'deferred replacement keeps original content in a recovery backup',
        backups(pending).length === 1 && backups(pending)[0][1] === 'original:README.md',
    );
    check(
        'a running replacement cannot remove a backup or report success at admission',
        !pending.calls.some((call) => call.command === 'fs_delete') &&
            !pending.messages.some((message) => message.type === 'success') &&
            pending.transfers[0].status === 'pending',
    );
    check(
        'accepting a single conflict closes its decision dialog while the write remains pending',
        pending.pending.length === 1 && (await modal.count()) === 0,
    );
    check(
        'duplicate activation of one accepted choice cannot start another write',
        pending.calls.filter((call) => call.command === 'sftp_put').length === 1 &&
            pending.calls.filter((call) => call.command === 'fs_rename').length === 1,
    );
    await page.locator('[data-file-name="docs"]').dblclick();
    await page
        .getByRole('navigation', { name: 'Folder path', exact: true })
        .getByRole('button', { name: 'docs', exact: true })
        .waitFor();
    const browsedWhilePending = await snapshot();
    check(
        'an unresolved native write does not trap browsing behind a collision modal',
        browsedWhilePending.pending.length === 1 &&
            browsedWhilePending.currentPath[browsedWhilePending.host] ===
                `${browsedWhilePending.rootPath}/docs`,
    );
    await finish(true);
    const completed = await snapshot();
    check(
        'confirmed replacement removes its backup and commits one successful outcome',
        backups(completed).length === 0 &&
            completed.transfers[0].status === 'completed' &&
            completed.messages.length === 0,
    );

    await open();
    await overwrite();
    await modal.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.filesTransferSafety.stage(['README.md']));
    await page.getByRole('listbox').focus();
    await page.keyboard.press('Control+V');
    await modal.waitFor();
    await modal.getByRole('button', { name: /^Overwrite/ }).click();
    await modal.waitFor({ state: 'hidden' });
    await page.waitForFunction(() =>
        window.filesTransferSafety
            .snapshot()
            .messages.some(
                (message) =>
                    message.type === 'error' && message.message.includes('Destination is busy'),
            ),
    );
    const busyOverwrite = await snapshot();
    check(
        'a second overwrite of an active destination rejects before another backup or native write',
        busyOverwrite.pending.length === 1 &&
            busyOverwrite.calls.filter((call) => call.command === 'fs_rename').length === 1 &&
            busyOverwrite.calls.filter((call) => call.command === 'sftp_put').length === 1,
    );
    check(
        'rejecting a busy overwrite keeps the first operation original recovery backup',
        backups(busyOverwrite).length === 1 &&
            backups(busyOverwrite)[0][1] === 'original:README.md',
    );

    await page.evaluate(() => {
        const state = window.filesTransferSafety.snapshot();
        window.filesTransferSafety.stage(['README.md']);
        window.filesTransferSafety.reportMissingOnce(`${state.rootPath}/README.md`);
    });
    await page.getByRole('listbox').focus();
    await page.keyboard.press('Control+V');
    await page.waitForFunction(() =>
        window.filesTransferSafety
            .snapshot()
            .transfers.some(
                (transfer) =>
                    transfer.status === 'failed' && transfer.error?.includes('Destination is busy'),
            ),
    );
    const busyOrdinaryCopy = await snapshot();
    check(
        'ordinary copy admission cannot bypass an active replacement through an absent stat result',
        busyOrdinaryCopy.pending.length === 1 &&
            busyOrdinaryCopy.calls.filter((call) => call.command === 'sftp_put').length === 1 &&
            (await modal.count()) === 0,
    );
    await openReceipts();
    check(
        'a rejected ordinary copy keeps its truthful busy error in the real receipt surface',
        (await page.getByText(/^Destination is busy:/).count()) === 1,
    );
    await closeReceipts();
    await finish(true);
    const released = await snapshot();
    check(
        'only the owning operation can finish and remove its original backup',
        backups(released).length === 0 &&
            released.files[`${released.host}:${released.rootPath}/README.md`] === 'replacement',
    );
    await page.evaluate(() => window.filesTransferSafety.stage(['README.md']));
    await page.getByRole('listbox').focus();
    await page.keyboard.press('Control+V');
    await modal.waitFor();
    await overwrite();
    await modal.waitFor({ state: 'hidden' });
    check(
        'the same destination becomes usable again after the owning workflow releases it',
        (await snapshot()).calls.filter((call) => call.command === 'sftp_put').length === 2,
    );
    await finish(true);

    await open({ cut: true });
    await overwrite();
    await finish(false);
    const failed = await snapshot();
    check(
        'a failed real overwrite preserves both original backup and uncertain destination',
        backups(failed).length === 1 &&
            backups(failed)[0][1] === 'original:README.md' &&
            failed.files[`${failed.host}:${failed.rootPath}/README.md`] === 'partial',
    );
    check(
        'failure never blindly restores over the destination or emits a success receipt',
        !failed.calls.some(
            (call) =>
                call.command === 'fs_rename' &&
                (call.args.oldPath as string).includes('.zync-backup-'),
        ) &&
            !failed.calls.some((call) => call.command === 'fs_delete') &&
            !failed.messages.some((message) => message.type === 'success'),
    );
    check(
        'the retained failure includes native detail and actionable backup location',
        failed.transfers[0].status === 'failed' &&
            failed.messages.some(
                (message) =>
                    message.type === 'error' &&
                    message.message.includes('Fixture destination write failed') &&
                    message.message.includes(backups(failed)[0][0].slice(failed.host.length + 1)),
            ),
    );
    check(
        'an unsuccessful cross-endpoint cut keeps its source clipboard',
        failed.clipboard?.op === 'cut' && failed.clipboard.sourceConnectionId === 'local',
    );
    await openReceipts();
    check(
        'the real failed receipt shows the native error, destination and original backup',
        (await page.getByText('Fixture destination write failed', { exact: true }).count()) === 1 &&
            (await page
                .getByText(`Destination: ${failed.rootPath}/README.md`, { exact: true })
                .count()) === 1 &&
            (await page
                .getByText(`Original recovery backup: ${backupPath(failed)}`, { exact: true })
                .count()) === 1,
    );
    await closeReceipts();
    await openReceipts();
    check(
        'reopening the real transfer panel retains failure recovery details beyond a transient toast',
        await page
            .getByText(`Original recovery backup: ${backupPath(failed)}`, { exact: true })
            .isVisible(),
    );
    await closeReceipts();

    await open();
    await overwrite();
    await modal.waitFor({ state: 'hidden' });
    await openReceipts();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByText('Waiting for transfer to stop…', { exact: true }).waitFor();
    check(
        'the real Cancel control records intent without claiming the write already stopped',
        (await snapshot()).transfers[0].status === 'cancelling' &&
            (await snapshot()).pending.length === 1,
    );
    check(
        'cancelling a transfer does not open a delete confirmation',
        (await page.getByRole('dialog').count()) === 0,
    );
    await finish('cancelled');
    const cancelled = await snapshot();
    check(
        'confirmed cancellation preserves uncertain output and the original recovery backup',
        cancelled.transfers[0].status === 'cancelled' &&
            cancelled.files[`${cancelled.host}:${cancelled.rootPath}/README.md`] === 'partial' &&
            backups(cancelled).length === 1,
    );
    check(
        'a cancelled receipt explicitly describes incomplete destination output and its backup',
        (await page
            .getByText('Check the destination; incomplete output may remain.', { exact: true })
            .count()) === 1 &&
            (await page
                .getByText(`Original recovery backup: ${backupPath(cancelled)}`, { exact: true })
                .isVisible()),
    );
    await closeReceipts();
    await openReceipts();
    check(
        'cancelled recovery details remain available after closing and reopening the panel',
        (await page.getByText('Cancelled', { exact: true }).count()) === 1 &&
            (await page
                .getByText(`Original recovery backup: ${backupPath(cancelled)}`, { exact: true })
                .isVisible()),
    );
    await closeReceipts();

    await open({ cut: true, sameEndpoint: true, sameTarget: true });
    await modal.getByRole('button', { name: /^Overwrite/ }).click();
    await modal.waitFor({ state: 'hidden' });
    const selfReplacement = await snapshot();
    check(
        'overwriting the exact same source rejects before any rename or write',
        selfReplacement.calls.every((call) =>
            ['fs_exists', 'fs_entry_kind'].includes(call.command),
        ) && selfReplacement.pending.length === 0,
    );
    check(
        'self-overwrite leaves the original at its exact path without a recovery rename',
        backups(selfReplacement).length === 0 &&
            selfReplacement.files[
                `${selfReplacement.host}:${selfReplacement.rootPath}/README.md`
            ] === 'original:README.md',
    );
    check(
        'self-overwrite gives a truthful unchanged-path explanation and retains the cut source',
        selfReplacement.messages.some(
            (message) => message.type === 'error' && message.message.includes('paths overlap'),
        ) &&
            !selfReplacement.messages.some((message) => message.type === 'success') &&
            selfReplacement.clipboard?.files[0].path === `${selfReplacement.rootPath}/README.md`,
    );

    await open({ names: ['README.md', 'package.json'], cut: true, sameEndpoint: true });
    await overwrite();
    await modal
        .getByText('An item named "package.json" already exists.', { exact: true })
        .waitFor();
    check(
        'the next unresolved conflict is enabled while the accepted first write is still pending',
        (await modal.getByRole('button', { name: /^Overwrite/ }).isEnabled()) &&
            (await snapshot()).pending.length === 1,
    );
    await finish(false);
    const failedFirst = await snapshot();
    check(
        'a failed first conflict retains both pending cut sources while showing the next choice',
        failedFirst.clipboard?.files.length === 2 &&
            failedFirst.messages.some((message) => message.type === 'error') &&
            failedFirst.pending.length === 0,
    );
    await overwrite();
    await finish(true);
    const mixedBatch = await snapshot();
    check(
        'a later successful cut acknowledges only its source, retaining the earlier failure',
        mixedBatch.clipboard?.op === 'cut' &&
            mixedBatch.clipboard.files.length === 1 &&
            mixedBatch.clipboard.files[0].path === '/fixture/incoming/README.md',
    );
    check(
        'mixed outcomes preserve the failed source and backup but move the successful source',
        mixedBatch.files[`${mixedBatch.host}:/fixture/incoming/README.md`] ===
            'incoming:README.md' &&
            mixedBatch.files[`${mixedBatch.host}:/fixture/incoming/package.json`] === undefined &&
            backups(mixedBatch).length === 1 &&
            backups(mixedBatch)[0][1] === 'original:README.md',
    );

    await open({ names: ['.env', 'archive.tar.gz'], sameEndpoint: true, dottedPath: true });
    await modal.getByRole('checkbox').check();
    await modal.getByRole('button', { name: /^Keep Both/ }).click();
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().pending.length === 1);
    const dotted = await snapshot();
    check(
        'Keep Both preserves dotfiles and a dotted parent folder',
        dotted.writes[0].destination === `${dotted.host}:${dotted.rootPath}/.env (1)`,
    );
    await page.evaluate(() => window.filesTransferSafety.settle(true));
    await page.waitForFunction(
        () =>
            window.filesTransferSafety.snapshot().pending.length === 1 &&
            window.filesTransferSafety.snapshot().writes[0].destination.includes('archive'),
    );
    const archiveName = await snapshot();
    check(
        'Keep Both splits only the filename extension, not the parent path',
        archiveName.writes[0].destination ===
            `${archiveName.host}:${archiveName.rootPath}/archive.tar (1).gz`,
    );
    await page.evaluate(() => window.filesTransferSafety.settle(true));
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().pending.length === 0);

    for (const cut of [true, false]) {
        await open({ names: ['README.md', 'package.json'], cut, sameEndpoint: true });
        await modal.getByRole('checkbox').check();
        await modal.getByRole('button', { name: /^Keep Both/ }).click();
        await page.waitForFunction(
            () => window.filesTransferSafety.snapshot().pending.length === 1,
        );
        await page.evaluate(() => window.filesTransferSafety.settle(false));
        await page.waitForFunction(
            () =>
                window.filesTransferSafety.snapshot().pending.length === 1 &&
                window.filesTransferSafety
                    .snapshot()
                    .writes[0].destination.includes('package (1).json'),
        );
        check(
            `same-connection Keep Both ${cut ? 'move' : 'copy'} continues after an earlier failure`,
            (await snapshot()).messages.length === 0,
        );
        await page.evaluate(() => window.filesTransferSafety.settle(true));
        await page.waitForFunction(() =>
            window.filesTransferSafety
                .snapshot()
                .messages.some((message) => message.type === 'error'),
        );
        const kept = await snapshot();
        check(
            `same-connection Keep Both ${cut ? 'move' : 'copy'} retains the first failure and completes later items`,
            kept.pending.length === 0 &&
                kept.messages.filter((message) => message.type === 'error').length === 1 &&
                kept.messages[0].message.includes('Fixture destination write failed') &&
                kept.files[`${kept.host}:${kept.rootPath}/package (1).json`] === 'replacement' &&
                kept.files[`${kept.host}:/fixture/incoming/README.md`] === 'incoming:README.md' &&
                (!cut ||
                    (kept.clipboard!.files.length === 1 &&
                        kept.clipboard!.files[0].name === 'README.md')),
        );
    }

    await open({ names: ['README.md', 'package.json'] });
    await modal.getByRole('button', { name: /^Overwrite/ }).dblclick();
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().pending.length === 1);
    await modal
        .getByText('An item named "package.json" already exists.', { exact: true })
        .waitFor();
    check(
        'a real double-click accepts only one decision rather than the next queued file',
        (await snapshot()).calls.filter((call) => call.command === 'sftp_put').length === 1 &&
            (await modal.getByRole('button', { name: /^Overwrite/ }).isEnabled()),
    );
    await modal.getByRole('button', { name: /^Cancel(?: All)?$/ }).click();
    await modal.waitFor({ state: 'hidden' });
    await finish(true);

    await open({ names: ['README.md', 'package.json'], cut: true, sameEndpoint: true });
    await overwrite();
    await modal
        .getByText('An item named "package.json" already exists.', { exact: true })
        .waitFor();
    await overwrite({ pendingCount: 2 });
    await modal.waitFor({ state: 'hidden' });
    const concurrent = await snapshot();
    const firstWrite = concurrent.writes.find((write) => write.destination.endsWith('/README.md'))!;
    const secondWrite = concurrent.writes.find((write) =>
        write.destination.endsWith('/package.json'),
    )!;
    check(
        'independent accepted choices can remain pending together without retaining a collision dialog',
        concurrent.pending.length === 2 && (await modal.count()) === 0,
    );
    await finish(true, secondWrite.id);
    const secondFirst = await snapshot();
    check(
        'out-of-order success acknowledges only the completed cut source',
        secondFirst.pending.length === 1 &&
            secondFirst.clipboard?.files.length === 1 &&
            secondFirst.clipboard.files[0].name === 'README.md',
    );
    await finish(false, firstWrite.id);
    check(
        'a later failed outcome retains its source without resurrecting a resolved queue',
        (await snapshot()).clipboard?.files[0].name === 'README.md' && (await modal.count()) === 0,
    );

    for (const decision of ['Skip', 'Cancel']) {
        await open({ names: ['README.md', 'package.json'] });
        await overwrite();
        await modal
            .getByText('An item named "package.json" already exists.', { exact: true })
            .waitFor();
        await modal
            .getByRole('button', { name: decision === 'Skip' ? /^Skip/ : /^Cancel(?: All)?$/ })
            .click();
        await modal.waitFor({ state: 'hidden' });
        const queueDismissed = await snapshot();
        check(
            `${decision} affects only unresolved choices, not an already accepted write`,
            queueDismissed.pending.length === 1 &&
                queueDismissed.calls.filter((call) => call.command === 'sftp_put').length === 1,
        );
        await finish(true);
        const continued = await snapshot();
        check(
            `the accepted write can complete after ${decision.toLowerCase()} without touching the skipped destination`,
            continued.files[`${continued.host}:${continued.rootPath}/README.md`] ===
                'replacement' &&
                continued.files[`${continued.host}:${continued.rootPath}/package.json`] ===
                    'original:package.json',
        );
    }

    await open({ names: ['README.md', 'package.json'] });
    await modal.getByRole('checkbox').check();
    await overwrite({ twice: true });
    await modal.waitFor({ state: 'hidden' });
    check(
        'applying one decision to all closes the queue while native work remains pending',
        (await snapshot()).pending.length > 0 && (await modal.count()) === 0,
    );
    await finish(true);
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().pending.length > 0);
    await finish(true);
    const allAccepted = await snapshot();
    const submittedDestinations = allAccepted.calls
        .filter((call) => call.command === 'sftp_put')
        .map((call) => call.args.remotePath);
    check(
        'apply-to-all submits each accepted source exactly once even after duplicate activation',
        submittedDestinations.length === 2 &&
            new Set(submittedDestinations).size === 2 &&
            allAccepted.pending.length === 0 &&
            backups(allAccepted).length === 0,
    );

    await open();
    await overwrite();
    await modal.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.filesTransferSafety.stage(['package.json']));
    await page.getByRole('listbox').focus();
    await page.keyboard.press('Control+V');
    await modal
        .getByText('An item named "package.json" already exists.', { exact: true })
        .waitFor();
    await finish(true);
    const newerDecision = await snapshot();
    check(
        'an old background completion cannot close a newly opened conflict decision',
        (await modal.isVisible()) &&
            (await modal.getByRole('button', { name: /^Overwrite/ }).isEnabled()) &&
            newerDecision.clipboard?.files[0].name === 'package.json',
    );
    await modal.getByRole('button', { name: /^Cancel(?: All)?$/ }).click();
    await modal.waitFor({ state: 'hidden' });

    await open({ cleanupFailure: true });
    await overwrite();
    await finish(true);
    const cleanup = await snapshot();
    check(
        'backup cleanup failure does not reclassify a confirmed copy as failed',
        cleanup.transfers[0].status === 'completed' &&
            backups(cleanup).length === 1 &&
            cleanup.files[`${cleanup.host}:${cleanup.rootPath}/README.md`] === 'replacement',
    );
    check(
        'cleanup failure is surfaced as a warning with recovery path',
        cleanup.messages.some(
            (message) =>
                message.type === 'warning' &&
                message.message.includes('Fixture backup cleanup denied') &&
                message.message.includes('.zync-backup-'),
        ),
    );
    await page.clock.install();
    await openReceipts();
    check(
        'the real completed receipt distinguishes cleanup attention from a failed copy',
        (await page
            .getByText('Transfer complete; cleanup needs attention', { exact: true })
            .isVisible()) &&
            (await page
                .getByText(`Original recovery backup: ${backupPath(cleanup)}`, { exact: true })
                .isVisible()),
    );
    await page.clock.fastForward(6000);
    check(
        'a completed receipt with an unresolved backup does not expire with ordinary success receipts',
        (await snapshot()).transfers[0]?.status === 'completed' &&
            (await page
                .getByText('Transfer complete; cleanup needs attention', { exact: true })
                .isVisible()),
    );
    await closeReceipts();
    await openReceipts();
    check(
        'cleanup warnings and original backup paths survive panel close and reopen',
        (await page
            .getByText('Could not remove the original backup: Fixture backup cleanup denied', {
                exact: true,
            })
            .count()) === 1 &&
            (await page
                .getByText(`Original recovery backup: ${backupPath(cleanup)}`, { exact: true })
                .isVisible()),
    );
    await closeReceipts();

    await open();
    await page.evaluate(() => {
        const state = window.filesTransferSafety.snapshot();
        return window.filesTransferSafety.navigate(`${state.rootPath}/docs`);
    });
    await page
        .getByRole('navigation', { name: 'Folder path', exact: true })
        .getByRole('button', { name: 'docs', exact: true })
        .waitFor();
    const queuedAtNewLocation = await snapshot();
    check(
        'a queued conflict describes its captured destination after browsing elsewhere',
        (await modal.getByText(queuedAtNewLocation.rootPath, { exact: true }).count()) === 1,
    );
    check(
        'navigating with a queued conflict does not begin any native mutation',
        queuedAtNewLocation.calls.every((call) =>
            ['fs_exists', 'fs_entry_kind'].includes(call.command),
        ) &&
            queuedAtNewLocation.pending.length === 0 &&
            backups(queuedAtNewLocation).length === 0,
    );

    await open();
    await overwrite();
    await page.evaluate(() => {
        const state = window.filesTransferSafety.snapshot();
        return window.filesTransferSafety.navigate(`${state.rootPath}/docs`);
    });
    const runningAtNewLocation = await snapshot();
    check(
        'a background replacement remains bound to its original destination without a decision dialog',
        runningAtNewLocation.writes[0].destination ===
            `${runningAtNewLocation.host}:${runningAtNewLocation.rootPath}/README.md` &&
            (await modal.count()) === 0,
    );
    await finish(true);
    const navigated = await snapshot();
    check(
        'late completion refreshes the current folder without restoring the original destination',
        navigated.currentPath[navigated.host] === `${navigated.rootPath}/docs`,
    );
    check(
        'the live breadcrumb keeps the user-selected folder after completion',
        (await page
            .getByRole('navigation', { name: 'Folder path', exact: true })
            .getByRole('button', { name: 'docs', exact: true })
            .count()) === 1,
    );

    await open({ names: ['README.md', 'package.json'] });
    check(
        'the real conflict modal starts with a queued batch',
        (await modal.getByRole('checkbox').count()) === 1,
    );
    await page.evaluate(() => window.filesTransferSafety.switchEndpoint());
    await modal.waitFor({ state: 'hidden' });
    const switched = await snapshot();
    check(
        'changing endpoints clears the previous endpoint conflict queue without mutating it',
        switched.calls.every((call) => ['fs_exists', 'fs_entry_kind'].includes(call.command)) &&
            switched.activeConnectionId === switched.secondHost &&
            switched.currentPath[switched.secondHost] === switched.secondPath,
    );

    await open({ names: ['README.md', 'package.json'], cut: true, sameEndpoint: true });
    await overwrite();
    await page.evaluate(() => {
        window.filesTransferSafety.switchEndpoint();
        window.filesTransferSafety.replaceClipboard();
    });
    await modal.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.filesTransferSafety.settle(true));
    await page.waitForFunction(() =>
        window.filesTransferSafety.snapshot().calls.some((call) => call.command === 'fs_delete'),
    );
    // Flush the completed operation's promise continuations and React's next publication.
    await page.evaluate(
        () =>
            new Promise<number>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
    );
    const stale = await snapshot();
    check(
        'an old completion cannot clear the new clipboard or re-open the old queued conflict',
        stale.clipboard?.files[0].name === 'fresh-choice.txt' &&
            stale.activeConnectionId === stale.secondHost &&
            (await modal.count()) === 0,
    );
    check(
        'an old completion cannot navigate or mutate the newly active endpoint',
        stale.currentPath[stale.secondHost] === stale.secondPath &&
            stale.calls.every((call) => call.args.connectionId !== stale.secondHost),
    );

    for (const sameEndpoint of [false, true]) {
        for (const outcome of [true, false, 'cancelled'] as const) {
            await open({ nativeFiles: true, folder: true, names: ['docs'], sameEndpoint });
            check(
                'folder collision warns that replacement removes destination-only items',
                await modal
                    .getByText(
                        'Replace the entire folder. Items only in the destination will be removed.',
                        { exact: true },
                    )
                    .isVisible(),
            );
            await overwrite();
            await modal.waitFor({ state: 'hidden' });
            const active = await snapshot();
            const target = `${active.host}:${active.rootPath}/docs`;
            check(
                'folder replacement keeps the original visible while native staging runs',
                active.files[target] === 'original:docs',
            );
            check(
                'folder replacement never renames the original in the renderer',
                !active.calls.some((call) =>
                    ['fs_rename', 'fs_delete', 'sftp_put'].includes(call.command),
                ),
            );
            check(
                'folder replacement owns one shared native job',
                active.calls.filter((call) => call.command === 'fs_transfer_file').length === 1 &&
                    active.transfers.length === 1,
            );
            await finish(outcome);
            const done = await snapshot();
            check(
                'folder outcome retains original on failure or cancellation',
                done.files[target] === (outcome === true ? 'replacement' : 'original:docs'),
            );
            check(
                'folder outcome uses existing transfer status and recovery UI',
                done.transfers[0].status ===
                    (outcome === true
                        ? 'completed'
                        : outcome === 'cancelled'
                          ? 'cancelled'
                          : 'failed'),
            );
        }
    }

    for (const sameEndpoint of [false, true]) {
        await open({ nativeFiles: true, folder: true, names: ['docs'], sameEndpoint });
        check(
            'folder conflicts distinguish Combine from destructive Replace',
            (await modal.getByRole('button', { name: /^Combine folders/ }).isVisible()) &&
                (await modal.getByRole('button', { name: /^Replace folder/ }).isVisible()),
        );
        check(
            'Combine explains matching-file replacement and preserves destination-only items',
            await modal
                .getByText(
                    'Add incoming items and replace matching files. Other existing items are kept.',
                    { exact: true },
                )
                .isVisible(),
        );
        await modal.getByRole('button', { name: /^Combine folders/ }).click();
        await page.waitForFunction(
            () => window.filesTransferSafety.snapshot().pending.length === 1,
        );
        await modal.waitFor({ state: 'hidden' });
        const active = await snapshot();
        check(
            'Combine selects the shared native mode without renderer mutation',
            active.calls.filter((call) => call.command === 'fs_transfer_file').length === 1 &&
                active.calls.find((call) => call.command === 'fs_transfer_file')!.args
                    .folderMode === 'combine' &&
                !active.calls.some((call) =>
                    ['fs_rename', 'fs_delete', 'sftp_put'].includes(call.command),
                ),
        );
        await finish(true);
        check(
            'Combine completes one aggregate transfer',
            (await snapshot()).transfers[0].status === 'completed',
        );
    }
    await open({ nativeFiles: true, names: ['docs', 'README.md'] });
    await modal.getByRole('checkbox').check();
    await modal.getByRole('button', { name: /^Combine folders/ }).click();
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().pending.length === 1);
    check(
        'Combine apply-to-all leaves file conflicts queued and untouched',
        (await modal
            .getByText('An item named "README.md" already exists.', { exact: true })
            .isVisible()) &&
            (await snapshot()).calls.filter((call) => call.command === 'fs_transfer_file')
                .length === 1,
    );
    await finish(true);
    await modal.getByRole('button', { name: /^Skip/ }).click();
    await modal.waitFor({ state: 'hidden' });
    await open({ nativeFiles: true, names: ['docs'], cut: true, sameEndpoint: true, folder: true });
    check(
        'same-endpoint moves do not silently become copy-and-delete combines',
        (await modal.getByRole('button', { name: /^Combine folders/ }).count()) === 0,
    );
    await modal.getByRole('button', { name: /^Cancel/ }).click();

    {
        const url = new URL(fixtureUrl);
        url.searchParams.set('transferSafety', '1');
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.getByRole('listbox').waitFor();
        await page.evaluate(() => {
            window.filesTransferSafety.nativeFiles();
            window.filesTransferSafety.prepareCopyTarget();
        });
        await page.locator('[data-file-name="docs"]').click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Copy to Server...', exact: true }).click();
        const server = page.getByRole('dialog', { name: 'Copy File to Server', exact: true });
        await server.getByLabel('Select Gateway', { exact: true }).click();
        await page.getByRole('option', { name: /Other test host/ }).click();
        await server.getByRole('button', { name: 'Start Transfer' }).click();
        await modal.waitFor();
        check(
            'Copy to Server reuses folder choices for its captured destination',
            await modal.getByRole('button', { name: /^Combine folders/ }).isVisible(),
        );
        await modal.getByRole('button', { name: /^Combine folders/ }).click();
        await page.waitForFunction(
            () => window.filesTransferSafety.snapshot().pending.length === 1,
        );
        const pending = await snapshot();
        const copy = pending.calls.find((call) => call.command === 'fs_transfer_file')!;
        check(
            'Copy to Server cannot redirect Combine into the source or currently active host',
            copy.args.destinationConnectionId === pending.secondHost &&
                copy.args.destinationPath === `${pending.secondPath}/docs` &&
                copy.args.sourceConnectionId === pending.host &&
                pending.activeConnectionId === pending.host,
        );
        await finish(true);
        check(
            'Copy to Server uses one outcome owner without routine transfer toasts',
            (await snapshot()).transfers.length === 1 &&
                !(await snapshot()).messages.some((message) =>
                    message.message.includes('Starting transfer'),
                ),
        );
    }
    await open({ nativeFiles: true });
    check(
        'regular file conflicts do not offer folder combination',
        (await modal.getByRole('button', { name: /^Combine folders/ }).count()) === 0,
    );
    await page.evaluate(() => window.filesTransferSafety.preparationFailure());
    await modal.getByRole('button', { name: /^Overwrite/ }).click();
    await modal.waitFor({ state: 'hidden' });
    await page.waitForFunction(
        () => window.filesTransferSafety.snapshot().transfers[0]?.status === 'failed',
    );
    const preparation = await snapshot();
    check(
        'closed source preparation leaves the original and creates no staging write',
        preparation.files[`${preparation.host}:${preparation.rootPath}/README.md`] ===
            'original:README.md' &&
            preparation.writes.length === 0 &&
            !Object.keys(preparation.files).some((path) => path.includes('.zync-transfer-')),
    );
    check(
        'preparation failure toast does not promise unavailable recovery controls',
        preparation.messages.some(
            (message) =>
                message.type === 'error' &&
                message.message.includes('Copy did not start; destination unchanged.') &&
                !message.message.includes('recovery details') &&
                !message.message.includes('TRANSFER_NOT_STARTED:'),
        ),
    );
    await openReceipts();
    check(
        'preparation failure receipt explains the unchanged destination',
        await page.getByText(/^Copy did not start; destination unchanged\./).isVisible(),
    );
    check(
        'preparation failure does not show partial-output warnings or an unusable inspection button',
        (await page
            .getByRole('button', { name: 'Inspect recovery files', exact: true })
            .count()) === 0 &&
            (await page
                .getByText('Check the destination; incomplete output may remain.', { exact: true })
                .count()) === 0,
    );
    await closeReceipts();

    for (const outcome of [true, false, 'cancelled'] as const) {
        await open({ nativeFiles: true });
        await overwrite();
        await modal.waitFor({ state: 'hidden' });
        const pending = await snapshot();
        const target = `${pending.host}:${pending.rootPath}/README.md`;
        check(
            `native staged ${outcome} keeps original at its destination during copying`,
            pending.files[target] === 'original:README.md',
        );
        check(
            `native staged ${outcome} never performs renderer backup choreography`,
            !pending.calls.some((call) =>
                ['fs_rename', 'fs_delete', 'sftp_put'].includes(call.command),
            ),
        );
        const readsBeforeOutcome = await page.evaluate(
            () => window.filesUiTest.listingReads.length,
        );
        await page.evaluate((outcome) => window.filesTransferSafety.settle(outcome), outcome);
        await page.waitForFunction(() =>
            ['completed', 'failed', 'cancelled'].includes(
                window.filesTransferSafety.snapshot().transfers[0].status,
            ),
        );
        const after = await snapshot();
        check(
            `native staged ${outcome} projects its actual terminal receipt`,
            after.transfers[0].status ===
                (outcome === true ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed'),
        );
        check(
            `native staged ${outcome} only publishes a completed file`,
            after.files[target] === (outcome === true ? 'replacement' : 'original:README.md'),
        );
        check(
            `native staged ${outcome} refreshes the destination once without caller-level duplicate reads`,
            (await page.evaluate(() => window.filesUiTest.listingReads.length)) ===
                readsBeforeOutcome + 1,
        );
        if (outcome !== false) {
            check(
                `native staged ${outcome} has no routine start, success or cancellation toast`,
                after.messages.length === 0,
            );
        }
        await page.evaluate(() => window.filesTransferSafety.captureReceipts());
        if (outcome === 'cancelled') {
            check(
                'confirmed native cancellation removes only staging and leaves the original at its destination',
                after.transfers[0].stageCleaned === true &&
                    !Object.keys(after.files).some((path) => path.includes('.zync-transfer-')) &&
                    after.files[target] === 'original:README.md',
            );
            await openReceipts();
            check(
                'a clean cancellation confirms no temporary copy remains without unnecessary recovery controls',
                (await page.getByText('No temporary copy remains.', { exact: true }).isVisible()) &&
                    (await page
                        .getByRole('button', { name: 'Inspect recovery files', exact: true })
                        .count()) === 0,
            );
            await page.evaluate(() => window.filesTransferSafety.dismissFailure(true));
            await page.getByRole('button', { name: 'Remove', exact: true }).click();
            await page.waitForFunction(
                () =>
                    window.filesTransferSafety.snapshot().lastAction?.message ===
                    'Could not dismiss the saved transfer receipt',
            );
            check(
                'a failed native dismissal keeps its receipt visible for retry',
                (await snapshot()).transfers.length === 1 &&
                    (await page
                        .getByText('No temporary copy remains.', { exact: true })
                        .isVisible()),
            );
            await page.evaluate(() => window.filesTransferSafety.dismissFailure(false));
            await page.getByRole('button', { name: 'Remove', exact: true }).click();
            await page.waitForFunction(
                () => window.filesTransferSafety.snapshot().transfers.length === 0,
            );
            await page.evaluate(() => window.filesTransferSafety.restoreReceipts());
            check(
                'dismissing a clean cancellation also removes its saved receipt',
                (await snapshot()).transfers.length === 0,
            );
            await page.evaluate(() => window.filesTransferSafety.replayReceipts());
            check(
                'a late saved snapshot cannot resurrect a cleared cancellation',
                (await snapshot()).transfers.length === 0,
            );
            await closeReceipts();
        } else if (outcome === false) {
            await openReceipts();
            check(
                'unresolved recovery has the same clear button without a review gate',
                (await page.getByText('Needs review', { exact: true }).count()) === 0 &&
                    (await page.getByRole('button', { name: 'Remove', exact: true }).isVisible()) &&
                    (await page
                        .getByRole('button', { name: 'Dismiss reviewed recovery', exact: true })
                        .count()) === 0,
            );
            await page.clock.fastForward(6000);
            check('unresolved recovery does not expire', (await snapshot()).transfers.length === 1);
            check(
                `native staged ${outcome} shows unchanged target and separate temporary path`,
                (await page
                    .getByText('Destination left unchanged.', { exact: true })
                    .isVisible()) &&
                    (await page.getByText(/^Temporary copy:.*\.part$/).isVisible()),
            );
            check(
                `native staged ${outcome} does not repeat the generic unchanged-destination warning`,
                (await page
                    .getByText(
                        'Destination left unchanged. A separate staging file may remain; inspect it before cleanup.',
                        { exact: true },
                    )
                    .count()) === 0,
            );
            await page.getByRole('button', { name: 'Inspect recovery files', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Temporary copy: File' }).waitFor();
            check(
                `native staged ${outcome} inspection does not imply scheduled cleanup or question the untouched destination`,
                (await page
                    .getByText('Temporary copy retained; recovery review needed.', { exact: true })
                    .isVisible()) &&
                    (await page.getByText('Backup: Not present', { exact: true }).isVisible()) &&
                    (await page
                        .getByText(/Inspection does not prove which content should be kept/)
                        .count()) === 0 &&
                    (await page.getByText(/Replacement outcome is uncertain/).count()) === 0,
            );
            check(
                `native staged ${outcome} recovery inspection does not mutate files`,
                !(await snapshot()).calls.some((call) =>
                    ['fs_delete', 'fs_rename'].includes(call.command),
                ),
            );
            check(
                'an unconfirmed interrupted copy explains why removal is unavailable',
                (await page
                    .getByRole('button', { name: 'Remove temporary copy…', exact: true })
                    .count()) === 0 &&
                    (await page
                        .getByText(
                            'Writer completion was not recorded. No automatic cleanup is scheduled.',
                            { exact: true },
                        )
                        .isVisible()),
            );
            await closeReceipts();
            await page.evaluate(() => {
                // Simulate a new renderer projection, not a real app crash or native disk test.
                window.filesTransferSafety.resetTransferView();
                window.filesTransferSafety.restoreReceipts();
            });
            await openReceipts();
            check(
                `native staged ${outcome} restores recovery metadata from persisted receipt contract`,
                await page.getByText(/^Temporary copy:.*\.part$/).isVisible(),
            );
            const beforeClear = await snapshot();
            await page.getByRole('button', { name: 'Remove', exact: true }).click();
            await page.waitForFunction(
                () => window.filesTransferSafety.snapshot().transfers.length === 0,
            );
            await page.evaluate(() => {
                window.filesTransferSafety.resetTransferView();
                window.filesTransferSafety.restoreReceipts();
                window.filesTransferSafety.replayReceipts();
            });
            const afterClear = await snapshot();
            check(
                'clearing unresolved history stays cleared without deleting recovery files or requiring inspection',
                afterClear.transfers.length === 0 &&
                    JSON.stringify(afterClear.files) === JSON.stringify(beforeClear.files) &&
                    afterClear.calls.filter((call) => call.command === 'fs_transfer_dismiss')
                        .length === 1,
            );
            await closeReceipts();
        } else {
            await openReceipts();
            await page.clock.fastForward(6000);
            await page.waitForFunction(
                () => window.filesTransferSafety.snapshot().transfers.length === 0,
            );
            await page.evaluate(() => {
                window.filesTransferSafety.restoreReceipts();
                window.filesTransferSafety.replayReceipts();
            });
            const expired = await snapshot();
            check(
                'success expiry acknowledges saved history and ignores late snapshots',
                expired.transfers.length === 0 &&
                    expired.calls.filter((call) => call.command === 'fs_transfer_dismiss')
                        .length === 1,
            );
            check(
                'expiring success history never deletes destination files',
                expired.files[target] === 'replacement' &&
                    !expired.calls.some((call) => call.command === 'fs_delete'),
            );
            await closeReceipts();
        }
    }

    await open({ nativeFiles: true, names: ['README.md', 'package.json'] });
    await modal.getByRole('checkbox').check();
    await overwrite();
    await page.evaluate(() => window.filesTransferSafety.settle(false));
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().pending.length === 1);
    check(
        'an unfinished failing batch does not produce a per-file toast',
        (await snapshot()).messages.length === 0,
    );
    await page.evaluate(() => window.filesTransferSafety.settle(false));
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().messages.length === 1);
    const failedBatch = await snapshot();
    check(
        'multiple overwrite failures produce one batch error while retaining every recovery receipt',
        failedBatch.messages[0].type === 'error' &&
            failedBatch.messages[0].message.includes('2 items failed') &&
            failedBatch.transfers.length === 2 &&
            failedBatch.transfers.every(
                (transfer) => transfer.status === 'failed' && transfer.recoveryStagePath,
            ),
    );

    await open({ nativeFiles: true, cleanupFailure: true });
    await overwrite();
    await modal.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.filesTransferSafety.settle('cancelled'));
    await page.waitForFunction(
        () => window.filesTransferSafety.snapshot().transfers[0]?.status === 'cancelled',
    );
    const cleanupFailure = await snapshot();
    check(
        'failed cancellation cleanup retains staging and keeps the original unchanged',
        cleanupFailure.transfers[0].stageCleaned === false &&
            cleanupFailure.files[`${cleanupFailure.host}:${cleanupFailure.rootPath}/README.md`] ===
                'original:README.md' &&
            Object.keys(cleanupFailure.files).some((path) => path.includes('.zync-transfer-')),
    );
    await openReceipts();
    check(
        'failed cancellation cleanup keeps the actual error and read-only recovery inspection',
        (await page
            .getByText(/temporary-file cleanup could not be confirmed: Permission denied/)
            .isVisible()) &&
            (await page
                .getByRole('button', { name: 'Inspect recovery files', exact: true })
                .isVisible()) &&
            (await page.getByText('No temporary copy remains.', { exact: true }).count()) === 0,
    );
    await page.getByRole('button', { name: 'Inspect recovery files', exact: true }).click();
    await page.evaluate(() => window.filesUiTest.preference({ confirmDelete: true }));
    await page.getByRole('button', { name: 'Remove temporary copy…', exact: true }).click();
    const deleteConfirmation = page.getByRole('dialog', {
        name: 'Delete Confirmation',
        exact: true,
    });
    await deleteConfirmation.waitFor();
    check(
        'recovery uses the shared delete dialog, not a second inline confirmation',
        (await page.getByRole('dialog').count()) === 1 &&
            (await deleteConfirmation
                .getByRole('button', { name: 'Delete', exact: true })
                .isVisible()) &&
            (await page.getByRole('button', { name: 'Confirm removal', exact: true }).count()) ===
                0,
    );
    const temporaryPath = cleanupFailure.transfers[0].recoveryStagePath;
    await deleteConfirmation.getByText(temporaryPath!, { exact: true }).click();
    check(
        'the confirmation names only the temporary copy and keeps Transfers mounted',
        (await deleteConfirmation.getByText(/The destination will not be changed/).isVisible()) &&
            (await page
                .getByRole('button', { name: 'Transfer receipts', exact: true })
                .getAttribute('aria-expanded')) === 'true' &&
            !(await snapshot()).calls.some((call) => call.command === 'fs_transfer_cleanup'),
    );
    await deleteConfirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await deleteConfirmation.waitFor({ state: 'hidden' });
    check(
        'cancelling the shared dialog keeps the copy and Transfers open',
        !(await snapshot()).calls.some((call) => call.command === 'fs_transfer_cleanup') &&
            (await page
                .getByRole('button', { name: 'Inspect recovery files', exact: true })
                .isVisible()),
    );
    await page.getByRole('button', { name: 'Remove temporary copy…', exact: true }).click();
    await deleteConfirmation.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Escape');
    await deleteConfirmation.waitFor({ state: 'hidden' });
    check(
        'Escape dismisses only confirmation, not Transfers or recovery evidence',
        (await page
            .getByRole('button', { name: 'Inspect recovery files', exact: true })
            .isVisible()) &&
            !(await snapshot()).calls.some((call) => call.command === 'fs_transfer_cleanup'),
    );
    await page.getByRole('button', { name: 'Remove temporary copy…', exact: true }).click();
    await deleteConfirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await deleteConfirmation.waitFor({ state: 'hidden' });
    await page
        .getByText('Could not remove temporary copy: Permission denied', { exact: true })
        .waitFor();
    check(
        'a cleanup error retains recovery and requires fresh inspection',
        (await page
            .getByRole('button', { name: 'Remove temporary copy…', exact: true })
            .count()) === 0 &&
            Object.keys((await snapshot()).files).some((path) => path.includes('.zync-transfer-')),
    );
    await page.evaluate(() => window.filesUiTest.preference({ confirmDelete: false }));
    await page.getByRole('button', { name: 'Inspect recovery files', exact: true }).click();
    await page.getByRole('button', { name: 'Remove temporary copy…', exact: true }).click();
    await page
        .getByText('Could not remove temporary copy: Permission denied', { exact: true })
        .waitFor();
    check(
        'disabled delete confirmation skips the dialog but not native cleanup checks',
        (await deleteConfirmation.count()) === 0 &&
            Object.keys((await snapshot()).files).some((path) => path.includes('.zync-transfer-')),
    );
    await page.evaluate(() => window.filesTransferSafety.allowCleanup());
    await page.evaluate(() => window.filesTransferSafety.captureReceipts());
    await page.getByRole('button', { name: 'Inspect recovery files', exact: true }).click();
    await page.getByRole('button', { name: 'Remove temporary copy…', exact: true }).click();
    await page.waitForFunction(() => window.filesTransferSafety.snapshot().transfers.length === 0);
    await page.evaluate(() => window.filesTransferSafety.restoreReceipts());
    const recovered = await snapshot();
    check(
        'verified recovery removes only the temporary copy and its saved receipt',
        recovered.transfers.length === 0 &&
            !Object.keys(recovered.files).some((path) => path.includes('.zync-transfer-')) &&
            recovered.files[`${recovered.host}:${recovered.rootPath}/README.md`] ===
                'original:README.md',
    );
    await page.evaluate(() => window.filesTransferSafety.replayReceipts());
    check(
        'late unresolved history cannot resurrect verified recovery cleanup',
        (await snapshot()).transfers.length === 0,
    );
    await closeReceipts();

    // Exercise the real delete handler with Windows-native entry paths and a
    // slash-form location bar. This boundary never touches a real local file.
    {
        const url = new URL(fixtureUrl);
        url.searchParams.set('transferSafety', '1');
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.getByRole('listbox').waitFor();
        await page.evaluate(() => window.filesTransferSafety.prepareLocalDelete());
        const removed = page.locator('[data-file-name="remove.txt"]');
        await removed.waitFor();
        await removed.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        await removed.waitFor({ state: 'hidden' });
        await page.waitForFunction(
            () => window.filesTransferSafety.snapshot().lastAction?.message === 'Deleted 1 item(s)',
        );
        const state = await snapshot();
        const deletion = state.calls.find((call) => call.command === 'fs_delete_batch')!;
        check(
            'local delete uses the exact Windows entry path, not a reconstructed slash-form path',
            deletion?.args.connectionId === 'local' &&
                (deletion.args.paths as string[])[0] === 'C:\\zync-delete-fixture\\remove.txt',
        );
        check(
            'local delete removes its row without a manual refresh and leaves other entries visible',
            (await removed.count()) === 0 &&
                (await page.locator('[data-file-name="keep.txt"]').isVisible()),
        );
    }
}
