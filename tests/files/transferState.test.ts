import { createStore } from 'zustand/vanilla';

import { isBenignTransferCancelError } from '../../src/components/file-manager/transferCancellation';
import {
    recoveryInspectionSummary,
    transferRecoveryCopy,
} from '../../src/components/file-manager/transferRecoveryCopy';
import { isUsageEnabled, setUsageEnabled } from '../../src/features/usage/enabled';
import { loadQueue } from '../../src/features/usage/queue';
import {
    createTransferSlice,
    isExpiringTransferReceipt,
    type Transfer,
    type TransferSlice,
} from '../../src/store/transferSlice';

function equal(actual: unknown, expected: unknown, message: string): void {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function run(name: string, test: () => void): void {
    test();
    console.log(`  ok ${name}`);
}

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => {
            values.delete(key);
        },
        setItem: (key, value) => {
            values.set(key, value);
        },
    };
}

function fixture() {
    const store = createStore<TransferSlice>()(createTransferSlice);
    const id = store.getState().addTransfer({
        sourceConnectionId: 'source',
        sourcePath: '/source/file',
        destinationConnectionId: 'destination',
        destinationPath: '/destination/file',
    });
    const current = (): Transfer => {
        const transfer = store.getState().transfers.find((item) => item.id === id);
        if (!transfer) {
            throw new Error('Expected the transfer to remain available');
        }
        return transfer;
    };
    return { store, id, current };
}

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const usageEnabled = isUsageEnabled();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() });
setUsageEnabled(true);

