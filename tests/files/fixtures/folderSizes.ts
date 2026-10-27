import type { FolderSizeReport } from '../../../src/features/files/domain/folderSizes';

/** Isolated read-only IPC boundary. Real queue, lifecycle and presentation run unchanged. */
export function createFolderSizeFixture(deferResults = true) {
    const calls: { command: string; id?: string; path?: string }[] = [];
    const pending = new Map<
        string,
        { resolve: (report: FolderSizeReport) => void; reject: (error: Error) => void }
    >();
    let acknowledge: (() => void) | undefined;
    let defer = false;
    const report: FolderSizeReport = {
        bytes: '12345',
        entries: 12,
        files: 8,
        folders: 3,
        skipped: 1,
        errors: 0,
        elapsedMs: 140,
        complete: true,
        reason: 'Traversal finished',
    };
    const takePending = () => {
        const first = pending.entries().next().value;
        if (!first) {
            throw new Error('No pending folder-size request');
        }
        pending.delete(first[0]);
        return first[1];
    };
    return {
        handles: (command: string) =>
            ['fs_folder_size_begin', 'fs_folder_size_calculate', 'fs_folder_size_cancel'].includes(
                command,
            ),
        invoke: async (command: string, args: { id?: string; path?: string }) => {
            calls.push({ command, ...args });
            if (command === 'fs_folder_size_begin' && defer) {
                defer = false;
                await new Promise<void>((resolve) => {
                    acknowledge = resolve;
                });
            }
            if (command === 'fs_folder_size_calculate') {
                return deferResults
                    ? new Promise<FolderSizeReport>((resolve, reject) =>
                          pending.set(args.id!, { resolve, reject }),
                      )
                    : { ...report };
            }
        },
        control: {
            calls,
            pending: () => pending.size,
            deferAdmission: () => {
                defer = true;
            },
            acknowledge: () => {
                acknowledge?.();
                acknowledge = undefined;
            },
            finish: (updates: Partial<FolderSizeReport> = {}) => {
                takePending().resolve({ ...report, ...updates });
            },
            fail: (reason: string) => takePending().reject(new Error(reason)),
        },
    };
}
