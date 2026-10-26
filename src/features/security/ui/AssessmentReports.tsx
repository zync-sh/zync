import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, GitCompareArrows, MoreHorizontal, Plus, Save } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { ConfirmModal } from '../../../components/ui/ConfirmModal';
import { useAppStore } from '../../../store/useAppStore';
import { useAssessmentReview } from '../application/useAssessmentReview';
import { useReportLibrary } from '../application/useReportLibrary';
import type { AssessmentResult, AssessmentSubject, Finding, SudoRetryLabel } from '../domain/assessment';
import { matchingRiskException, type RiskException } from '../domain/review';
import { findingRiskIdentityKey, riskIdentityKey } from '../domain/review';
import { acceptanceRevisions, reportRiskAnnotations, reportRiskRemovals, type SavedRisk } from '../domain/acceptedRisks';
import type { ReportExportFormat, ReportPackage, SavedReportSummary, ReportRevision } from '../domain/savedReports';
import type { ScopePreset } from '../domain/modules';
import { reportBelongsToHost } from '../domain/savedReports';
import { exportReport, importReport } from '../infrastructure/reportLibraryIpc';
import { ReportOverview } from './ReportOverview';
import { FindingResults } from './FindingResults';
import { AssessmentComparison } from './AssessmentComparison';
import { RiskExceptionDialog } from './RiskExceptionDialog';
import { SaveReportDialog } from './SaveReportDialog';
import { SavedReportsList } from './SavedReportsList';
import { ReportActionMenu, ReportExportMenu } from './ReportActionMenu';
import { AcceptedRisksList } from './AcceptedRisksList';
import { DeleteReportDialog } from './DeleteReportDialog';

interface AssessmentReportsProps {
    owner: object; subject: AssessmentSubject; liveResult: AssessmentResult | null; running: boolean;
    setup: ReactNode; onLeaveSetup(): void; onRetryWithSudo?: (label: SudoRetryLabel) => void;
    presets?: readonly ScopePreset[];
    /** A global row enters the shared host-scoped reviewer without creating an assessment controller. */
    initialReport?: SavedReportSummary; onBackToLibrary?(): void;
    /** Each explicit request reveals setup while retaining the current report and nonsecret scope choices. */
    setupRequest?: object;
}

