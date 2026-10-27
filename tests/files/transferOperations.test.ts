import { createStore } from 'zustand/vanilla';

import {
    executeFileTransfer,
    type FileTransferExecution,
    type FileTransferRequest,
    fileTransferFailureMessage,
    isFileTransferNotStarted,
    tryStagedFileTransfer,
} from '../../src/features/files/application/executeFileTransfer';
import { acquireFileDestination } from '../../src/features/files/application/fileDestinationReservations';
import {
    isNativeTransferActive,
    isNativeTransferResolved,
    type NativeFileTransferReceipt,
    nativeFileTransferReceipt,
    nativeTransferDisplay,
    nativeTransferInspection,
} from '../../src/features/files/application/nativeFileTransfer';
import {
    replaceFileWithBackup,
    replacementPreconditionError,
} from '../../src/features/files/application/replaceFileWithBackup';
import {
    fileTransferBatchFailure,
    runFileTransferBatch,
} from '../../src/features/files/application/runFileTransferBatch';
import {
    createFileTransferExecution,
    createTransferEventProjection,
    dismissTransferReceipt,
    getTransferEventProjection,
} from '../../src/features/files/application/transferEventProjection';
import { setUsageEnabled } from '../../src/features/usage/enabled';
import {
    createTransferSlice,
    isExpiringTransferReceipt,
    type TransferSlice,
} from '../../src/store/transferSlice';

