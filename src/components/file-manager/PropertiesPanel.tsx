import { Folder, Info, X } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

import type { FilePermissionEditor } from '../../features/files/application/useFilePermissionEditor';
import type { FolderSizes } from '../../features/files/application/useFolderSizes';
import { unixModeString } from '../../features/files/domain/filePermissions';
import { isMatch } from '../../lib/keyboard';
import { cn, formatBytes } from '../../lib/utils';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Tooltip } from '../ui/Tooltip';
import { FileEntryIcon } from './FileEntryIcon';
import { FilePermissionsSection } from './FilePermissionsSection';
import { FolderSizeValue } from './FolderSizeValue';
import { formatFileListDate, formatFileListType } from './fileGridLayout';
import { fileSelectionSizeLabel, fileSelectionSummary } from './fileSelectionSummary';
import type { FileEntry } from './types';

interface PropertiesPanelProps {
    files: FileEntry[];
    onClose: () => void;
    dateTimeFormat?: 'simple' | 'detailed';
    showHeader?: boolean;
    permissionEditor?: FilePermissionEditor;
    folderSizes?: FolderSizes;
}

/** Uses the existing platform-neutral type labels for one selected entry. */
function fileKindLabel(file: FileEntry): string {
    if (file.type === 'd') {
        return 'Folder';
    }
    return formatFileListType(file);
}

/** Presents one immutable metadata field with selectable values. */
function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
    return (
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-3 py-1 text-xs">
            <dt className="text-app-muted">{label}</dt>
            <dd
                className={cn(
                    'min-w-0 [overflow-wrap:anywhere] text-app-text select-text',
                    mono && 'font-mono',
                )}
            >
                {value}
            </dd>
        </div>
    );
}

/** Groups the inspector's metadata rows under their existing heading. */
function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="border-t border-app-border/30 py-3">
            <h3 className="mb-1 text-xs font-medium text-app-text">{title}</h3>
            <dl>{children}</dl>
        </section>
    );
}