/** Reports have an explicit local lifecycle, independent from remote assessment or credential ownership. */
export function AssessmentReports({ owner, subject, liveResult, running, setup, onLeaveSetup, onRetryWithSudo, presets, initialReport, onBackToLibrary, setupRequest }: AssessmentReportsProps) {
    const notify = useAppStore(state => state.showToast);
    const library = useReportLibrary(owner, subject, notify);
    const storedAnnotations = useMemo(() => library.risks.map(row => row.annotation), [library.risks]);
    const review = useAssessmentReview(owner, notify, storedAnnotations);
    const [viewed, setViewed] = useState<{ owner: object; package: ReportPackage }>();
    const canBrowse = subject.connectionId !== 'local' && Boolean(subject.host);
    const canReturnToLibrary = canBrowse || Boolean(onBackToLibrary);
    const [view, setView] = useState<'library' | 'setup' | 'report'>(initialReport ? 'report' : setupRequest ? 'setup' : canBrowse ? 'library' : 'setup');
    const showList = view === 'library';
    const [listView, setListView] = useState<'reports' | 'risks'>('reports');
    const [opening, setOpening] = useState<string | undefined>(initialReport?.id);
    const [preparingDelete, setPreparingDelete] = useState<string>();
    const [showSave, setShowSave] = useState(false);
    const [deleting, setDeleting] = useState<{ report: SavedReportSummary; risks: SavedRisk[] }>();
    const [removingRisk, setRemovingRisk] = useState<SavedRisk>();
    const [accepting, setAccepting] = useState<Finding>();
    const [saved, setSaved] = useState<{ owner: object; result: AssessmentResult; summary: SavedReportSummary; notes: string }>();
    const latestDraft = useRef<{ annotations: RiskException[]; saved: typeof saved }>({ annotations: [], saved: undefined });
    const result = viewed?.owner === owner ? viewed.package.result : liveResult;
    const resultRef = useRef(result); resultRef.current = result;
    const libraryChoice = useRef(0);
    const listHeading = useRef<HTMLHeadingElement>(null);
    const riskHeading = useRef<HTMLHeadingElement>(null);
    const setupBack = useRef<HTMLButtonElement>(null);
    const root = useRef<HTMLElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const restoreOpener = useRef(false);
    const reportHeading = useRef<HTMLHeadingElement>(null);
    const focusNext = useRef<'list' | 'report' | 'setup' | undefined>(undefined);
    const historical = viewed?.owner === owner;
    const busy = library.busy || review.busy;
    // A newly completed run must refresh local decisions before reusing cached acceptances.
    const annotations = useMemo(() => !result ? [] : historical ? review.annotations
        : reportRiskAnnotations(result, [...(library.riskReadAt >= result.completedAt ? storedAnnotations : []), ...review.annotations]), [result, historical, storedAnnotations, review.annotations, library.riskReadAt]);
    const notes = JSON.stringify(annotations);
    const savedCopy = saved?.owner === owner && saved.result === result ? saved : undefined;
    const savedUnchanged = Boolean(savedCopy && savedCopy.notes === notes);
    useEffect(() => { latestDraft.current = { annotations: [], saved: undefined }; returnFocus.current = null; restoreOpener.current = false; focusNext.current = undefined; setViewed(undefined); setSaved(undefined); setView(initialReport ? 'report' : setupRequest ? 'setup' : canBrowse ? 'library' : 'setup'); setListView('reports'); setOpening(initialReport?.id); setPreparingDelete(undefined); setShowSave(false); setDeleting(undefined); setRemovingRisk(undefined); setAccepting(undefined); }, [owner]);
    // Default browsing loads bounded local data; native migration separates legacy notes once, without SSH.
    useEffect(() => { if (!initialReport && !setupRequest && subject.connectionId !== 'local' && subject.host) void library.refresh(); }, [owner]);
    useEffect(() => {
        setViewed(undefined); setSaved(undefined); setShowSave(false); setAccepting(undefined); setView(liveResult || initialReport ? 'report' : setupRequest ? 'setup' : canBrowse ? 'library' : 'setup');
        if (liveResult) focusNext.current = 'report';
        if (liveResult && subject.connectionId !== 'local' && subject.host) void library.refresh();
    }, [liveResult]);
    useEffect(() => { if (running) { if (historical) review.replaceAnnotations(latestDraft.current.annotations); latestDraft.current = { annotations: [], saved: undefined }; libraryChoice.current++; setViewed(undefined); setShowSave(false); setView('setup'); setOpening(undefined); setPreparingDelete(undefined); setAccepting(undefined); } }, [running]);
    useEffect(() => {
        if (!setupRequest) return;
        libraryChoice.current++; setOpening(undefined); setPreparingDelete(undefined); onLeaveSetup();
        focusNext.current = 'setup'; setView('setup');
    }, [setupRequest]);
    useEffect(() => {
        const listTarget = restoreOpener.current && returnFocus.current?.getClientRects().length ? returnFocus.current : listView === 'reports' ? listHeading.current : riskHeading.current;
        const target = showList ? listTarget : view === 'setup' ? setupBack.current : reportHeading.current;
        if (focusNext.current === (showList ? 'list' : view === 'setup' ? 'setup' : 'report') && target?.getClientRects().length) { target.focus(); focusNext.current = undefined; restoreOpener.current = false; }
    }, [view, result, listView, library.rows.length, library.risks.length, setupRequest]);
    /** Remember the local opener so Back restores keyboard position as well as the retained library view. */
    const rememberOpener = () => { const active = document.activeElement; returnFocus.current = active instanceof HTMLElement && root.current?.contains(active) ? active : null; };
    /** Returning keeps nonsecret scope and list state; one-shot run access is released by its owner. */
    const backToLibrary = () => { if (view === 'setup') onLeaveSetup(); libraryChoice.current++; setOpening(undefined); setPreparingDelete(undefined); if (onBackToLibrary) { onBackToLibrary(); return; } restoreOpener.current = true; focusNext.current = 'list'; setView('library'); };
    const accepted = useMemo(() => {
        if (!result) return new Map<Finding, RiskException>();
        const indexed = new Map(reportRiskAnnotations(result, annotations).map(item => [riskIdentityKey(item), item]));
        return new Map(result.report.findings.flatMap(finding => {
            const identity = findingRiskIdentityKey(result, finding); const recorded = identity ? indexed.get(identity) : undefined;
            const item = historical ? recorded : recorded ? matchingRiskException(result, finding, [recorded], review.now) : undefined;
            return item ? [[finding, item] as const] : [];
        }));
    }, [result, historical, annotations, review.now]);

    /** Opening one report loads only that body; it cannot publish as a freshly completed scan. */
    const openSaved = async (item: SavedReportSummary, compare = false) => {
        const captured = result;
        let choice = 0;
        const report = await library.perform(() => { rememberOpener(); choice = ++libraryChoice.current; setOpening(item.id); return library.port.load(item.id, subject); }, 'Could not open the saved report.');
        if (libraryChoice.current === choice) setOpening(undefined);
        if (!report || resultRef.current !== captured || libraryChoice.current !== choice) return;
        if (compare && captured) review.compareSaved(report.result);
        else { if (!historical) latestDraft.current = { annotations: [...review.annotations], saved }; setViewed({ owner, package: report }); review.replaceAnnotations(report.annotations); setSaved({ owner, result: report.result, summary: report.summary, notes: JSON.stringify(report.annotations) }); }
        focusNext.current = 'report'; setView('report');
        if (initialReport) void library.refresh();
    };
    // Global entry loads exactly the selected body; host browsing keeps its existing default library view.
    useEffect(() => { if (initialReport) void openSaved(initialReport); }, [owner, initialReport]);
    /** Import previews a normalized report and its risk notes, without automatically adding it to history. */
    const openImported = async () => {
        const captured = result;
        let choice = 0;
        const report = await library.perform(() => { rememberOpener(); choice = ++libraryChoice.current; return importReport(); }, 'Could not import this report.');
        if (!report || resultRef.current !== captured || libraryChoice.current !== choice) return;
        if (!reportBelongsToHost(report.result, subject)) { notify('error', 'Choose a report for this host and SSH account.'); return; }
        if (!historical) latestDraft.current = { annotations: [...review.annotations], saved };
        setViewed({ owner, package: report }); review.replaceAnnotations(report.annotations); setSaved(undefined); focusNext.current = 'report'; setView('report');
    };
    /** Saving captures the displayed evidence and notes; a changed pane cannot relabel the saved result. */
    const save = async (name: string, replace?: ReportRevision) => {
        if (!result) return;
        const captured = result; const capturedAnnotations = [...annotations];
        const summary = await library.perform(() => library.port.save(captured, capturedAnnotations, name, replace), 'Could not save this report.');
        if (!summary || resultRef.current !== captured) return;
        if (historical && latestDraft.current.saved?.summary.id === summary.id) latestDraft.current.saved = undefined;
        setSaved({ owner, result: captured, summary, notes: JSON.stringify(capturedAnnotations) }); setShowSave(false);
        notify('success', replace ? 'Saved report replaced.' : 'Report saved on this device.');
        await library.refresh();
    };
    /** An export always contains every retained check, regardless of filters or pagination. */
    const exportAs = async (format: ReportExportFormat) => {
        if (!result) return;
        const captured = result; const capturedAnnotations = [...annotations];
        const exported = await library.perform(() => exportReport(captured, capturedAnnotations, format), 'Could not export the report.');
        if (exported) notify('success', 'Report exported.');
    };
    /** Export a saved copy without opening it or replacing the active report's risk-note drafts. */
    const exportSaved = async (item: SavedReportSummary, format: ReportExportFormat) => {
        const exported = await library.perform(async () => {
            const report = await library.port.load(item.id, subject);
            return exportReport(report.result, report.annotations, format);
        }, 'Could not export the saved report.');
        if (exported) notify('success', 'Saved report exported.');
    };
    /** Returning from history restores the latest report's own unsaved notes. */
    const showLatest = () => {
        rememberOpener();
        libraryChoice.current++; setOpening(undefined);
        if (historical && liveResult) { setViewed(undefined); setSaved(latestDraft.current.saved); review.replaceAnnotations(latestDraft.current.annotations); }
        focusNext.current = 'report'; setView('report');
    };
    /** An explicit acceptance is stored before closing its dialog; report snapshots stay unchanged. */
    const saveAcceptances = async (values: readonly RiskException[]) => {
        if (!result || library.riskStatus !== 'ready') return;
        const captured = result;
        const selected = reportRiskAnnotations(captured, values);
        const savedRisks = await library.perform(() => library.port.saveRisks(captured, selected, acceptanceRevisions(library.risks, selected)), 'Could not save these accepted risks.');
        if (!savedRisks) return;
        if (resultRef.current === captured) {
            if (!historical) review.removeBindings(new Set(selected.map(riskIdentityKey)));
            setAccepting(undefined); notify('success', 'Accepted risks saved on this device.');
        }
        await library.refresh();
    };
    /** Offer only unchanged registry notes on the report-delete checkbox. */
    const requestDelete = async (item: SavedReportSummary) => {
        if (library.riskStatus !== 'ready') { notify('error', 'Refresh accepted risks before deleting a report.'); return; }
        let choice = 0;
        const report = await library.perform(() => { choice = ++libraryChoice.current; setPreparingDelete(item.id); return library.port.load(item.id, subject); }, 'Could not prepare report deletion.');
        if (libraryChoice.current === choice) setPreparingDelete(undefined);
        if (report && libraryChoice.current === choice) setDeleting({ report: report.summary, risks: reportRiskRemovals(library.risks, report.annotations) });
    };
    /** Revocation clears current drafts without rewriting notes in historical reports. */
    const forgetAcceptanceDrafts = (items: readonly SavedRisk[], captured = result) => {
        const removed = new Set(items.map(item => riskIdentityKey(item.annotation)));
        const keep = (note: RiskException) => !removed.has(riskIdentityKey(note));
        if (!historical && resultRef.current === captured) review.removeBindings(removed);
        latestDraft.current.annotations = latestDraft.current.annotations.filter(keep);
    };
    /** Revoke the selected persisted revision before clearing its current-view drafts. */
    const removeAcceptance = async () => {
        if (!removingRisk) return;
        const item = removingRisk; const captured = result;
        const removed = await library.perform(async () => { await library.port.removeRisk(item, subject); return true; }, 'Could not remove this accepted risk.');
        if (!removed) return;
        forgetAcceptanceDrafts([item], captured); setRemovingRisk(undefined); focusNext.current = showList ? 'list' : 'report'; notify('success', 'Acceptance removed. Recorded report notes are unchanged.');
        await library.refresh();
    };
    /** Persisted notes require confirmation; an unsaved imported draft remains a local edit. */
    const requestRemoveAcceptance = (id: string) => {
        const record = library.risks.find(row => row.annotation.id === id);
        if (record) setRemovingRisk(record); else review.removeAnnotation(id);
    };
    const retry = !historical && !running ? onRetryWithSudo : undefined;
    return <section ref={root} aria-label="Assessment reports" className="space-y-4">
        {initialReport && !result && <div className="space-y-4 pt-5">
            <Button variant="ghost" size="sm" onClick={backToLibrary}><ArrowLeft size={14} className="mr-2" aria-hidden="true" />Back</Button>
            {opening ? <p role="status" className="text-xs text-app-muted">Opening report…</p>
                : <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-app-border bg-app-panel p-4 text-xs">
                    <p>Could not open this saved report.</p><Button variant="secondary" size="sm" disabled={busy} onClick={() => void openSaved(initialReport)}>Retry opening report</Button>
                </div>}
        </div>}
        <div hidden={view !== 'setup'}>
            {canReturnToLibrary && <Button ref={setupBack} variant="ghost" size="sm" disabled={busy || running} className="mt-5" onClick={backToLibrary}><ArrowLeft size={14} className="mr-2" aria-hidden="true" />Back</Button>}
            {setup}
        </div>
        {canBrowse && <div hidden={!showList}>
            <div className="flex flex-wrap items-center justify-between gap-3 py-5">
            <div role="group" aria-label="Saved audit data" className="flex flex-wrap gap-1">
                <Button size="sm" variant={listView === 'reports' ? 'secondary' : 'ghost'} aria-pressed={listView === 'reports'} disabled={busy || running} onClick={() => setListView('reports')}>Reports · {library.rows.length}</Button>
                <Button size="sm" variant={listView === 'risks' ? 'secondary' : 'ghost'} aria-pressed={listView === 'risks'} disabled={busy || running} onClick={() => setListView('risks')}>Accepted risks · {library.risks.length}</Button>
            </div>
            <div className="flex flex-wrap gap-1">{result && <Button size="sm" variant="ghost" disabled={busy || running} onClick={showLatest}>{liveResult ? 'Latest assessment' : 'Return to report'}</Button>}
                <Button size="sm" disabled={busy || running} onClick={() => { rememberOpener(); focusNext.current = 'setup'; setView('setup'); }}><Plus size={14} className="mr-2" aria-hidden="true" />New assessment</Button></div>
            </div>
            <div hidden={listView !== 'risks'}><AcceptedRisksList key={subject.host + ':' + subject.port + ':' + subject.username} rows={library.risks} status={library.riskStatus} busy={busy || running} now={review.now} headingRef={riskHeading} onRefresh={() => void library.refresh()} onRemove={setRemovingRisk} presets={presets} /></div>
            <div hidden={listView !== 'reports'}><SavedReportsList key={subject.host + ':' + subject.port + ':' + subject.username} headingRef={listHeading}
            rows={library.rows} status={library.status} busy={busy || running}
            comparisonLabel={result ? savedCopy?.summary.name ?? (historical ? 'Report preview' : 'Latest assessment') : undefined}
            opening={opening} preparingDelete={preparingDelete} refreshing={library.refreshing} onCancelOpen={() => { libraryChoice.current++; setOpening(undefined); }}
            onRefresh={() => void library.refresh()} onOpen={item => void openSaved(item)} onCompare={item => void openSaved(item, true)} onDelete={item => void requestDelete(item)} onImport={() => void openImported()} onExport={(item, format) => void exportSaved(item, format)} /></div>
        </div>}
        {result && <div hidden={view !== 'report'} className="space-y-4 pt-5">
            {canReturnToLibrary && <Button variant="ghost" size="sm" disabled={busy || running} onClick={backToLibrary}><ArrowLeft size={14} className="mr-2" aria-hidden="true" />Back</Button>}
            <div className="flex flex-wrap items-center justify-between gap-3">
                {result && <div><h2 ref={reportHeading} tabIndex={-1} className="text-sm font-semibold outline-none">{historical ? 'Report preview' : 'Hardening results'}</h2><p className="mt-1 text-[11px] text-app-muted">{savedUnchanged ? 'Saved on this device' : savedCopy ? 'Unsaved changes' : historical ? 'Earlier observations · not saved' : 'Not saved'}</p></div>}
                <div className="flex flex-wrap items-center gap-1">
                    {result && <><Button size="sm" disabled={busy || running} onClick={async () => { const captured = result; await library.refresh(); if (resultRef.current === captured) setShowSave(true); }}><Save size={13} className="mr-2" aria-hidden="true" />Save report</Button>
                        <ReportExportMenu disabled={busy} onExport={format => void exportAs(format)} /></>}
                    {result && <ReportActionMenu label={<><MoreHorizontal size={16} /><span className="sr-only">Report actions</span></>}>
                        <Button variant="ghost" size="sm" className="w-full justify-start" disabled={busy} onClick={() => void review.loadComparison()}><GitCompareArrows size={13} className="mr-2" />Compare imported report</Button>
                        <Button variant="ghost" size="sm" className="w-full justify-start" disabled={busy} onClick={() => void review.loadAnnotations()}>Import accepted risks</Button>
                        <Button variant="ghost" size="sm" className="w-full justify-start" disabled={busy || review.annotations.length === 0 || library.riskStatus !== 'ready'} onClick={() => void saveAcceptances(review.annotations)}>Save accepted risks locally</Button>
                        <Button variant="ghost" size="sm" className="w-full justify-start" disabled={busy || annotations.length === 0} onClick={() => void review.saveAnnotations(annotations)}>Export accepted risks</Button>
                    </ReportActionMenu>}
                </div>
            </div>
            {result && <>
                <ReportOverview result={result} historical={historical} onRetryWithSudo={retry} />
                {review.baseline && <AssessmentComparison key={review.baseline.completedAt} current={result} baseline={review.baseline} source={review.baselineSource} onClear={review.clearComparison} />}
                <FindingResults key={result.completedAt} report={result.report} onRetryWithSudo={retry} accepted={accepted} historical={historical}
                    onAcceptRisk={!running && !historical && library.riskStatus === 'ready' && result.report.transportFingerprint && result.report.policy ? finding => setAccepting(finding) : undefined} onRemoveRisk={!historical && !busy ? requestRemoveAcceptance : undefined} />
                <p className="text-[11px] text-app-muted">Saved reports keep recorded notes. Accepted risks are managed separately on this device.</p>
            </>}
            </div>}
        {showSave && result && <SaveReportDialog result={result} reports={library.rows} busy={busy} onClose={() => setShowSave(false)} onSave={(name, replace) => void save(name, replace)} />}
        {deleting && <DeleteReportDialog name={deleting.report.name} riskCount={deleting.risks.length} busy={busy} onClose={() => { if (!busy) setDeleting(undefined); }} onConfirm={removeRisks => {
            const item = deleting; const captured = result;
            void library.perform(async () => { await library.port.delete(item.report, subject, removeRisks ? item.risks : undefined); return true; }, 'Could not delete the report.').then(async deleted => {
                if (!deleted) return;
                library.forgetReport(item.report.id);
                setDeleting(undefined);
                focusNext.current = 'list';
                if (removeRisks) forgetAcceptanceDrafts(item.risks, captured);
                if (savedCopy?.summary.id === item.report.id) setSaved(undefined);
                if (latestDraft.current.saved?.summary.id === item.report.id) latestDraft.current.saved = undefined;
                listHeading.current?.focus(); notify('success', 'Saved report deleted.');
                await library.refresh();
            });
        }} />}
        {removingRisk && <ConfirmModal isOpen title="Remove accepted risk?" message="This stops acceptance for matching current and future checks. Saved reports keep their recorded notes." variant="danger" confirmLabel="Remove acceptance" isLoading={busy} onClose={() => { if (!busy) setRemovingRisk(undefined); }} onConfirm={() => void removeAcceptance()} />}
        {result && accepting && <RiskExceptionDialog result={result} finding={accepting} busy={busy} onClose={() => { if (!busy) setAccepting(undefined); }} onSave={annotation => void saveAcceptances([annotation])} />}
    </section>;
}