function equal(actual: unknown, expected: unknown, message: string): void {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function rejected(promise: Promise<unknown>, expected: unknown) {
    try {
        await promise;
    } catch (error) {
        equal(error, expected, 'Keep the original failure outcome');
        return;
    }
    throw new Error('Expected rejection');
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
    await test();
    console.log(`  ok ${name}`);
}

const request: FileTransferRequest = {
    transferId: 'transfer',
    sourceConnectionId: 'source',
    sourcePath: '/source/file',
    destinationConnectionId: 'destination',
    destinationPath: '/destination/file',
};

await run(
    'preparation failures distinguish unchanged targets without inventing recovery data',
    async () => {
        const error = 'TRANSFER_NOT_STARTED:Could not prepare source connection: session closed';
        equal(isFileTransferNotStarted(error), true, 'Recognize the native preparation boundary');
        equal(
            isFileTransferNotStarted('Could not inspect file: session closed'),
            false,
            'Do not infer safety from error wording',
        );
        equal(
            fileTransferFailureMessage(error),
            'Copy did not start; destination unchanged. Could not prepare source connection: session closed',
            'Explain an early failure without exposing protocol tags',
        );
        equal(
            fileTransferFailureMessage('Publication outcome unknown'),
            'Publication outcome unknown',
            'Preserve uncertain publication errors',
        );
        equal(
            fileTransferFailureMessage(undefined),
            '',
            'An absent detail must not display undefined',
        );
        const fixture = execution(async () => {
            throw error;
        }, true);
        await rejected(executeFileTransfer(request, fixture.ports), error);
        equal(
            fixture.outcomes[0],
            `failed:transfer:${error}`,
            'Retain preparation evidence through failure projection',
        );
    },
);

function execution(invoke: FileTransferExecution['invoke'], nativeFiles = false) {
    const outcomes: string[] = [];
    return {
        outcomes,
        ports: {
            // Legacy characterization models a top-level-link response. The staged
            // file/folder contract has separate checks and never falls back on error.
            invoke: (command: string, args: Record<string, unknown>) =>
                !nativeFiles && command === 'fs_transfer_file'
                    ? Promise.resolve(null)
                    : invoke(command, args),
            completeTransfer: (id: string) => {
                outcomes.push(`completed:${id}`);
            },
            failTransfer: (id: string, error: string) => {
                outcomes.push(`failed:${id}:${error}`);
            },
            cancelTransfer: (id: string) => {
                outcomes.push(`cancelled:${id}`);
            },
        },
    };
}

await run('all transfer directions explicitly await the native terminal outcome', async () => {
    for (const [sourceConnectionId, destinationConnectionId, command] of [
        ['local', 'destination', 'sftp_put'],
        ['source', 'local', 'sftp_get'],
        ['source', 'destination', 'sftp_copy_to_server'],
    ]) {
        const native = deferred();
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        const fixture = execution((called, args) => {
            calls.push({ command: called, args });
            return native.promise;
        });
        const transfer = executeFileTransfer(
            { ...request, sourceConnectionId, destinationConnectionId },
            fixture.ports,
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        equal(calls[0].command, command, 'Use the endpoint-specific native adapter');
        equal(calls[0].args.waitForCompletion, true, 'Do not mistake acceptance for completion');
        equal(calls[0].args.transferId, request.transferId, 'Keep the native job identity');
        equal(
            calls[0].args.localPath ?? calls[0].args.sourcePath,
            sourceConnectionId === 'local'
                ? request.sourcePath
                : destinationConnectionId === 'local'
                  ? request.destinationPath
                  : request.sourcePath,
            'Preserve path bytes',
        );
        equal(fixture.outcomes.length, 0, 'No completion before the native result');
        native.resolve();
        await transfer;
        equal(fixture.outcomes.join(), 'completed:transfer', 'Commit confirmed completion');
    }
});

function nativeReceipt(
    overrides: Partial<NativeFileTransferReceipt> = {},
): NativeFileTransferReceipt {
    return {
        version: 1,
        id: request.transferId,
        sourceConnectionId: request.sourceConnectionId,
        sourcePath: request.sourcePath,
        destinationConnectionId: request.destinationConnectionId,
        destinationPath: request.destinationPath,
        stagePath: '/destination/.zync-transfer-test.part',
        backupPath: '/destination/.zync-transfer-test.backup',
        backupExpected: true,
        phase: 'completed',
        createdAt: 1,
        transferred: 10,
        total: 10,
        destinationUnchanged: false,
        warning: null,
        error: null,
        ...overrides,
    };
}

await run(
    'combine uses the existing command, validates root identity and never falls back',
    async () => {
        const job = {
            sourceRoot: request.sourcePath,
            destinationRoot: request.destinationPath,
            completedItems: 2,
            totalItems: 2,
            completedBytes: 20,
            totalBytes: 20,
            currentDone: true,
            finished: true,
        };
        const receipt = nativeReceipt({
            sourcePath: `${request.sourcePath}/item`,
            destinationPath: `${request.destinationPath}/item`,
            combine: job,
        });
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        const fixture = execution(async (command, args) => {
            calls.push({ command, args });
            return receipt;
        }, true);
        await executeFileTransfer(
            { ...request, overwrite: true, folderMode: 'combine' },
            fixture.ports,
        );
        equal(calls.length, 1, 'One native coordinator, not renderer recursion');
        equal(calls[0].command, 'fs_transfer_file', 'Reuse the current command');
        equal(
            calls[0].args.folderMode,
            'combine',
            'Explicitly distinguish combine from replacement',
        );
        equal(fixture.outcomes.join(), 'completed:transfer', 'Only the terminal job completes');
        for (const operation of [executeFileTransfer, tryStagedFileTransfer]) {
            const commands: string[] = [];
            const unsupported = execution(async (command) => {
                commands.push(command);
                return null;
            }, true);
            let refused = false;
            try {
                await operation(
                    { ...request, overwrite: true, folderMode: 'combine' },
                    unsupported.ports,
                );
            } catch (error) {
                refused = String(error).includes('no legacy copy');
            }
            equal(
                refused,
                true,
                'Both copy and conflict callers reject an unhandled combine rather than returning false',
            );
            equal(
                commands.join(),
                'fs_transfer_file',
                'An unhandled combine never dispatches another mutation',
            );
            equal(unsupported.outcomes.length, 1, 'Report the failure once');
            equal(
                unsupported.outcomes[0].startsWith('failed:'),
                true,
                'Do not report a failed combine as completed',
            );
            acquireFileDestination(
                request.destinationConnectionId,
                request.destinationPath,
            ).release();
        }
        const mismatched = execution(
            async () => ({ ...receipt, combine: { ...job, destinationRoot: '/other' } }),
            true,
        );
        let refused = false;
        try {
            await executeFileTransfer({ ...request, folderMode: 'combine' }, mismatched.ports);
        } catch (error) {
            refused = String(error).includes('does not match');
        }
        equal(refused, true, 'Bind the result to the requested root');
    },
);

await run('pre-start folder limits never select an untracked legacy copy', async () => {
    for (const detail of [
        'Folder entry limit exceeded',
        'Folder nesting limit exceeded',
        'Folder path budget exceeded',
        'Folder size exceeds transfer limits',
    ]) {
        for (const operation of [executeFileTransfer, tryStagedFileTransfer]) {
            const error = `TRANSFER_NOT_STARTED:${detail}`;
            const commands: string[] = [];
            const fixture = execution(async (command) => {
                commands.push(command);
                throw error;
            }, true);
            await rejected(operation({ ...request, overwrite: false }, fixture.ports), error);
            equal(
                commands.join(),
                'fs_transfer_file',
                'An absent-target copy still respects staged tree limits',
            );
            equal(
                fixture.outcomes.join(),
                `failed:transfer:${error}`,
                'Keep the original pre-start refusal',
            );
            acquireFileDestination(
                request.destinationConnectionId,
                request.destinationPath,
            ).release();
        }
    }
});

await run(
    'combine cursor projects aggregate bytes once and cannot complete or expire a running job',
    async () => {
        const job = {
            sourceRoot: request.sourcePath,
            destinationRoot: request.destinationPath,
            completedItems: 1,
            totalItems: 3,
            completedBytes: 10,
            totalBytes: 30,
            currentDone: true,
            finished: false,
        };
        const receipt = nativeReceipt({
            sourcePath: `${request.sourcePath}/a`,
            destinationPath: `${request.destinationPath}/a`,
            combine: job,
        });
        equal(nativeFileTransferReceipt(receipt), receipt, 'Accept the versioned optional cursor');
        equal(isNativeTransferActive(receipt), true, 'A finished unit is not a finished combine');
        equal(isNativeTransferResolved(receipt), false, 'Do not expire the gap between units');
        equal(
            nativeTransferDisplay(receipt).transferred,
            10,
            'Do not count the completed cursor twice',
        );
        const store = createStore<TransferSlice>()(createTransferSlice);
        store.getState().receiveNativeTransfer(receipt);
        let transfer = store.getState().transfers[0];
        equal(transfer.status, 'transferring', 'Keep the aggregate active');
        equal(transfer.sourcePath, request.sourcePath, 'Display the folder root');
        equal(transfer.progress.total, 30, 'Display the whole planned job');
        equal(
            transfer.recoveryStagePath,
            undefined,
            'Do not offer inspection for a clean completed cursor',
        );
        const cancelled = nativeReceipt({
            ...receipt,
            phase: 'cancelled',
            stageCleaned: true,
            destinationUnchanged: true,
            transferred: 5,
            combine: { ...job, currentDone: false, finished: true },
            error: 'Cancelled',
        });
        store.getState().receiveNativeTransfer(cancelled);
        transfer = store.getState().transfers[0];
        equal(
            transfer.progress.transferred,
            15,
            'Add only the in-flight unit bytes to acknowledged progress',
        );
        equal(transfer.status, 'cancelled', 'Project cancellation once');
        equal(
            isNativeTransferResolved(cancelled),
            true,
            'A clean cancelled combine is not unresolved recovery',
        );
        store.getState().receiveNativeTransfer(receipt);
        equal(
            store.getState().transfers[0].status,
            'cancelled',
            'A stale cursor cannot revive the job',
        );
        for (const malformed of [
            { ...job, completedItems: 4 },
            { ...job, totalBytes: -1 },
            { ...job, finished: 'yes' },
            { ...job, sourceRoot: '' },
        ]) {
            let rejected = false;
            try {
                nativeFileTransferReceipt({ ...receipt, combine: malformed });
            } catch {
                rejected = true;
            }
            equal(rejected, true, 'Reject malformed aggregate authority');
        }
    },
);

await run(
    'recovery cleanup eligibility is explicit and malformed permissions fail closed',
    async () => {
        const entries = { destination: null, stage: { kind: 'File', size: 12 }, backup: null };
        equal(
            nativeTransferInspection(entries).cleanupAvailable,
            undefined,
            'Older hosts never implicitly authorize removal',
        );
        equal(
            nativeTransferInspection({
                ...entries,
                cleanupAvailable: true,
                cleanupBlockedReason: null,
            }).cleanupAvailable,
            true,
            'Accept explicit verified eligibility',
        );
        equal(
            nativeTransferInspection({
                ...entries,
                stage: { kind: 'Directory', size: 0 },
                cleanupAvailable: true,
                cleanupBlockedReason: null,
            }).cleanupAvailable,
            true,
            'Folder cleanup reuses explicit native authority, not file-size assumptions',
        );
        for (const eligibility of [
            { cleanupAvailable: 'true' },
            { cleanupAvailable: true },
            { cleanupAvailable: true, cleanupBlockedReason: 'Unknown writer' },
            { cleanupAvailable: false, cleanupBlockedReason: null },
        ]) {
            let refused = false;
            try {
                nativeTransferInspection({ ...entries, ...eligibility });
            } catch {
                refused = true;
            }
            equal(refused, true, 'Reject invalid cleanup authority');
        }
    },
);

await run(
    'folder replacements reuse the same native outcome owner without legacy replay',
    async () => {
        const native = deferred();
        const calls: string[] = [];
        const store = execution(async (command) => {
            calls.push(command);
            await native.promise;
            return nativeReceipt();
        }, true);
        const pending = tryStagedFileTransfer({ ...request, overwrite: true }, store.ports);
        await Promise.resolve();
        equal(calls.join(), 'fs_transfer_file', 'Folder staging uses the existing native command');
        equal(store.outcomes.length, 0, 'Do not finish while native tree copying is in flight');
        native.resolve();
        equal(
            await pending,
            true,
            'A staged folder never falls back to backup-first frontend copying',
        );
        equal(calls.length, 1, 'No second transfer API or replay');
    },
);

await run(
    'clean native cancellation clears recovery controls and ignores stale pre-cleanup history',
    async () => {
        const store = createStore<TransferSlice>()(createTransferSlice);
        const receipt = nativeReceipt({
            phase: 'cancelled',
            destinationUnchanged: true,
            stageCleaned: true,
            error: 'Cancelled',
        });
        store
            .getState()
            .receiveNativeTransfer({ ...receipt, phase: 'writing', stageCleaned: false });
        store.getState().receiveNativeTransfer(receipt);
        const transfer = store.getState().transfers[0];
        equal(transfer.stageCleaned, true, 'Use explicit native cleanup evidence');
        equal(
            transfer.recoveryStagePath,
            undefined,
            'Do not offer inspection for a removed temporary copy',
        );
        equal(transfer.recoveryBackupPath, undefined, 'No original backup was created');
        equal(
            isExpiringTransferReceipt(transfer),
            false,
            'Keep cancellation visible until dismissed',
        );
        const before = store.getState();
        store.getState().receiveNativeTransfer({
            ...receipt,
            stageCleaned: false,
            warning: 'Staging may remain',
        });
        equal(
            store.getState(),
            before,
            'Late pre-cleanup history cannot resurrect removed artifacts',
        );
    },
);

await run(
    'old cancellations and cleanup warnings remain reviewable rather than assumed clean',
    async () => {
        const store = createStore<TransferSlice>()(createTransferSlice);
        store
            .getState()
            .receiveNativeTransfer(
                nativeReceipt({ phase: 'cancelled', destinationUnchanged: true }),
            );
        equal(
            store.getState().transfers[0].stageCleaned,
            false,
            'Missing old cleanup evidence defaults to false',
        );
        equal(
            isExpiringTransferReceipt(store.getState().transfers[0]),
            false,
            'An old cancellation does not automatically expire',
        );
        store.getState().receiveNativeTransfer(
            nativeReceipt({
                phase: 'cancelled',
                destinationUnchanged: true,
                stageCleaned: true,
                warning: 'Recovery receipt could not be saved',
            }),
        );
        equal(
            isExpiringTransferReceipt(store.getState().transfers[0]),
            false,
            'Keep cleanup warnings until explicitly cleared',
        );
    },
);

await run(
    'resolved native history stays session-only and cleared recovery resists stale messages',
    async () => {
        const store = createStore<TransferSlice>()(createTransferSlice);
        const receipt = nativeReceipt();
        store.getState().receiveNativeTransfer(receipt);
        store.getState().receiveNativeTransfer({
            ...receipt,
            phase: 'cancelled',
            stageCleaned: true,
            destinationUnchanged: true,
        });
        equal(
            store.getState().transfers.length,
            0,
            'Do not restore old successes or verified clean cancellations',
        );
        const unresolved = {
            ...receipt,
            phase: 'failed' as const,
            warning: 'Inspect temporary copy',
        };
        store.getState().receiveNativeTransfer(unresolved);
        equal(store.getState().transfers.length, 1, 'Unresolved recovery remains discoverable');
        const calls: string[] = [];
        await dismissTransferReceipt(
            receipt.id,
            async (command) => {
                calls.push(command);
            },
            store.getState,
        );
        equal(
            calls.join(),
            'fs_transfer_dismiss',
            'The same clear action handles unresolved history without inspection',
        );
        equal(store.getState().transfers.length, 0, 'Clear removes the history entry');
        store.getState().receiveNativeTransfer(unresolved);
        store.getState().receiveNativeTransfer({ ...receipt, phase: 'writing' });
        equal(
            store.getState().transfers.length,
            0,
            'Late recovery/history and active events cannot resurrect acknowledged IDs',
        );
        const freshStore = createStore<TransferSlice>()(createTransferSlice);
        freshStore.getState().receiveNativeTransfer(unresolved);
        equal(
            freshStore.getState().transfers.length,
            1,
            'Dismissal state is isolated per renderer store',
        );
    },
);

await run(
    'manual dismissal and expiry acknowledge native history before removing the row',
    async () => {
        for (const phase of ['completed', 'cancelled'] as const) {
            const store = createStore<TransferSlice>()(createTransferSlice);
            const id = store.getState().addTransfer(request);
            const receipt = nativeReceipt({
                id,
                phase,
                destinationUnchanged: phase === 'cancelled',
                stageCleaned: phase === 'cancelled',
            });
            store.getState().receiveNativeTransfer(receipt);
            const error = new Error('Journal unavailable');
            await rejected(
                dismissTransferReceipt(
                    id,
                    async () => {
                        throw error;
                    },
                    store.getState,
                ),
                error,
            );
            equal(
                store.getState().transfers.length,
                1,
                'A failed acknowledgement leaves a retryable row',
            );
            let acknowledgements = 0;
            await dismissTransferReceipt(
                id,
                async (command, args) => {
                    equal(command, 'fs_transfer_dismiss', 'Use the existing journal guard');
                    equal(args.transferId, id, 'Acknowledge only this receipt');
                    equal(
                        store.getState().transfers.length,
                        1,
                        'Keep the row until acknowledgement succeeds',
                    );
                    acknowledgements++;
                },
                store.getState,
            );
            equal(acknowledgements, 1, 'One acknowledgement per clear');
            store
                .getState()
                .receiveNativeTransfer({ ...receipt, phase: 'writing', stageCleaned: false });
            store.getState().receiveNativeTransfer(receipt);
            equal(
                store.getState().transfers.length,
                0,
                'Late snapshots cannot undo a successful clear',
            );
        }
    },
);

await run('bounded batches continue after failures and report cancellations quietly', async () => {
    const attempted: number[] = [];
    const result = await runFileTransferBatch([0, 1, 2, 3, 4], async (item) => {
        attempted.push(item);
        if (item === 0) {
            throw new Error('Disk full');
        }
        if (item === 1) {
            throw new Error('Cancelled');
        }
        if (item === 2) {
            throw new Error('Permission denied');
        }
    });
    equal(attempted.length, 5, 'Attempt the remaining queued items after a failed one');
    equal(result.failed, 2, 'Count genuine failures');
    equal(result.cancelled, 1, 'Keep intentional cancellation separate');
    equal(
        fileTransferBatchFailure(result),
        'Disk full (2 items failed.)',
        'One bounded notification summarizes the batch',
    );
    const cancelled = await runFileTransferBatch([0, 1], async () => {
        throw 'Cancelled';
    });
    equal(fileTransferBatchFailure(cancelled), undefined, 'Do not toast routine cancellation');
    const empty = await runFileTransferBatch([], async () => {
        throw 'Unexpected work';
    });
    equal(fileTransferBatchFailure(empty), undefined, 'An empty batch has no notification');
    const unknown = await runFileTransferBatch([0], async () => {
        throw undefined;
    });
    equal(unknown.failed, 1, 'An empty thrown value still counts as failure');
    equal(
        fileTransferBatchFailure(unknown),
        'Transfer failed. Check Transfers for details.',
        'Do not silently swallow an unstructured failure',
    );
});

await run('metadata batches remain independent of active transfer batches', async () => {
    const gate = deferred();
    let active = 0;
    const transfers = runFileTransferBatch([0, 1], async () => {
        active++;
        try {
            await gate.promise;
        } finally {
            active--;
        }
    });
    try {
        equal(active, 2, 'Keep both transfer workers occupied');
        const reads: number[] = [];
        let completed = false;
        const metadata = runFileTransferBatch([0, 1, 2], async (item) => {
            reads.push(item);
        }).then((result) => {
            completed = true;
            return result;
        });
        // Drain microtasks only: a shared limiter would still be blocked by gate.
        for (let turn = 0; turn < 10 && !completed; turn++) {
            await Promise.resolve();
        }
        equal(
            completed,
            true,
            'Per-call workers let optional metadata finish while transfers are blocked',
        );
        equal(reads.join(), '0,1,2', 'Read every conflict exactly once');
        equal(active, 2, 'Metadata completion does not depend on finishing a transfer');
        equal((await metadata).failed, 0, 'Metadata workers retain normal batch reporting');
    } finally {
        gate.resolve();
        await transfers;
    }
    equal(active, 0, 'Release all blocked fixture work');
});

await run('bounded success history cannot be recreated by a late active snapshot', async () => {
    const store = createStore<TransferSlice>()(createTransferSlice);
    let oldest = '';
    for (let index = 0; index < 21; index++) {
        const id = store.getState().addTransfer(request);
        if (index === 0) {
            oldest = id;
        }
        store.getState().receiveNativeTransfer(nativeReceipt({ id }));
    }
    equal(store.getState().transfers.length, 20, 'Keep the existing bounded success history');
    store.getState().receiveNativeTransfer(nativeReceipt({ id: oldest, phase: 'writing' }));
    equal(
        store.getState().transfers.length,
        20,
        'Treat automatic trimming like other dismissal paths',
    );
    equal(
        store.getState().transfers.some((transfer) => transfer.id === oldest),
        false,
        'Do not recreate a removed active row',
    );
});

await run('regular files use one native owner and preserve explicit overwrite intent', async () => {
    let calls = 0;
    const fixture = execution(async (command, args) => {
        calls++;
        equal(command, 'fs_transfer_file', 'All endpoint directions use native staging');
        equal(args.overwrite, true, 'Only an explicit collision decision permits replacement');
        return nativeReceipt();
    }, true);
    await executeFileTransfer({ ...request, overwrite: true }, fixture.ports);
    equal(calls, 1, 'No legacy second copy');
    equal(fixture.outcomes.join(), 'completed:transfer', 'Complete only the native receipt');
});

await run(
    'staged write failures and malformed acknowledgements never replay through a legacy command',
    async () => {
        for (const response of [
            undefined,
            { version: 99 },
            nativeReceipt({ phase: 'writing' }),
            nativeReceipt({ phase: 'completed', stageCleaned: true }),
            nativeReceipt({ phase: 'cancelled', stageCleaned: true, destinationUnchanged: false }),
            nativeReceipt({ phase: 'needsReview', error: 'Publish acknowledgement lost' }),
        ]) {
            let calls = 0;
            const fixture = execution(async () => {
                calls++;
                return response;
            }, true);
            try {
                await executeFileTransfer(request, fixture.ports);
                throw new Error('Expected native failure');
            } catch (error) {
                equal(
                    String(error).includes('Expected native failure'),
                    false,
                    'Reject uncertain/malformed native outcomes',
                );
            }
            equal(calls, 1, 'Uncertainty cannot select a fallback');
            equal(
                fixture.outcomes.some((outcome) => outcome.startsWith('completed:')),
                false,
                'No false completion',
            );
        }
    },
);

await run(
    'recovery projection survives reload and does not resurrect terminal outcomes',
    async () => {
        const store = createStore<TransferSlice>()(createTransferSlice);
        store
            .getState()
            .receiveNativeTransfer(
                nativeReceipt({ phase: 'needsReview', warning: 'Inspect interrupted publication' }),
            );
        const restored = store.getState().transfers[0];
        equal(
            restored.status,
            'failed',
            'Interrupted publication is not still running after restart',
        );
        equal(
            restored.recoveryStagePath,
            '/destination/.zync-transfer-test.part',
            'Retain stage path',
        );
        equal(
            restored.recoveryBackupPath,
            '/destination/.zync-transfer-test.backup',
            'Retain original backup path',
        );
        store.getState().receiveNativeTransfer(nativeReceipt({ phase: 'writing' }));
        equal(store.getState().transfers[0].status, 'failed', 'Ignore a stale history snapshot');
    },
);

await run(
    'an active history snapshot cannot rewind progress or erase a cancellation request',
    async () => {
        const store = createStore<TransferSlice>()(createTransferSlice);
        store
            .getState()
            .receiveNativeTransfer(nativeReceipt({ phase: 'writing', transferred: 0, total: 100 }));
        store.getState().updateTransferProgress(request.transferId, {
            transferred: 50,
            total: 100,
            percentage: 50,
        });
        store.getState().requestTransferCancellation(request.transferId);
        store
            .getState()
            .receiveNativeTransfer(nativeReceipt({ phase: 'writing', transferred: 0, total: 100 }));
        equal(
            store.getState().transfers[0].status,
            'cancelling',
            'Keep the user cancellation intent',
        );
        equal(
            store.getState().transfers[0].progress.transferred,
            50,
            'Keep live progress instead of a journal checkpoint',
        );
    },
);

await run(
    'large selected-file batches apply backpressure without dropping the remaining files',
    async () => {
        let active = 0;
        let peak = 0;
        const seen: number[] = [];
        await runFileTransferBatch(
            Array.from({ length: 100 }, (_, index) => index),
            async (item) => {
                active++;
                peak = Math.max(peak, active);
                await Promise.resolve();
                seen.push(item);
                active--;
            },
        );
        equal(peak, 2, 'Bound active calls instead of flooding native admission');
        equal(new Set(seen).size, 100, 'Submit every selected file exactly once');
        equal(active, 0, 'Finish the entire batch');
    },
);

await run(
    'each staged outcome has one reporting owner for copy and overwrite callers',
    async () => {
        for (const operation of [executeFileTransfer, tryStagedFileTransfer]) {
            for (const phase of ['completed', 'cancelled', 'failed'] as const) {
                const receipt = nativeReceipt({
                    phase,
                    destinationUnchanged: phase !== 'completed',
                    error:
                        phase === 'cancelled'
                            ? 'Cancelled'
                            : phase === 'failed'
                              ? 'write failed'
                              : null,
                });
                const fixture = execution(async () => receipt, true);
                try {
                    await operation(request, fixture.ports);
                } catch {
                    /* unsuccessful native receipt */
                }
                equal(
                    fixture.outcomes.length,
                    1,
                    'Do not repeat terminal callbacks through nested catch handlers',
                );
                const received: NativeFileTransferReceipt[] = [];
                fixture.outcomes.length = 0;
                try {
                    await operation(request, {
                        ...fixture.ports,
                        receiveNativeTransfer: (value) => received.push(value),
                    });
                } catch {
                    /* expected */
                }
                equal(received.length, 1, 'Native receipt projection is the owner when available');
                equal(
                    fixture.outcomes.length,
                    0,
                    'Do not also report legacy outcomes for the same receipt',
                );
            }
        }
    },
);

await run(
    'staged-only fallback releases admission without reporting an unhandled kind as a transfer',
    async () => {
        const fixture = execution(async () => {
            throw new Error('A directory probe must not dispatch another copy');
        });
        equal(
            await tryStagedFileTransfer(request, fixture.ports),
            false,
            'Only explicit null delegates to the existing policy',
        );
        equal(fixture.outcomes.length, 0, 'Do not manufacture success for an unhandled kind');
        acquireFileDestination(request.destinationConnectionId, request.destinationPath).release();
    },
);

await run('native cancellation and failure remain distinct and reject awaited copies', async () => {
    for (const error of [
        'Cancelled',
        'Permission denied',
        new Error('Cancelled request could not be sent'),
    ]) {
        const fixture = execution(async () => {
            throw error;
        });
        await rejected(executeFileTransfer(request, fixture.ports), error);
        equal(
            fixture.outcomes[0],
            error === 'Cancelled'
                ? 'cancelled:transfer'
                : `failed:transfer:${error instanceof Error ? error.message : error}`,
            'Classify actual native outcomes, not substring guesses',
        );
    }
});

await run('same-endpoint operations cannot accidentally enter the cross-host adapter', async () => {
    let invoked = false;
    const fixture = execution(async () => {
        invoked = true;
    });
    try {
        await executeFileTransfer(
            { ...request, destinationConnectionId: request.sourceConnectionId },
            fixture.ports,
        );
    } catch {
        /* expected */
    }
    equal(invoked, false, 'Use existing same-endpoint operations');
    equal(fixture.outcomes.length, 1, 'Retain setup failure instead of a dead pending row');
});

await run('overwrite backup survives until the real awaited copy completes', async () => {
    const native = deferred();
    const calls: string[] = [];
    const fixture = execution(async (_command, args) => {
        equal(args.waitForCompletion, true, 'Overwrite must request a terminal result');
        calls.push('copy');
        await native.promise;
    });
    const result = replaceFileWithBackup(request.destinationPath, {
        destinationConnectionId: request.destinationConnectionId,
        createBackupId: () => 'owned-id',
        rename: async (from, to) => {
            calls.push(`rename:${from}:${to}`);
        },
        write: (backupPath, reservation) => {
            equal(
                backupPath,
                `${request.destinationPath}.zync-backup-owned-id`,
                'Associate the receipt with its original recovery backup',
            );
            return executeFileTransfer(request, fixture.ports, reservation);
        },
        remove: async (path) => {
            calls.push(`remove:${path}`);
        },
    });
    for (let tick = 0; tick < 8; tick++) {
        await Promise.resolve();
    }
    equal(calls.length, 2, 'Do not delete or restore while the writer is running');
    equal(fixture.outcomes.length, 0, 'Do not display success while running');
    native.resolve();
    equal((await result).outcome, 'replaced', 'Cleanup follows confirmed write');
    equal(
        calls[2],
        `remove:${request.destinationPath}.zync-backup-owned-id`,
        'Delete only the recovery path after success',
    );
});

await run('a replacement reserves its target and backup through delayed cleanup', async () => {
    const write = deferred();
    const cleanup = deferred();
    const cleaning = deferred();
    const destinationConnectionId = 'replacement-reservation';
    const forbidden = async () => {
        throw new Error('A blocked replacement must not mutate');
    };
    const options = {
        destinationConnectionId,
        createBackupId: () => 'original',
        rename: async () => {},
        write: () => write.promise,
        remove: () => {
            cleaning.resolve();
            return cleanup.promise;
        },
    };
    const original = replaceFileWithBackup('/target', options);
    const blockedOptions = {
        destinationConnectionId,
        createBackupId: () => 'other',
        rename: forbidden,
        write: forbidden,
        remove: forbidden,
    };
    equal(
        (await replaceFileWithBackup('/target', blockedOptions)).outcome,
        'blocked',
        'Do not retarget an active replacement',
    );
    equal(
        (await replaceFileWithBackup('/target.zync-backup-original', blockedOptions)).outcome,
        'blocked',
        'Do not mutate its recovery original',
    );
    write.resolve();
    await cleaning.promise;
    equal(
        (await replaceFileWithBackup('/target', blockedOptions)).outcome,
        'blocked',
        'Native write success does not release cleanup ownership',
    );
    cleanup.resolve();
    equal(
        (await original).outcome,
        'replaced',
        'Complete cleanup without another owner interfering',
    );
    acquireFileDestination(destinationConnectionId, '/target').release();
    acquireFileDestination(destinationConnectionId, '/target.zync-backup-original').release();
});

await run(
    'same-endpoint replacement rejects identical and ancestor paths before moving a backup',
    async () => {
        for (const [sourcePath, destinationPath] of [
            ['/dir/file', '/dir/file'],
            ['/dir/file', '/dir'],
            ['/dir', '/dir/child'],
            ['C:\\dir\\file', 'C:/dir/file'],
            ['C:/dir', 'C:\\dir\\child'],
        ]) {
            equal(
                typeof replacementPreconditionError({
                    ...request,
                    destinationConnectionId: request.sourceConnectionId,
                    sourcePath,
                    destinationPath,
                }),
                'string',
                'Do not move the source or its ancestor out of the write path',
            );
        }
        equal(
            replacementPreconditionError(request),
            null,
            'Same literal path across endpoints is not self-overwrite',
        );
        equal(
            replacementPreconditionError({
                ...request,
                destinationConnectionId: request.sourceConnectionId,
                sourcePath: '/dir/file',
                destinationPath: '/dir/file (1)',
            }),
            null,
            'Keep Both uses a distinct sibling target',
        );
    },
);

await run('failed or cancelled overwrite retains its backup without blind rollback', async () => {
    for (const error of ['Cancelled', 'Connection lost after partial write']) {
        const calls: string[] = [];
        const result = await replaceFileWithBackup('/target', {
            destinationConnectionId: 'destination',
            createBackupId: () => 'retained',
            rename: async () => {
                calls.push('prepare');
            },
            write: async () => {
                calls.push('partial-write');
                throw error;
            },
            remove: async () => {
                throw new Error('Must not delete recovery content');
            },
        });
        equal(result.outcome, 'unconfirmed', 'Do not claim a failed mutation left no changes');
        if (result.outcome !== 'unconfirmed') {
            throw new Error('Expected unconfirmed result');
        }
        equal(
            result.backupPath,
            '/target.zync-backup-retained',
            'Retain a usable recovery location',
        );
        equal(result.phase, 'write', 'Distinguish failed preparation');
        equal(
            calls.join(),
            'prepare,partial-write',
            'Never rename a backup over a partial/raced destination',
        );
    }
});

await run('uncertain backup preparation never starts another mutation', async () => {
    const error = new Error('Rename acknowledgement lost');
    const result = await replaceFileWithBackup('/target', {
        destinationConnectionId: 'destination',
        createBackupId: () => 'uncertain',
        rename: async () => {
            throw error;
        },
        write: async () => {
            throw new Error('Unexpected write');
        },
        remove: async () => {
            throw new Error('Unexpected deletion');
        },
    });
    equal(result.outcome, 'unconfirmed', 'Keep uncertainty visible');
    if (result.outcome !== 'unconfirmed') {
        throw new Error('Expected unconfirmed result');
    }
    equal(result.phase, 'prepare', 'Do not retry rename or restore automatically');
    equal(result.error, error, 'Preserve diagnostic outcome');
});

await run('cleanup failure is a completed replacement with a retained-backup warning', async () => {
    const error = new Error('Backup deletion denied');
    const result = await replaceFileWithBackup('/target', {
        destinationConnectionId: 'destination',
        createBackupId: () => 'retained',
        rename: async () => {},
        write: async () => {},
        remove: async () => {
            throw error;
        },
    });
    equal(
        result.outcome,
        'replaced-backup-retained',
        'Do not hide cleanup failure or misreport successful write',
    );
    if (result.outcome !== 'replaced-backup-retained') {
        throw new Error('Expected retained backup');
    }
    equal(result.error, error, 'Expose the actual cleanup failure');
});

setUsageEnabled(false);
function projectionFixture() {
    const store = createStore<TransferSlice>()(createTransferSlice);
    const id = store.getState().addTransfer(request);
    const refreshes: string[] = [];
    const projection = createTransferEventProjection(
        () => ({
            ...store.getState(),
            refreshConnectionFiles: async (connectionId) => {
                refreshes.push(connectionId);
            },
        }),
        () => {
            throw new Error('Unexpected refresh error');
        },
    );
    return { store, id, refreshes, projection };
}

await run('IPC and event receipts share one refresh owner in either arrival order', async () => {
    for (const phase of ['completed', 'cancelled', 'failed'] as const) {
        for (const eventFirst of [true, false]) {
            const store = createStore<TransferSlice>()(createTransferSlice);
            const id = store.getState().addTransfer(request);
            const refreshes: string[] = [];
            const getStore = () => ({
                ...store.getState(),
                refreshConnectionFiles: async (connectionId: string) => {
                    refreshes.push(connectionId);
                },
                setLastAction: () => {
                    throw new Error('Unexpected refresh failure');
                },
            });
            const receipt = nativeReceipt({
                id,
                phase,
                destinationUnchanged: phase !== 'completed',
                error:
                    phase === 'cancelled'
                        ? 'Cancelled'
                        : phase === 'failed'
                          ? 'write failed'
                          : null,
            });
            let finish!: () => void;
            const result = new Promise<unknown>((resolve) => {
                finish = () => resolve(receipt);
            });
            const adapter = createFileTransferExecution(async () => result, getStore);
            const events = getTransferEventProjection(getStore, () => {
                throw new Error('Unexpected refresh failure');
            });
            const running = executeFileTransfer({ ...request, transferId: id }, adapter).catch(
                () => {},
            );
            if (eventFirst) {
                events.native(receipt);
            }
            finish();
            await running;
            events.native(receipt);
            events.native({ ...receipt, phase: 'writing' });
            events.native({ ...receipt, phase: phase === 'completed' ? 'failed' : 'completed' });
            equal(
                refreshes.join(),
                request.destinationConnectionId,
                'Refresh only the captured endpoint once for duplicate/stale outcomes',
            );
            equal(
                store.getState().transfers[0].status,
                phase,
                'Keep the first accepted terminal outcome',
            );
        }
    }
});

await run(
    'shared projections stay isolated per store and history restoration performs no refresh',
    async () => {
        const refreshed: number[] = [];
        for (const index of [0, 1]) {
            const store = createStore<TransferSlice>()(createTransferSlice);
            const getStore = () => ({
                ...store.getState(),
                refreshConnectionFiles: async () => {
                    refreshed.push(index);
                },
            });
            const receipt = nativeReceipt({ warning: 'Backup cleanup needs attention' });
            store.getState().receiveNativeTransfer(receipt);
            equal(
                refreshed.length,
                index,
                'Restoring history alone does not issue directory reads',
            );
            const projection = getTransferEventProjection(getStore, () => {
                throw new Error('Unexpected refresh failure');
            });
            projection.native(receipt);
            getTransferEventProjection(getStore, () => {}).native(receipt);
            equal(
                refreshed.length,
                index + 1,
                'Each store refreshes once even with the same receipt ID',
            );
        }
        equal(refreshed.join(), '0,1', 'Do not share outcome ownership across independent stores');
    },
);

await run(
    'success result before event still refreshes the captured destination exactly once',
    async () => {
        const { store, id, refreshes, projection } = projectionFixture();
        store.getState().completeTransfer(id);
        projection.success({ id, destination_connection_id: 'unrelated-active-host' });
        projection.success({ id, destination_connection_id: request.destinationConnectionId });
        projection.error({ id, error: 'late conflicting failure' });
        equal(
            refreshes.join(),
            request.destinationConnectionId,
            'Use known request identity, not current host or duplicate events',
        );
        equal(
            store.getState().transfers[0].status,
            'completed',
            'A late error cannot reverse success',
        );
    },
);

await run('success event before result commits and refreshes once', async () => {
    const { store, id, refreshes, projection } = projectionFixture();
    projection.success({ id, destination_connection_id: request.destinationConnectionId });
    store.getState().completeTransfer(id);
    projection.success({ id, destination_connection_id: request.destinationConnectionId });
    equal(refreshes.length, 1, 'Do not reload every split pane twice');
    equal(
        store.getState().transfers[0].status,
        'completed',
        'Native success owns completion without progress',
    );
});

await run(
    'failure/cancellation refresh partial destination contents and ignore later success',
    async () => {
        for (const error of ['Cancelled', 'write failed']) {
            const { store, id, refreshes, projection } = projectionFixture();
            projection.error({ id, error });
            projection.error({ id, error });
            projection.success({ id, destination_connection_id: request.destinationConnectionId });
            projection.progress({ id, transferred: 4, total: 5 });
            equal(refreshes.length, 1, 'Retain partial content visibility without duplicate reads');
            equal(
                store.getState().transfers[0].status,
                error === 'Cancelled' ? 'cancelled' : 'failed',
                'Keep terminal outcome',
            );
        }
    },
);

await run('unknown or dismissed native events cannot load unrelated destinations', async () => {
    const { store, id, refreshes, projection } = projectionFixture();
    store.getState().removeTransfer(id);
    projection.success({ id, destination_connection_id: request.destinationConnectionId });
    projection.error({ id, error: 'late error' });
    equal(refreshes.length, 0, 'No dangling view work for unknown jobs');
});
