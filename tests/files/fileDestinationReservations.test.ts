import {
    executeFileTransfer,
    type FileTransferExecution,
    type FileTransferRequest,
} from '../../src/features/files/application/executeFileTransfer';
import {
    acquireFileDestination,
    acquireFileDestinations,
    assertFileDestinationReservation,
    type FileDestinationReservation,
} from '../../src/features/files/application/fileDestinationReservations';

function equal(actual: unknown, expected: unknown, message: string): void {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function throws(action: () => unknown, text: string): void {
    try {
        action();
    } catch (error) {
        if (String(error).includes(text)) {
            return;
        }
        throw error;
    }
    throw new Error(`Expected an error containing ${text}`);
}

async function rejects(action: Promise<unknown>, text: string): Promise<void> {
    try {
        await action;
    } catch (error) {
        if (String(error).includes(text)) {
            return;
        }
        throw error;
    }
    throw new Error(`Expected an error containing ${text}`);
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

async function run(name: string, test: () => Promise<void>): Promise<void> {
    await test();
    console.log(`  ok ${name}`);
}

const request: FileTransferRequest = {
    transferId: 'reservation-test',
    sourceConnectionId: 'source',
    sourcePath: '/source',
    destinationConnectionId: 'destination',
    destinationPath: '/target/file',
};

function execution(invoke: FileTransferExecution['invoke']) {
    const outcomes: string[] = [];
    return {
        outcomes,
        ports: {
            invoke: async (command: string, args: Record<string, unknown>) => {
                await invoke(command, args);
                if (command === 'fs_transfer_file') {
                    return {
                        version: 1,
                        id: args.transferId,
                        sourceConnectionId: args.sourceConnectionId,
                        sourcePath: args.sourcePath,
                        destinationConnectionId: args.destinationConnectionId,
                        destinationPath: args.destinationPath,
                        stagePath: '/target/.zync-transfer-test.part',
                        backupPath: '/target/.zync-transfer-test.backup',
                        backupExpected: false,
                        phase: 'completed',
                        createdAt: 1,
                        transferred: 1,
                        total: 1,
                        destinationUnchanged: false,
                        warning: null,
                        error: null,
                    };
                }
            },
            completeTransfer: () => {
                outcomes.push('completed');
            },
            failTransfer: (_id: string, error: string) => {
                outcomes.push(`failed:${error}`);
            },
            cancelTransfer: () => {
                outcomes.push('cancelled');
            },
        },
    };
}

await run(
    'reservations reject same-endpoint equal, descendant and ancestor destinations',
    async () => {
        const reservation = acquireFileDestination('endpoint', '/target/folder/');
        const independent: FileDestinationReservation[] = [];
        try {
            for (const path of ['/target/folder', '/target/folder/child', '/target']) {
                throws(() => acquireFileDestination('endpoint', path), 'Destination is busy:');
            }
            independent.push(acquireFileDestination('other-endpoint', '/target/folder'));
            independent.push(acquireFileDestination('endpoint', '/target/folder-sibling'));
            equal(
                independent.length,
                2,
                'Endpoint boundaries and sibling prefixes must remain independent',
            );
        } finally {
            independent.forEach((item) => item.release());
            reservation.release();
        }
    },
);

await run(
    'borrowed reservations require the exact registered lease and matching destination',
    async () => {
        const reservation = acquireFileDestination('endpoint', '/target/');
        try {
            assertFileDestinationReservation(reservation, 'endpoint', '/target');
            throws(
                () => assertFileDestinationReservation(reservation, 'other', '/target'),
                'does not match',
            );
            throws(
                () => assertFileDestinationReservation(reservation, 'endpoint', '/target/child'),
                'does not match',
            );
            throws(
                () => assertFileDestinationReservation({ ...reservation }, 'endpoint', '/target'),
                'no longer active',
            );
        } finally {
            reservation.release();
        }
        throws(
            () => assertFileDestinationReservation(reservation, 'endpoint', '/target'),
            'no longer active',
        );
        const replacement = acquireFileDestination('endpoint', '/target');
        try {
            reservation.release();
            throws(() => acquireFileDestination('endpoint', '/target'), 'Destination is busy:');
        } finally {
            replacement.release();
        }
    },
);

await run(
    'Windows-style separators share one reservation without normalizing POSIX filename bytes',
    async () => {
        const windows = acquireFileDestination('local', 'C:\\target\\folder');
        const posix = acquireFileDestination('remote', '/target/a\\b');
        try {
            throws(
                () => acquireFileDestination('local', 'C:/target/folder/child'),
                'Destination is busy:',
            );
            assertFileDestinationReservation(windows, 'local', 'C:/target/folder');
            const distinctPosix = acquireFileDestination('remote', '/target/a/b');
            distinctPosix.release();
        } finally {
            windows.release();
            posix.release();
        }
    },
);

await run(
    'one mutation coalesces its own overlapping paths without weakening external exclusion',
    async () => {
        const reservations = acquireFileDestinations('group', [
            '/folder/child',
            '/folder',
            '/folder/',
            '/sibling',
        ]);
        try {
            equal(
                reservations.length,
                2,
                'A parent path covers its own descendants and duplicate spellings',
            );
            throws(() => acquireFileDestination('group', '/folder/child'), 'Destination is busy:');
            throws(() => acquireFileDestination('group', '/sibling'), 'Destination is busy:');
        } finally {
            reservations.forEach((reservation) => reservation.release());
        }
        const owner = acquireFileDestination('group', '/busy');
        try {
            throws(
                () => acquireFileDestinations('group', ['/free', '/busy/child']),
                'Destination is busy:',
            );
            acquireFileDestination('group', '/free').release();
            throws(() => acquireFileDestination('group', '/busy'), 'Destination is busy:');
        } finally {
            owner.release();
        }
        const windows = acquireFileDestinations('local', ['C:\\folder\\file', 'C:/folder/file']);
        try {
            equal(windows.length, 1, 'Equivalent rename paths must not reject their own lease');
        } finally {
            windows.forEach((reservation) => reservation.release());
        }
    },
);

await run('large flat batches avoid self-comparison and coalesce interleaved parents', async () => {
    const paths = Array.from({ length: 5000 }, (_, index) => `/batch/item-${index}`);
    const flat = acquireFileDestinations('large-batch', paths);
    try {
        equal(
            flat.length,
            paths.length,
            'Keep distinct sibling destinations available as one admission',
        );
    } finally {
        flat.forEach((reservation) => reservation.release());
    }
    const nested = acquireFileDestinations('large-batch', [
        '/batch/a/child',
        '/batch/a-sibling',
        '/batch/a',
        '/batch/b/deep/leaf',
        '/batch/b',
        '/batch/root/leaf',
        '/batch/root/',
    ]);
    try {
        equal(
            nested.length,
            4,
            'Parent discovery is independent of input ordering and sibling prefixes',
        );
    } finally {
        nested.forEach((reservation) => reservation.release());
    }
});

await run(
    'an awaited transfer reserves its destination until the actual native outcome',
    async () => {
        const native = deferred();
        const first = execution((command, args) => {
            equal(
                command,
                'fs_transfer_file',
                'A reservation must cover the complete staged native operation',
            );
            equal(args.destinationPath, request.destinationPath, 'Retain the admitted destination');
            return native.promise;
        });
        const running = executeFileTransfer(request, first.ports);
        let secondCalls = 0;
        const second = execution(async () => {
            secondCalls += 1;
        });
        await rejects(
            executeFileTransfer({ ...request, transferId: 'second' }, second.ports),
            'Destination is busy:',
        );
        equal(secondCalls, 0, 'A busy destination cannot begin another native write');
        equal(
            second.outcomes.length,
            1,
            'Retain a useful setup failure instead of leaving a pending receipt',
        );
        equal(
            second.outcomes[0].startsWith('failed:Destination is busy:'),
            true,
            'Expose the actual admission conflict',
        );
        equal(first.outcomes.length, 0, 'Admission is not completion');
        native.resolve();
        await running;
        equal(first.outcomes[0], 'completed', 'Release only after confirmed completion');
        const next = acquireFileDestination(
            request.destinationConnectionId,
            request.destinationPath,
        );
        next.release();
    },
);

await run(
    'native failure, cancellation and synchronous invoke errors release owned reservations',
    async () => {
        for (const error of [
            'Cancelled',
            'Destination write failed',
            new Error('Invoke unavailable'),
        ]) {
            const fixture = execution(() => {
                throw error;
            });
            await rejects(
                executeFileTransfer(request, fixture.ports),
                error instanceof Error ? error.message : error,
            );
            equal(
                fixture.outcomes[0],
                error === 'Cancelled'
                    ? 'cancelled'
                    : `failed:${error instanceof Error ? error.message : error}`,
                'Preserve the native outcome',
            );
            const next = acquireFileDestination(
                request.destinationConnectionId,
                request.destinationPath,
            );
            next.release();
        }
    },
);

await run(
    'local imports preserve the native local copy route and reserve through terminal completion',
    async () => {
        const native = deferred();
        const local = { ...request, sourceConnectionId: 'local', destinationConnectionId: 'local' };
        const fixture = execution((command, args) => {
            equal(command, 'fs_transfer_file', 'Local imports use native staging');
            equal(args.destinationConnectionId, 'local', 'Use the native local endpoint');
            return native.promise;
        });
        const running = executeFileTransfer(local, fixture.ports);
        throws(
            () => acquireFileDestination('local', local.destinationPath),
            'Destination is busy:',
        );
        native.resolve();
        await running;
        equal(fixture.outcomes[0], 'completed', 'Retain actual local-copy completion');
        acquireFileDestination('local', local.destinationPath).release();
    },
);

await run('local imports reject lexical source overlap before native mutation', async () => {
    let calls = 0;
    for (const [sourcePath, destinationPath] of [
        ['/source/file', '/source/file'],
        ['/source', '/source/child'],
        ['/source/child', '/source'],
        ['C:\\source\\file', 'C:/source/file'],
    ]) {
        const fixture = execution(async () => {
            calls += 1;
        });
        await rejects(
            executeFileTransfer(
                {
                    ...request,
                    sourceConnectionId: 'local',
                    destinationConnectionId: 'local',
                    sourcePath,
                    destinationPath,
                },
                fixture.ports,
            ),
            'paths overlap',
        );
        equal(fixture.outcomes.length, 1, 'Retain the rejected setup outcome');
    }
    equal(calls, 0, 'Self-copy must not truncate the original');
});

await run('borrowed transfer reservations remain owned through replacement cleanup', async () => {
    for (const failed of [false, true]) {
        const reservation = acquireFileDestination(
            request.destinationConnectionId,
            request.destinationPath,
        );
        try {
            const fixture = execution(async () => {
                if (failed) {
                    throw 'Write failed';
                }
            });
            const result = executeFileTransfer(request, fixture.ports, reservation);
            if (failed) {
                await rejects(result, 'Write failed');
            } else {
                await result;
            }
            assertFileDestinationReservation(
                reservation,
                request.destinationConnectionId,
                request.destinationPath,
            );
            throws(
                () =>
                    acquireFileDestination(
                        request.destinationConnectionId,
                        request.destinationPath,
                    ),
                'Destination is busy:',
            );
        } finally {
            reservation.release();
        }
    }
});

await run(
    'invalid borrowed leases fail before invocation without releasing another operation',
    async () => {
        const owner = acquireFileDestination(
            request.destinationConnectionId,
            request.destinationPath,
        );
        const released = acquireFileDestination('other', '/released');
        released.release();
        let calls = 0;
        try {
            for (const reservation of [released, { ...owner }, owner]) {
                const fixture = execution(async () => {
                    calls += 1;
                });
                const candidate =
                    reservation === owner ? { ...request, destinationPath: '/different' } : request;
                await rejects(
                    executeFileTransfer(candidate, fixture.ports, reservation),
                    'reservation is no longer active or does not match',
                );
                equal(
                    fixture.outcomes.length,
                    1,
                    'Reject stale or mismatched leases with a retained failure',
                );
            }
            equal(calls, 0, 'No invalid lease may reach native mutation');
            assertFileDestinationReservation(
                owner,
                request.destinationConnectionId,
                request.destinationPath,
            );
        } finally {
            owner.release();
        }
    },
);
