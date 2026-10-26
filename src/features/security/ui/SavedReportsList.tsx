import { useId, useState, type Ref } from 'react';
import { ChevronLeft, ChevronRight, Download, FolderOpen, GitCompareArrows, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import type { ReportExportFormat, SavedReportSummary } from '../domain/savedReports';
import { ReportExportMenu } from './ReportActionMenu';

const PAGE_SIZE = 5;

/** The default inline history view reads summaries only; bodies and exports require an explicit action. */
export function SavedReportsList({ rows, status, busy, comparisonLabel, opening, preparingDelete, refreshing, headingRef, hostLabel, emptyMessage, onCancelOpen, onRefresh, onOpen, onCompare, onDelete, onImport, onExport }: {
    rows: readonly SavedReportSummary[]; status: 'idle' | 'loading' | 'ready' | 'failed'; busy: boolean; comparisonLabel?: string; opening?: string; preparingDelete?: string; refreshing?: boolean; headingRef?: Ref<HTMLHeadingElement>;
    onCancelOpen(): void; onRefresh(): void; onOpen(item: SavedReportSummary): void; onCompare(item: SavedReportSummary): void;
    hostLabel?(item: SavedReportSummary): string; emptyMessage?: string;
    onDelete(item: SavedReportSummary): void; onImport?(): void; onExport(item: SavedReportSummary, format: ReportExportFormat): void;
}) {
    const [page, setPage] = useState(0);
    const rowId = useId();
    const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
    const currentPage = Math.min(page, lastPage);
    return <section aria-label="Saved reports" aria-busy={refreshing || Boolean(preparingDelete)} className="rounded-xl border border-app-border bg-app-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-4 py-3">
            <div><h2 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">Saved reports</h2>
                <p className="mt-1 text-[11px] text-app-muted">On this device · {rows.length} saved{comparisonLabel ? ` · Active report: ${comparisonLabel}` : ''}</p></div>
            <div className="flex flex-wrap items-center gap-1">
                {onImport && <Button size="sm" variant="ghost" disabled={busy} onClick={onImport}><Upload size={13} className="mr-2" aria-hidden="true" />Import JSON</Button>}
                <Button size="icon" variant="ghost" aria-label="Refresh saved reports" disabled={busy} onClick={onRefresh}><RefreshCw size={14} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden="true" /></Button>
            </div>
        </div>
        {opening && <div role="status" className="flex items-center justify-between gap-3 border-b border-app-border px-4 py-2 text-xs text-app-muted">
            <span className="inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Opening report…</span>
            <Button variant="ghost" size="sm" onClick={onCancelOpen}>Cancel opening</Button>
        </div>}
        {status === 'idle' || status === 'loading' ? <p role="status" className="px-4 py-6 text-xs text-app-muted">Loading saved reports…</p>
            : status === 'failed' ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-app-muted">Saved reports could not be loaded.<Button variant="ghost" size="sm" onClick={onRefresh} disabled={busy}>Retry</Button></div>
                : rows.length === 0 ? <div className="flex items-center gap-3 px-4 py-6 text-xs text-app-muted"><FolderOpen size={20} className="shrink-0" aria-hidden="true" /><p>{emptyMessage ?? 'No saved reports yet. Run an assessment, then choose Save report.'}</p></div>
                    : <ul className="divide-y divide-app-border">{rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(item => <li key={item.id} className="relative px-4 py-3 hover:bg-app-surface/50">
                        <button type="button" disabled={busy} onClick={() => onOpen(item)} aria-labelledby={`${rowId}-${item.id}-title`} aria-describedby={`${rowId}-${item.id}-summary`}
                            className="absolute inset-0 w-full cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-control-focus disabled:cursor-default" />
                        <div className="pointer-events-none flex flex-col gap-3 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><h3 id={`${rowId}-${item.id}-title`} className="break-words text-xs font-semibold">{item.name}</h3>
                            <p id={`${rowId}-${item.id}-summary`} className="mt-1 break-words text-[11px] text-app-muted">{hostLabel && <span className="mb-1 block break-all">{hostLabel(item)}</span>}{new Date(item.completedAt).toLocaleString()} · {item.findings} checks · {item.attention} need attention</p></div>
                            <div className="pointer-events-auto relative z-10 flex flex-wrap items-center gap-1">
                                {comparisonLabel && <Button variant="ghost" size="icon" disabled={busy} aria-label={`Compare ${item.name}`} onClick={() => onCompare(item)}><GitCompareArrows size={14} aria-hidden="true" /></Button>}
                                <ReportExportMenu label={<><Download size={14} aria-hidden="true" /><span className="sr-only">Export {item.name}</span></>} disabled={busy} onExport={format => onExport(item, format)} />
                                <Button variant="ghost" size="icon" disabled={busy} aria-busy={preparingDelete === item.id} aria-label={`Delete ${item.name}`} onClick={() => onDelete(item)}>
                                    {preparingDelete === item.id ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                                </Button>
                            </div></div>
                    </li>)}</ul>}
        {rows.length > PAGE_SIZE && <div className="flex items-center justify-between gap-3 border-t border-app-border px-4 py-2 text-[11px] text-app-muted"><span>{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, rows.length)} of {rows.length}</span>
            <div className="flex items-center gap-1"><Button variant="ghost" size="icon" aria-label="Previous saved reports" disabled={busy || currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></Button>
                <Button variant="ghost" size="icon" aria-label="Next saved reports" disabled={busy || currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></Button></div></div>}
    </section>;
}