/** Show selected metadata and the owner's single-folder scan, never start a listing-wide scan. */
export function PropertiesPanel({
    files,
    onClose,
    dateTimeFormat = 'simple',
    showHeader = true,
    permissionEditor,
    folderSizes,
}: PropertiesPanelProps) {
    const single = files.length === 1 ? files[0] : null;
    const sizeState = single?.type === 'd' ? folderSizes?.state : undefined;
    const { folderCount, summary } = useMemo(() => {
        let folderCount = 0;
        for (const file of files) {
            if (file.type === 'd') {
                folderCount++;
            }
        }
        return {
            folderCount,
            summary: fileSelectionSummary(
                files,
                files.map((file) => file.name),
            ),
        };
    }, [files]);
    const otherCount = files.length - folderCount;

    return (
        <aside
            aria-label="File properties"
            className={cn(
                'flex h-full w-full min-w-0 flex-col bg-app-panel/70',
                !showHeader && 'max-h-[70vh]',
            )}
            onKeyDown={(event) => {
                // Inline details own dismissal, including Escape already used to hide a button's tooltip.
                // The shared dialog remains the sole dismissal owner for modal details.
                if (
                    !showHeader ||
                    event.nativeEvent.isComposing ||
                    !isMatch(event.nativeEvent, 'Escape')
                ) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }}
        >
            {showHeader && (
                <header className="flex shrink-0 items-center justify-between gap-1 border-b border-app-border/30 px-3 py-1.5">
                    <h2 className="truncate text-sm font-medium text-app-text">
                        {files.length > 1 ? `${files.length} items` : 'Properties'}
                    </h2>
                    <Tooltip
                        content="Close properties"
                        position="bottom"
                    >
                        <IconButton
                            label="Close properties"
                            icon={<X size={14} />}
                            onClick={onClose}
                            data-file-inspector-close=""
                        />
                    </Tooltip>
                </header>
            )}

            {files.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-10 text-center">
                    <Info
                        size={20}
                        className="mb-2 text-app-muted"
                    />
                    <span className="text-sm text-app-muted">Select a file or folder</span>
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-4">
                    <div className="flex items-center gap-3 py-4">
                        <div
                            aria-hidden="true"
                            className="flex h-9 w-9 shrink-0 items-center justify-center"
                        >
                            {single ? (
                                <FileEntryIcon
                                    file={single}
                                    size={32}
                                />
                            ) : (
                                <Folder
                                    size={32}
                                    fill="currentColor"
                                    className="text-app-accent"
                                    strokeWidth={0.5}
                                />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="[overflow-wrap:anywhere] text-sm font-medium text-app-text select-text">
                                {single ? single.name : `${files.length} items`}
                            </h3>
                            <div className="mt-1 text-xs text-app-muted">
                                {single
                                    ? fileKindLabel(single)
                                    : [
                                          folderCount
                                              ? `${folderCount} folder${folderCount === 1 ? '' : 's'}`
                                              : null,
                                          otherCount
                                              ? `${otherCount} file${otherCount === 1 ? '' : 's'}`
                                              : null,
                                      ]
                                          .filter(Boolean)
                                          .join(' · ')}
                            </div>
                        </div>
                    </div>

                    {single ? (
                        <>
                            <Section title="Location">
                                <dt className="sr-only">Path</dt>
                                <dd className="py-1.5 text-xs text-app-text select-text [overflow-wrap:anywhere]">
                                    {single.path || '—'}
                                </dd>
                            </Section>
                            <Section title="Information">
                                <Row
                                    label="Size"
                                    value={
                                        single.type === 'd' ? (
                                            <FolderSizeValue
                                                state={sizeState}
                                                onDetails={() => folderSizes?.inspect()}
                                            />
                                        ) : (
                                            formatBytes(single.size)
                                        )
                                    }
                                />
                                {single.type === 'd' &&
                                    folderSizes &&
                                    (folderSizes.active ||
                                        sizeState?.status === 'cancelled' ||
                                        sizeState?.status === 'unavailable') && (
                                        <Row
                                            label="Contents"
                                            value={
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={
                                                        folderSizes.active
                                                            ? folderSizes.cancel
                                                            : folderSizes.start
                                                    }
                                                >
                                                    {folderSizes.active
                                                        ? 'Cancel calculation'
                                                        : 'Retry calculation'}
                                                </Button>
                                            }
                                        />
                                    )}
                                <Row
                                    label="Type"
                                    value={fileKindLabel(single)}
                                />
                                <Row
                                    label="Modified"
                                    value={
                                        formatFileListDate(
                                            single.lastModified,
                                            Date.now(),
                                            dateTimeFormat,
                                        ) || '—'
                                    }
                                />
                            </Section>
                            {permissionEditor ? (
                                <FilePermissionsSection
                                    editor={permissionEditor}
                                    ownerLabel={single.owner}
                                    groupLabel={single.group}
                                />
                            ) : (
                                <Section title="Permissions">
                                    <Row
                                        label="Owner"
                                        value={(single.owner || '').trim() || '—'}
                                    />
                                    <Row
                                        label="Group"
                                        value={(single.group || '').trim() || '—'}
                                    />
                                    <Row
                                        label="Mode"
                                        value={unixModeString(single.permissions || '')}
                                        mono
                                    />
                                    <Row
                                        label="Octal"
                                        value={single.permissions?.trim() || '—'}
                                        mono
                                    />
                                </Section>
                            )}
                            {!permissionEditor && (
                                <p className="pb-4 text-xs leading-relaxed text-app-muted">
                                    Reported metadata only. Effective access may also depend on ACLs
                                    and server policy. File mode alone does not determine rename or
                                    delete access.
                                </p>
                            )}
                        </>
                    ) : (
                        <Section title="Selection">
                            <Row
                                label="Items"
                                value={String(files.length)}
                            />
                            <Row
                                label="Size"
                                value={fileSelectionSizeLabel(summary) || '—'}
                            />
                            <Row
                                label="Folders"
                                value={String(folderCount)}
                            />
                            <Row
                                label="Files"
                                value={String(otherCount)}
                            />
                        </Section>
                    )}
                </div>
            )}
        </aside>
    );
}