try {
    run(
        'cancelled combines explain partial completion instead of claiming an unchanged folder',
        () => {
            const copy = transferRecoveryCopy({
                status: 'cancelled',
                nativeRecovery: true,
                destinationUnchanged: true,
                combine: {
                    sourceRoot: '/source',
                    destinationRoot: '/target',
                    completedItems: 1,
                    totalItems: 3,
                    completedBytes: 10,
                    totalBytes: 30,
                    currentDone: false,
                    finished: true,
                },
            });
            equal(
                copy.detail,
                '1 of 3 items combined. Completed items remain; destination-only items are kept.',
                'Do not confuse a clean current file with a whole-folder rollback',
            );
        },
    );
    run('unchanged native cancellation removes only the redundant warning', () => {
        const transfer = {
            status: 'cancelled' as const,
            nativeRecovery: true,
            destinationUnchanged: true,
            recoveryWarning:
                'Destination left unchanged. A separate staging file may remain; inspect it before cleanup.',
        };
        equal(
            transferRecoveryCopy(transfer).detail,
            'Destination left unchanged.',
            'Describe the recorded outcome once',
        );
        equal(
            transferRecoveryCopy(transfer).warning,
            undefined,
            'Hide the exact duplicate boilerplate',
        );
        equal(
            transferRecoveryCopy({
                ...transfer,
                recoveryWarning: 'Recovery receipt could not be saved',
            }).warning,
            'Recovery receipt could not be saved',
            'Keep actionable journal and cleanup warnings',
        );
        equal(
            transferRecoveryCopy({ ...transfer, nativeRecovery: false }).warning,
            transfer.recoveryWarning,
            'Never reinterpret legacy recovery evidence',
        );
    });

    run('uncertain replacements and successful cleanup warnings retain distinct wording', () => {
        equal(
            transferRecoveryCopy({
                status: 'failed',
                nativeRecovery: true,
                destinationUnchanged: false,
            }).detail,
            'Replacement outcome is uncertain. Inspect the files before retrying.',
            'Do not call an uncertain target unchanged',
        );
        const copy = transferRecoveryCopy({
            status: 'completed',
            nativeRecovery: true,
            recoveryWarning: 'Backup cleanup failed',
        });
        equal(copy.detail, undefined, 'Do not describe a completed copy as uncertain');
        equal(copy.warning, 'Backup cleanup failed', 'Keep completed-copy cleanup failures');
    });

    run(
        'inspection distinguishes a temporary copy from a backup and never claims cleanup ran',
        () => {
            const file = { kind: 'File' as const, size: 12 };
            equal(
                recoveryInspectionSummary({ destination: file, stage: file, backup: null }),
                'Temporary copy retained; recovery review needed.',
                'Do not imply scheduled cleanup for an interrupted copy',
            );
            equal(
                recoveryInspectionSummary({
                    destination: file,
                    stage: file,
                    backup: null,
                    cleanupAvailable: true,
                    cleanupBlockedReason: null,
                }),
                'Temporary copy remains; verified cleanup is available.',
                'Only native eligibility enables explicit cleanup',
            );
            equal(
                recoveryInspectionSummary({ destination: file, stage: null, backup: null }),
                'No temporary copy or backup remains.',
                'Absence is not proof of automatic cleanup',
            );
            equal(
                recoveryInspectionSummary({ destination: null, stage: file, backup: file }),
                'Backup remains; review needed.',
                'Prioritize a possible original backup',
            );
            equal(
                recoveryInspectionSummary({
                    destination: file,
                    stage: { kind: 'Symlink', size: 0 },
                    backup: null,
                }),
                'Temporary path contains an unexpected entry; review needed.',
                'Do not label a substituted entry as a temporary file',
            );
            equal(
                recoveryInspectionSummary({
                    destination: null,
                    stage: { kind: 'Directory', size: 0 },
                    backup: null,
                    cleanupAvailable: true,
                    cleanupBlockedReason: null,
                }),
                'Temporary copy remains; verified cleanup is available.',
                'Folder staging reuses the same recovery presentation',
            );
        },
    );

    run('native success completes an empty transfer immediately without a progress event', () => {
        const { store, id, current } = fixture();
        store.getState().completeTransfer(id);
        equal(current().status, 'completed', 'Completion must not wait for a presentation timer');
        equal(current().progress.transferred, 0, 'An empty transfer must not invent bytes');
        equal(current().progress.total, 0, 'Unknown or empty total remains zero');
        equal(current().progress.percentage, 100, 'Terminal success can display completion');
    });

    run(
        'each successful transfer contributes usage once, including duplicate success events',
        () => {
            localStorage.clear();
            const { store, id } = fixture();
            store.getState().completeTransfer(id);
            store.getState().completeTransfer(id);
            store.getState().completeTransfer('unknown');
            equal(loadQueue().current.features.file_transfer, 1, 'Count a committed success once');
        },
    );

    run('success preserves the last observed bytes rather than inventing estimate accuracy', () => {
        const { store, id, current } = fixture();
        store.getState().updateTransferProgress(id, { transferred: 12, total: 48, percentage: 25 });
        store.getState().completeTransfer(id);
        equal(current().progress.transferred, 12, 'Estimated totals are not confirmed bytes');
        equal(current().progress.total, 48, 'The last known estimate remains available');
        equal(current().progress.percentage, 100, 'Final status can display success independently');
    });

    run('terminal outcomes ignore all later progress and conflicting outcomes', () => {
        const outcomes = ['completed', 'failed', 'cancelled'] as const;
        for (const outcome of outcomes) {
            const { store, id, current } = fixture();
            store
                .getState()
                .updateTransferProgress(id, { transferred: 12, total: 24, percentage: 50 });
            if (outcome === 'completed') {
                store.getState().completeTransfer(id);
            }
            if (outcome === 'failed') {
                store.getState().failTransfer(id, 'Permission denied');
            }
            if (outcome === 'cancelled') {
                store.getState().cancelTransfer(id);
            }
            const terminal = current();

            store
                .getState()
                .updateTransferProgress(id, { transferred: 20, total: 24, percentage: 83 });
            store.getState().completeTransfer(id);
            store.getState().failTransfer(id, 'Late error');
            store.getState().cancelTransfer(id);

            equal(current(), terminal, `${outcome} must preserve its terminal record`);
            equal(current().status, outcome, `${outcome} cannot be overwritten`);
        }
    });

    run('failure details remain until the user explicitly removes the transfer', () => {
        const { store, id, current } = fixture();
        store.getState().failTransfer(id, 'Disk full: destination write failed');
        equal(
            current().error,
            'Disk full: destination write failed',
            'Preserve the failure detail',
        );
        store.getState().failTransfer(id, 'Late generic error');
        equal(current().error, 'Disk full: destination write failed', 'Keep the original failure');
        store.getState().removeTransfer(id);
        store.getState().updateTransferProgress(id, { transferred: 1, total: 2, percentage: 50 });
        equal(store.getState().transfers.length, 0, 'Late events cannot recreate a dismissed row');
    });

    run('failure and cancellation retain the captured overwrite recovery location', () => {
        for (const outcome of ['failed', 'cancelled'] as const) {
            const store = createStore<TransferSlice>()(createTransferSlice);
            const backupPath = '/destination/file.zync-backup-original';
            const id = store.getState().addTransfer({
                sourceConnectionId: 'source',
                sourcePath: '/source/file',
                destinationConnectionId: 'destination',
                destinationPath: '/destination/file',
                recoveryBackupPath: backupPath,
            });
            if (outcome === 'failed') {
                store.getState().failTransfer(id, 'Write failed');
            } else {
                store.getState().cancelTransfer(id);
            }
            store
                .getState()
                .updateTransferProgress(id, { transferred: 100, total: 100, percentage: 100 });
            const transfer = store.getState().transfers[0];
            equal(transfer.status, outcome, 'Late progress cannot erase the terminal outcome');
            equal(
                transfer.recoveryBackupPath,
                backupPath,
                'Retain the original backup location until dismissal',
            );
            equal(
                transfer.destinationPath,
                '/destination/file',
                'Retain the partial destination location',
            );
        }
    });

    run('recovery metadata changes immutably without changing native outcomes', () => {
        for (const outcome of ['pending', 'completed', 'failed', 'cancelled'] as const) {
            const { store, id, current } = fixture();
            if (outcome === 'completed') {
                store.getState().completeTransfer(id);
            }
            if (outcome === 'failed') {
                store.getState().failTransfer(id, 'Original write error');
            }
            if (outcome === 'cancelled') {
                store.getState().cancelTransfer(id);
            }
            const before = current();
            const recovery = {
                backupPath: '/target.zync-backup-original',
                warning: 'Backup cleanup denied',
            };
            store.getState().setTransferRecovery(id, recovery);
            const warning = current();
            equal(
                before.recoveryBackupPath,
                undefined,
                'Do not mutate an existing transfer record',
            );
            equal(
                warning.status,
                outcome,
                'Recovery metadata cannot reclassify the native outcome',
            );
            equal(
                warning.error,
                before.error,
                'Recovery metadata cannot overwrite the native error',
            );
            equal(
                warning.progress,
                before.progress,
                'Recovery metadata preserves confirmed progress',
            );
            equal(warning.recoveryWarning, recovery.warning, 'Retain the cleanup failure detail');
            equal(
                warning.recoveryBackupPath,
                recovery.backupPath,
                'Retain the actionable backup path',
            );
            equal(
                isExpiringTransferReceipt(warning),
                false,
                'Recovery information cannot automatically expire',
            );
            store.getState().setTransferRecovery(id, { ...recovery });
            equal(current(), warning, 'Equivalent recovery updates do not rerender consumers');
            recovery.warning = 'Changed caller object';
            equal(
                current().recoveryWarning,
                'Backup cleanup denied',
                'Do not retain mutable caller-owned metadata',
            );

            store.getState().setTransferRecovery(id, null);
            equal(current().status, outcome, 'Confirmed cleanup cannot change the native outcome');
            equal(
                current().recoveryBackupPath,
                undefined,
                'Confirmed cleanup clears the obsolete backup path',
            );
            equal(
                current().recoveryWarning,
                undefined,
                'Confirmed cleanup clears the obsolete warning',
            );
            equal(
                isExpiringTransferReceipt(current()),
                outcome === 'completed',
                'Only a clean successful outcome may expire',
            );
        }
    });

    run('pending cleanup and recovery warnings are excluded from success receipt limits', () => {
        const { store, id: recoveryId, current } = fixture();
        const backupPath = '/destination/file.zync-backup-original';
        store.setState((state) => ({
            transfers: state.transfers.map((transfer) => ({
                ...transfer,
                recoveryBackupPath: backupPath,
            })),
        }));
        store.getState().completeTransfer(recoveryId);
        equal(
            isExpiringTransferReceipt(current()),
            false,
            'Do not expire success while backup cleanup is still running',
        );
        for (let i = 0; i < 25; i += 1) {
            const id = store.getState().addTransfer({
                sourceConnectionId: 'source',
                sourcePath: '/source/file',
                destinationConnectionId: 'destination',
                destinationPath: '/destination/file',
            });
            store.getState().completeTransfer(id);
        }
        equal(
            store.getState().transfers.filter(isExpiringTransferReceipt).length,
            20,
            'Only clean successful receipts count toward the cap',
        );
        equal(
            current().recoveryBackupPath,
            backupPath,
            'The cap cannot discard cleanup-in-flight metadata',
        );
        store
            .getState()
            .setTransferRecovery(recoveryId, { backupPath, warning: 'Backup cleanup denied' });
        equal(
            current().status,
            'completed',
            'A backup cleanup failure does not fail the confirmed native write',
        );
        equal(
            isExpiringTransferReceipt(current()),
            false,
            'A completed warning stays available until dismissed',
        );
        equal(
            store.getState().transfers.length,
            21,
            'Retained recovery receipts do not reduce the clean-success limit',
        );

        store.getState().setTransferRecovery(recoveryId, null);
        equal(
            isExpiringTransferReceipt(current()),
            true,
            'Confirmed cleanup restores normal receipt expiry',
        );
        equal(
            store.getState().transfers.filter(isExpiringTransferReceipt).length,
            20,
            'Cleanup also restores the bounded success history',
        );
        equal(
            current().recoveryBackupPath,
            undefined,
            'No stale backup path remains after successful cleanup',
        );
        store.getState().removeTransfer(recoveryId);
        const dismissed = store.getState();
        store
            .getState()
            .setTransferRecovery(recoveryId, { backupPath, warning: 'Late cleanup result' });
        equal(
            store.getState(),
            dismissed,
            'Late cleanup results cannot resurrect a dismissed receipt',
        );
    });

    run('a warning alone also prevents successful receipt expiry', () => {
        const { store, id, current } = fixture();
        store.setState((state) => ({
            transfers: state.transfers.map((transfer) => ({
                ...transfer,
                recoveryWarning: 'Recovery needs attention',
            })),
        }));
        store.getState().completeTransfer(id);
        equal(
            isExpiringTransferReceipt(current()),
            false,
            'Never expire actionable metadata because its backup path is absent',
        );
    });

    run('a cancellation acknowledgement remains active until native confirmation', () => {
        const { store, id, current } = fixture();
        store.getState().requestTransferCancellation(id);
        equal(current().status, 'cancelling', 'A request is not proof the transfer stopped');
        const requesting = current();
        store.getState().requestTransferCancellation(id);
        equal(current(), requesting, 'Duplicate cancellation requests do not replace the record');
        store.getState().updateTransferProgress(id, { transferred: 10, total: 20, percentage: 50 });
        equal(current().status, 'cancelling', 'Progress cannot erase the cancellation intent');
        store.getState().cancelTransfer(id);
        equal(current().status, 'cancelled', 'Only the native outcome confirms cancellation');
        const cancelled = current();
        store.getState().requestTransferCancellation(id);
        equal(current(), cancelled, 'A terminal cancellation cannot be requested again');
    });

    run('native success or failure can win the race with a cancellation request', () => {
        const success = fixture();
        success.store.getState().requestTransferCancellation(success.id);
        success.store.getState().completeTransfer(success.id);
        equal(
            success.current().status,
            'completed',
            'Do not relabel an already finished operation as cancelled',
        );

        const failure = fixture();
        failure.store.getState().requestTransferCancellation(failure.id);
        failure.store.getState().failTransfer(failure.id, 'Connection lost');
        equal(
            failure.current().status,
            'failed',
            'A transport failure is not confirmed cancellation',
        );
        equal(failure.current().error, 'Connection lost', 'Preserve the actual terminal error');
    });

    run('a cancel request racing native completion is informational rather than a failure', () => {
        equal(
            isBenignTransferCancelError('Transfer is no longer active'),
            true,
            'Native missing-registry outcome is benign',
        );
        equal(
            isBenignTransferCancelError(new Error('Transfer is no longer active')),
            true,
            'Handle Error-shaped native adapters too',
        );
        equal(
            isBenignTransferCancelError('Transfer not found'),
            true,
            'Retain legacy missing-transfer compatibility',
        );
        equal(
            isBenignTransferCancelError('Access denied'),
            false,
            'Real cancellation failures remain errors',
        );
    });

    run('unknown transfer events do not notify subscribers or change state', () => {
        const { store } = fixture();
        const before = store.getState();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => {
            notifications += 1;
        });
        store
            .getState()
            .updateTransferProgress('unknown', { transferred: 1, total: 2, percentage: 50 });
        store.getState().requestTransferCancellation('unknown');
        store.getState().completeTransfer('unknown');
        store.getState().failTransfer('unknown', 'Missing');
        store.getState().cancelTransfer('unknown');
        store
            .getState()
            .setTransferRecovery('unknown', { backupPath: '/missing', warning: 'Missing' });
        store.getState().setTransferRecovery('unknown', null);
        equal(store.getState(), before, 'Unknown messages keep the existing state identity');
        equal(
            notifications,
            0,
            'Ignore stale messages without rerendering every transfer consumer',
        );
        unsubscribe();
    });

    run('bounded success receipts do not discard active or unsuccessful transfers', () => {
        const { store, id: oldestActiveId } = fixture();
        const add = () =>
            store.getState().addTransfer({
                sourceConnectionId: 'source',
                sourcePath: '/source/file',
                destinationConnectionId: 'destination',
                destinationPath: '/destination/file',
            });
        const failedId = add();
        const cancelledId = add();
        store.getState().failTransfer(failedId, 'Keep this failure');
        store.getState().cancelTransfer(cancelledId);
        const successes = Array.from({ length: 25 }, add);
        for (const id of successes) {
            store.getState().completeTransfer(id);
        }
        equal(
            store.getState().transfers.filter((transfer) => transfer.status === 'completed').length,
            20,
            'Cap successful in-memory receipts',
        );
        equal(
            store.getState().transfers.find((transfer) => transfer.id === failedId)?.error,
            'Keep this failure',
            'A completion cap cannot discard a failure',
        );
        equal(
            store.getState().transfers.find((transfer) => transfer.id === cancelledId)?.status,
            'cancelled',
            'A completion cap cannot discard a cancellation',
        );
        equal(
            store.getState().transfers.find((transfer) => transfer.id === oldestActiveId)?.status,
            'pending',
            'A completion cap cannot discard a running operation',
        );

        store.getState().completeTransfer(oldestActiveId);
        equal(
            store.getState().transfers.find((transfer) => transfer.id === oldestActiveId)?.status,
            'completed',
            'Keep the newest completion even if it started first',
        );
        equal(
            store.getState().transfers.filter((transfer) => transfer.status === 'completed').length,
            20,
            'The cap remains bounded after out-of-order completion',
        );
    });
} finally {
    setUsageEnabled(usageEnabled);
    if (storageDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
    }
}
