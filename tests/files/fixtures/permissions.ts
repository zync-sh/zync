import type {
    AdministratorPermissionReply,
    FileAccessEvidence,
    FilePermissionMetadata,
    FilePermissionOutcome,
} from '../../../src/features/files/domain/filePermissions';

/** Isolated permission boundary for the real Files component; mutations are opt-in.
 * This fixture cannot reach native IPC, real paths, hosts or account credentials.
 */
export function createPermissionFixture(enabled: boolean, editorEnabled = false) {
    let session = 'fixture-channel';
    let model: FilePermissionMetadata['binding']['model'] = 'posix';
    let mode = 0o102640;
    let kind: FilePermissionMetadata['snapshot']['kind'] = 'File';
    let nextOutcome: FilePermissionOutcome['status'] = 'verified';
    let deferredRead = false;
    let deferredApply = false;
    let resolveRead: (() => void) | undefined;
    let resolveApply: (() => void) | undefined;
    let deferRefresh = false;
    let rejectRefresh: (() => void) | undefined;
    const reads: string[] = [];
    const writes: { path: string; setBits: number; clearBits: number }[] = [];
    const editorWrites: { path: string; content: string }[] = [];
    const accessReads: { directory: string; target: string | null }[] = [];
    const copyChecks: string[][] = [];
    let copyError: string | null = null;
    let deferCopy = false;
    let finishCopy: (() => void) | undefined;
    let access: Pick<FileAccessEvidence, 'directoryAccess' | 'targetAccess'> = {
        directoryAccess: { createFile: null, createFolder: null },
        targetAccess: { read: null, write: null, rename: null, delete: null },
    };
    let deferAccess = false;
    let finishAccess: (() => void) | undefined;
    let readError = false;
    let writeAccess: boolean | null = null;
    let readOnly = true;
    let writeError: string | null = null;
    let systemEditor = false;
    let deferredSystemEditor = false;
    let finishSystemEditor: (() => void) | undefined;
    let systemEditorError = false;
    const systemEditorOpens: FilePermissionMetadata[] = [];
    let requestPassword = true;
    let adminSequence = 0;
    let adminMode = 0o100400;
    let adminDeferred = false;
    let finishAdmin: (() => void) | undefined;
    let failAdmin = false;
    let malformedAdmin = false;
    const adminStarts: string[] = [],
        adminCancels: string[] = [];
    const adminWrites: { path: string; setBits: number; clearBits: number }[] = [];
    let adminAuthentications = 0;
    const adminChallenges = new Map<
        string,
        { path: string; session: string; phase: 'password' | 'prepared'; token: string }
    >();
    const waitAdmin = async () => {
        if (!adminDeferred) {
            return;
        }
        adminDeferred = false;
        await new Promise<void>((resolve) => {
            finishAdmin = resolve;
        });
    };
    const metadata = (path: string): FilePermissionMetadata => ({
        path,
        canonicalParent: path.slice(0, path.lastIndexOf('/')),
        binding: { identity: 'fixture-account', session, model },
        snapshot: { kind, size: '42', modified: '10', mode: model === 'posix' ? mode : null },
        uid: 0,
        gid: 123,
        linkCount: null,
        readOnly: model === 'windows' ? readOnly : null,
        writeAccess,
        systemEditor:
            systemEditor && model === 'windows' && (kind === 'File' || kind === 'Directory'),
        editUnavailable:
            systemEditor && model === 'windows' && (kind === 'File' || kind === 'Directory')
                ? null
                : model !== 'posix'
                  ? 'Windows uses access-control lists. POSIX mode editing is not supported here.'
                  : kind !== 'File' && kind !== 'Directory'
                    ? 'Links and special entries are not editable.'
                    : null,
    });
    return {
        handles: (command: string) =>
            command === 'fs_permissions_read' ||
            command === 'fs_permissions_apply' ||
            command === 'fs_permissions_access' ||
            command === 'fs_copy_access' ||
            (enabled && command === 'fs_permissions_open_system_editor') ||
            (enabled && command.startsWith('fs_permissions_admin_')) ||
            (editorEnabled && (command === 'fs_read_file' || command === 'fs_write_file')),
        invoke: async (command: string, args: Record<string, unknown>) => {
            if (command === 'fs_copy_access') {
                copyChecks.push([...(args.paths as string[])]);
                const error = copyError;
                if (deferCopy) {
                    deferCopy = false;
                    await new Promise<void>((resolve) => {
                        finishCopy = () => {
                            finishCopy = undefined;
                            resolve();
                        };
                    });
                }
                if (error) {
                    throw error;
                }
                return;
            }
            if (command === 'fs_permissions_access') {
                const request = {
                    directory: String(args.directory),
                    target: typeof args.target === 'string' ? args.target : null,
                };
                accessReads.push(request);
                const evidence: FileAccessEvidence = {
                    ...request,
                    directoryAccess: { ...access.directoryAccess },
                    targetAccess: request.target
                        ? { ...access.targetAccess }
                        : { read: null, write: null, rename: null, delete: null },
                };
                if (deferAccess) {
                    deferAccess = false;
                    await new Promise<void>((resolve) => {
                        finishAccess = resolve;
                    });
                }
                return evidence;
            }
            if (editorEnabled && command === 'fs_read_file') {
                return `Fixture content for ${String(args.path)}\n`;
            }
            if (editorEnabled && command === 'fs_write_file') {
                editorWrites.push({ path: String(args.path), content: String(args.content) });
                if (writeError) {
                    throw writeError;
                } // Exercise Tauri's string rejection, not just Error objects.
                return;
            }
            if (command === 'fs_permissions_read') {
                const path = String(args.path);
                reads.push(path);
                if (readError) {
                    throw new Error('Simulated permission metadata unavailable');
                }
                const captured = metadata(path);
                if (deferredRead) {
                    deferredRead = false;
                    await new Promise<void>((resolve) => {
                        resolveRead = resolve;
                    });
                }
                return captured;
            }
            if (!enabled) {
                throw new Error('Permission mutations are disabled in the normal UI fixture');
            }
            if (command.startsWith('fs_permissions_admin_')) {
                const id = String(args.challengeId);
                if (command === 'fs_permissions_admin_cancel') {
                    adminCancels.push(id);
                    adminChallenges.delete(id);
                    return;
                }
                const rootMetadata = (path: string): FilePermissionMetadata => ({
                    ...metadata(path),
                    uid: 9999,
                    gid: 8888,
                    snapshot: { ...metadata(path).snapshot, mode: adminMode },
                    linkCount: 1,
                });
                const prepared = (
                    challengeId: string,
                    path: string,
                    token: string,
                ): AdministratorPermissionReply => ({
                    challengeId,
                    reviewToken: malformedAdmin ? null : token,
                    status: 'prepared',
                    metadata: rootMetadata(path),
                    outcome: null,
                });
                if (command === 'fs_permissions_admin_start') {
                    const expected = args.expected as FilePermissionMetadata;
                    if (expected.binding.session !== session) {
                        throw new Error('Connection changed. Refresh permissions.');
                    }
                    adminStarts.push(expected.path);
                    const challengeId = `fixture-review-${++adminSequence}`;
                    const challenge = {
                        path: expected.path,
                        session,
                        phase: requestPassword ? ('password' as const) : ('prepared' as const),
                        token: `fixture-review-token-${adminSequence}`,
                    };
                    adminChallenges.set(challengeId, challenge);
                    await waitAdmin();
                    if (failAdmin) {
                        throw new Error('Simulated administrator operation unavailable');
                    }
                    return requestPassword
                        ? ({
                              challengeId,
                              reviewToken: null,
                              status: 'password',
                              metadata: null,
                              outcome: null,
                          } satisfies AdministratorPermissionReply)
                        : prepared(challengeId, challenge.path, challenge.token);
                }
                const challenge = adminChallenges.get(id);
                if (!challenge || challenge.session !== session) {
                    throw new Error('Administrator review expired or connection changed.');
                }
                if (command === 'fs_permissions_admin_authenticate') {
                    if (challenge.phase !== 'password') {
                        throw new Error('Administrator review is not awaiting a password');
                    }
                    adminAuthentications++; // Never retain even a fixture password.
                    await waitAdmin();
                    if (failAdmin) {
                        throw new Error('Simulated sudo authentication refused');
                    }
                    challenge.phase = 'prepared';
                    return prepared(id, challenge.path, challenge.token);
                }
                if (command === 'fs_permissions_admin_apply') {
                    if (challenge.phase !== 'prepared' || args.reviewToken !== challenge.token) {
                        throw new Error('Review token is required');
                    }
                    const setBits = Number(args.setBits),
                        clearBits = Number(args.clearBits);
                    adminWrites.push({ path: challenge.path, setBits, clearBits });
                    await waitAdmin();
                    if (failAdmin) {
                        throw new Error(
                            'Administrator result is unknown. Inspect the host path before retrying.',
                        );
                    }
                    adminMode = (adminMode | setBits) & ~clearBits;
                    adminChallenges.delete(id);
                    return {
                        challengeId: id,
                        reviewToken: null,
                        status: 'finished',
                        metadata: null,
                        outcome: {
                            status: 'verified',
                            metadata: rootMetadata(challenge.path),
                            message:
                                'Administrator mode change verified. Refresh to return to ordinary-account permissions.',
                        },
                    } satisfies AdministratorPermissionReply;
                }
                throw new Error('Unknown administrator fixture command');
            }
            const expected = args.expected as FilePermissionMetadata;
            if (expected.binding.session !== session) {
                throw new Error('Connection changed. Refresh permissions before editing.');
            }
            if (command === 'fs_permissions_open_system_editor') {
                if (
                    args.connectionId !== 'local' ||
                    !expected.systemEditor ||
                    expected.binding.model !== 'windows'
                ) {
                    throw new Error(
                        'Windows permission settings are unavailable for this endpoint.',
                    );
                }
                systemEditorOpens.push(expected);
                if (deferredSystemEditor) {
                    deferredSystemEditor = false;
                    await new Promise<void>((resolve) => {
                        finishSystemEditor = resolve;
                    });
                }
                if (systemEditorError) {
                    throw new Error('Simulated Windows settings invocation failed');
                }
                return;
            }
            const setBits = Number(args.setBits),
                clearBits = Number(args.clearBits);
            writes.push({ path: expected.path, setBits, clearBits });
            if (deferredApply) {
                deferredApply = false;
                await new Promise<void>((resolve) => {
                    resolveApply = resolve;
                });
            }
            if (nextOutcome === 'verified' || nextOutcome === 'adjusted') {
                mode = (mode | setBits) & ~clearBits;
            }
            return {
                status: nextOutcome,
                metadata:
                    nextOutcome === 'verified' || nextOutcome === 'adjusted'
                        ? metadata(expected.path)
                        : null,
                message:
                    nextOutcome === 'verified'
                        ? 'Permissions updated; current mode verified.'
                        : 'Permission change outcome requires review. Refresh to check the current mode.',
            } satisfies FilePermissionOutcome;
        },
        control: {
            copyChecks,
            setCopyError: (message: string | null) => {
                copyError = message;
            },
            deferCopy: () => {
                deferCopy = true;
            },
            finishCopy: () => {
                finishCopy?.();
            },
            copyPending: () => Boolean(finishCopy),
            reads,
            writes,
            editorWrites,
            accessReads,
            systemEditorOpens,
            adminStarts,
            adminCancels,
            adminWrites,
            adminAuthentications: () => adminAuthentications,
            requestAdminPassword: (value: boolean) => {
                requestPassword = value;
            },
            deferAdmin: () => {
                adminDeferred = true;
            },
            finishAdmin: () => {
                finishAdmin?.();
                finishAdmin = undefined;
            },
            adminPending: () => Boolean(finishAdmin),
            failAdmin: (value: boolean) => {
                failAdmin = value;
            },
            malformedAdmin: (value: boolean) => {
                malformedAdmin = value;
            },
            setSystemEditor: (value: boolean) => {
                systemEditor = value;
            },
            deferSystemEditor: () => {
                deferredSystemEditor = true;
            },
            finishSystemEditor: () => {
                finishSystemEditor?.();
                finishSystemEditor = undefined;
            },
            systemEditorPending: () => Boolean(finishSystemEditor),
            failSystemEditor: (value: boolean) => {
                systemEditorError = value;
            },
            setAccess: (value: typeof access) => {
                access = value;
            },
            deferAccess: () => {
                deferAccess = true;
            },
            finishAccess: () => {
                finishAccess?.();
                finishAccess = undefined;
            },
            accessPending: () => Boolean(finishAccess),
            failRead: (value: boolean) => {
                readError = value;
            },
            setWriteAccess: (value: boolean | null) => {
                writeAccess = value;
            },
            setReadOnly: (value: boolean) => {
                readOnly = value;
            },
            failWrite: (value: string | null) => {
                writeError = value;
            },
            setModel: (value: typeof model) => {
                model = value;
            },
            setKind: (value: typeof kind) => {
                kind = value;
            },
            setMode: (value: number) => {
                mode = value;
            },
            setOutcome: (value: typeof nextOutcome) => {
                nextOutcome = value;
            },
            reconnect: () => {
                session += '-new';
            },
            deferRead: () => {
                deferredRead = true;
            },
            finishRead: () => {
                resolveRead?.();
                resolveRead = undefined;
            },
            readPending: () => Boolean(resolveRead),
            deferApply: () => {
                deferredApply = true;
            },
            finishApply: () => {
                resolveApply?.();
                resolveApply = undefined;
            },
            applyPending: () => Boolean(resolveApply),
            deferRefresh: () => {
                deferRefresh = true;
            },
            refreshPending: () => Boolean(rejectRefresh),
            rejectRefresh: () => {
                rejectRefresh?.();
                rejectRefresh = undefined;
            },
            awaitListingRefresh: async () => {
                if (!deferRefresh) {
                    return;
                }
                deferRefresh = false;
                await new Promise<void>((_, reject) => {
                    rejectRefresh = () => reject(new Error('Simulated listing refresh failure'));
                });
            },
        },
    };
}
