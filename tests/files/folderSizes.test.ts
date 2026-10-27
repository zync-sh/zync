import {
    fileSelectionSizeLabel,
    fileSelectionSummary,
} from '../../src/components/file-manager/fileSelectionSummary';
import type { FileEntry } from '../../src/components/file-manager/types';
import { type FolderSizeReport, folderSizeHint } from '../../src/features/files/domain/folderSizes';
import { formatBytes } from '../../src/lib/utils';

function equal(actual: unknown, expected: unknown, label: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(label);
    }
}
const report: FolderSizeReport = {
    bytes: '18446744073709551615',
    entries: 100_000,
    files: 99_999,
    folders: 1,
    skipped: 0,
    errors: 0,
    elapsedMs: 2000,
    complete: false,
    reason: 'Entry limit reached',
};

equal(
    JSON.parse(JSON.stringify(report)).bytes,
    report.bytes,
    'native integer bytes remain lossless',
);
equal(formatBytes(Number(report.bytes)), '16 EB', 'large logical totals use a real display unit');
equal(
    folderSizeHint({ status: 'finished', report }),
    'Incomplete result: Entry limit reached.',
    'partial hint preserves the reason without redundant action instructions',
);
equal(
    folderSizeHint({ status: 'finished', report: { ...report, complete: true } }).includes(
        'Not disk space used',
    ),
    true,
    'complete is not allocated space',
);
equal(
    folderSizeHint({ status: 'unavailable', reason: 'Disconnected' }),
    'Disconnected',
    'unavailable has an explanation, not zero bytes',
);
equal(
    folderSizeHint({ status: 'cancelled' }).includes('No files were changed'),
    true,
    'cancellation remains read-only',
);
const entries = [
    { name: 'folder', path: '/folder', type: 'd', size: 999 },
    { name: 'file', path: '/file', type: '-', size: 1024 },
] as FileEntry[];
equal(
    fileSelectionSizeLabel(fileSelectionSummary(entries, ['folder'])),
    '',
    'folder-only selections omit size text rather than showing an unavailable warning',
);
equal(
    fileSelectionSizeLabel(fileSelectionSummary(entries, ['file', 'folder'])),
    'Partial · 1 KB',
    'mixed selections include only known file bytes',
);
equal(
    fileSelectionSizeLabel(fileSelectionSummary(entries, ['file'])),
    '1 KB',
    'regular-file metadata stays available without scans',
);
console.log('Folder-size domain checks passed (9).');
