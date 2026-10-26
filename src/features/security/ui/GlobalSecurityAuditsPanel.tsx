import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HardeningAuditIcon } from '../../../components/icons/HardeningAuditIcon';
import { Plus } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { useAppStore } from '../../../store/useAppStore';
import { builtinWorkspaceViewLabel } from '../../workspace/domain/registrations';
import { useShowHostAddressesInLists } from '../../connections/presentation/useConnectionDisplayLabels';
import { useReportLibrary } from '../application/useReportLibrary';
import { reportRiskRemovals, type SavedRisk } from '../domain/acceptedRisks';
import { savedReportHostKey, savedReportHostLabel, savedReportSubject, type ReportExportFormat, type SavedReportSummary } from '../domain/savedReports';
import { exportReport } from '../infrastructure/reportLibraryIpc';
import { AssessmentReports } from './AssessmentReports';
import { DeleteReportDialog } from './DeleteReportDialog';
import { SavedReportsList } from './SavedReportsList';
import { NewAuditDialog } from './NewAuditDialog';
import { SecurityPanel } from './SecurityPanel';
import { reportHostLabels, reportHostLabelText } from '../presentation/reportHosts';

/** Device-wide history stays metadata-only until an explicit report action, including for deleted hosts. */
export function GlobalSecurityAuditsPanel({ active = true }: { active?: boolean }) {
    const notify = useAppStore(state => state.showToast);
    const connections = useAppStore(state => state.connections);
    const showAddresses = useShowHostAddressesInLists();
    const owner = useMemo(() => ({}), []);
    const library = useReportLibrary(owner, undefined, notify);
    const [query, setQuery] = useState('');
    const [host, setHost] = useState('');
    const [selected, setSelected] = useState<SavedReportSummary>();
    const [deleting, setDeleting] = useState<{ report: SavedReportSummary; risks: SavedRisk[] }>();
    const [preparingDelete, setPreparingDelete] = useState<string>();
    const [choosingHost, setChoosingHost] = useState(false);
    const [draft, setDraft] = useState<{ connectionId: string; setupRequest: object }>();
    const [draftVisible, setDraftVisible] = useState(false);
    const heading = useRef<HTMLHeadingElement>(null);
    const listHeading = useRef<HTMLHeadingElement>(null);
    const opener = useRef<HTMLElement | null>(null);
    const restoreFocus = useRef(false);
    const choice = useRef(0);
    const subject = useMemo(() => selected ? savedReportSubject(selected) : undefined, [selected]);

    useEffect(() => {
        if (active && !selected && !draftVisible) void library.refresh();
    }, [owner, active, selected, draftVisible]);
    useLayoutEffect(() => {
        if (!selected && !draftVisible && restoreFocus.current) {
            const active = document.activeElement;
            if (active && active !== document.body && active !== listHeading.current && active !== heading.current) {
                restoreFocus.current = false;
                return;
            }
            // Background refresh disables row actions. Keep the handoff until the opener is usable,
            // but relinquish it if the user moves to search or another control while waiting.
            if (library.busy) { if (active === document.body) listHeading.current?.focus({ preventScroll: true }); return; }
            restoreFocus.current = false;
            const target = opener.current?.isConnected && opener.current.getClientRects().length ? opener.current : listHeading.current ?? heading.current;
            target?.focus({ preventScroll: true });
        }
    }, [selected, draftVisible, library.rows, library.busy]);

    const labels = useMemo(() => reportHostLabels(library.rows, connections, showAddresses), [library.rows, connections, showAddresses]);
    const hosts = useMemo(() => [...labels].map(([value, label]) => ({ value, ...label }))
        .sort((left, right) => left.label.localeCompare(right.label)), [labels]);
    // Only confirmed metadata removes a selection; a failed refresh preserves the last valid scope.
    useEffect(() => { if (library.status === 'ready' && host && !labels.has(host)) setHost(''); }, [library.status, host, labels]);
    const effectiveHost = labels.has(host) ? host : '';
    const rows = useMemo(() => {
        const text = query.trim().toLocaleLowerCase();
        return library.rows.filter(row => (!effectiveHost || savedReportHostKey(row) === effectiveHost)
            && (!text || `${row.name} ${reportHostLabelText(labels.get(savedReportHostKey(row)))} ${savedReportHostLabel(row)}`.toLocaleLowerCase().includes(text)));
    }, [library.rows, query, effectiveHost, labels]);

    /** Back retains filters/page and starts the metadata refresh before the keyboard-focus handoff. */
    const backToLibrary = () => { setSelected(undefined); setDraftVisible(false); restoreFocus.current = true; void library.refresh(); };

    /** Export only the selected saved body and keep its endpoint/account scope explicit. */
    const exportSaved = async (item: SavedReportSummary, format: ReportExportFormat) => {
        const exported = await library.perform(async () => {
            const report = await library.port.load(item.id, savedReportSubject(item));
            return exportReport(report.result, report.annotations, format);
        }, 'Could not export the saved report.');
        if (exported) notify('success', 'Saved report exported.');
    };

    /** Reuse the host-scoped delete contract; matching acceptance revisions are captured only after an explicit click. */
    const requestDelete = async (item: SavedReportSummary) => {
        let capturedChoice = 0;
        const prepared = await library.perform(async () => {
            capturedChoice = ++choice.current; setPreparingDelete(item.id);
            const reportSubject = savedReportSubject(item);
            const [report, risks] = await Promise.all([library.port.load(item.id, reportSubject), library.port.risks(reportSubject)]);
            return { report: report.summary, risks: reportRiskRemovals(risks, report.annotations) };
        }, 'Could not prepare report deletion.');
        if (choice.current === capturedChoice) { setPreparingDelete(undefined); if (prepared) setDeleting(prepared); }
    };

    return <div className="h-full min-h-0 overflow-auto bg-app-bg text-app-text">
        <div hidden={draftVisible} className="mx-auto max-w-5xl px-4 py-5 sm:px-7 sm:py-7">
            <header className="flex min-w-0 flex-wrap items-center gap-3">
                <HardeningAuditIcon size={28} className="shrink-0 text-app-accent" />
                <div className="min-w-0"><h1 ref={heading} tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">{builtinWorkspaceViewLabel('security')}</h1>
                    <p className="mt-1 break-all text-xs text-app-muted">{selected ? savedReportHostLabel(selected) : 'Saved reports from all hosts'}</p></div>
                {!selected && <div className="ml-auto flex flex-wrap gap-2">
                    {draft && <Button size="sm" variant="ghost" disabled={library.busy} onClick={event => { opener.current = event.currentTarget; setDraftVisible(true); }}>Resume audit</Button>}
                    <Button size="sm" disabled={library.busy} onClick={event => { opener.current = event.currentTarget; setChoosingHost(true); }}><Plus size={14} className="mr-2" aria-hidden="true" />New audit</Button>
                </div>}
            </header>
            <div hidden={Boolean(selected)} className="space-y-4 pt-5">
                {library.rows.length > 0 && <div className="flex flex-col gap-3 sm:flex-row">
                    <Input aria-label="Search saved reports" placeholder="Search reports or hosts…" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1" />
                    <Select ariaLabel="Filter reports by host" value={effectiveHost} onChange={setHost} options={[{ value: '', label: 'All hosts' }, ...hosts]} className="min-w-0 sm:w-72" showSearch />
                </div>}
                <SavedReportsList key={JSON.stringify([query, effectiveHost])} rows={rows} status={library.status} busy={library.busy}
                    refreshing={library.refreshing} preparingDelete={preparingDelete} headingRef={listHeading}
                    hostLabel={item => reportHostLabelText(labels.get(savedReportHostKey(item)))}
                    emptyMessage={library.rows.length ? 'No reports match your search.' : 'No saved reports yet. Choose New audit to assess a host and save its report.'}
                    onCancelOpen={() => {}} onRefresh={() => void library.refresh()} onCompare={() => {}}
                    onOpen={item => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSelected(item); }}
                    onDelete={item => void requestDelete(item)} onExport={(item, format) => void exportSaved(item, format)} />
            </div>
            {selected && subject && <AssessmentReports key={selected.id + ':' + selected.revision} owner={selected} subject={subject}
                initialReport={selected} onBackToLibrary={backToLibrary} liveResult={null} running={false} setup={null} onLeaveSetup={() => {}} />}
        </div>
        {draft && <div hidden={!draftVisible} className="h-full min-h-0">
            <SecurityPanel key={draft.connectionId} connectionId={draft.connectionId} setupRequest={draft.setupRequest}
                visible={active && draftVisible} focused={active && draftVisible} onBackToLibrary={backToLibrary} />
        </div>}
        {choosingHost && <NewAuditDialog onClose={() => setChoosingHost(false)} onChoose={connectionId => {
            setChoosingHost(false); setDraft({ connectionId, setupRequest: {} }); setDraftVisible(true);
        }} />}
        {deleting && <DeleteReportDialog name={deleting.report.name} riskCount={deleting.risks.length} busy={library.busy}
            onClose={() => { if (!library.busy) setDeleting(undefined); }} onConfirm={removeRisks => {
                const captured = deleting;
                void library.perform(async () => { await library.port.delete(captured.report, savedReportSubject(captured.report), removeRisks ? captured.risks : undefined); return true; }, 'Could not delete the report.').then(async deleted => {
                    if (!deleted) return;
                    library.forgetReport(captured.report.id); setDeleting(undefined); listHeading.current?.focus(); notify('success', 'Saved report deleted.'); await library.refresh();
                });
            }} />}
    </div>;
}
