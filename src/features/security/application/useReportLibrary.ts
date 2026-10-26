import { useEffect, useRef, useState } from 'react';
import type { AssessmentSubject } from '../domain/assessment';
import type { ReportLibraryPort, SavedReportSummary } from '../domain/savedReports';
import { listSavedReports, reportLibraryIpc } from '../infrastructure/reportLibraryIpc';
import type { SavedRisk } from '../domain/acceptedRisks';

type LibraryStatus = 'idle' | 'loading' | 'ready' | 'failed';
interface LibraryState { owner: object; rows: SavedReportSummary[]; risks: SavedRisk[]; status: LibraryStatus; riskStatus: LibraryStatus; riskReadAt: number; busy: boolean; refreshing: boolean }

/** Bounded local data with owned completions; an absent subject lists global summaries without reading acceptances. */
export function useReportLibrary(owner: object, subject: AssessmentSubject | undefined, notify: (type: 'success' | 'error' | 'info', message: string) => void,
    port: ReportLibraryPort = reportLibraryIpc) {
    const ownerRef = useRef(owner); ownerRef.current = owner;
    const pending = useRef<object | undefined>(undefined);
    const refreshing = useRef<object | undefined>(undefined);
    const empty: LibraryState = { owner, rows: [], risks: [], status: 'idle', riskStatus: 'idle', riskReadAt: 0, busy: false, refreshing: false };
    const [state, setState] = useState<LibraryState>(empty);
    const current = state.owner === owner ? state : empty;
    useEffect(() => { pending.current = undefined; refreshing.current = undefined; setState(empty); return () => { pending.current = undefined; refreshing.current = undefined; }; }, [owner]);

    /** A single owned operation prevents duplicate saves and stale UI publication after pane changes. */
    async function perform<T>(work: () => Promise<T>, failure: string): Promise<T | undefined> {
        if (pending.current) return undefined;
        const token = {}; pending.current = token;
        setState(previous => ({ ...previous, owner, busy: true }));
        try { const value = await work(); return pending.current === token && ownerRef.current === owner ? value : undefined; }
        catch (error) {
            if (pending.current === token && ownerRef.current === owner) notify('error', typeof error === 'string' ? error : failure);
            return undefined;
        } finally {
            if (pending.current === token && ownerRef.current === owner) { pending.current = undefined; setState(previous => ({ ...previous, owner, busy: false })); }
        }
    }
    /** Browsing asks for summaries only and does not load report bodies or start remote work. */
    const refresh = async () => {
        if (pending.current) return;
        const token = {}; refreshing.current = token;
        const riskReadAt = Date.now();
        setState(previous => ({ ...previous, owner, refreshing: true,
            status: previous.owner === owner && previous.status === 'ready' ? 'ready' : 'loading',
            riskStatus: previous.owner === owner && previous.riskStatus === 'ready' ? 'ready' : 'loading' }));
        const data = await perform(() => Promise.allSettled(subject
            ? [port.list(subject), port.risks(subject)]
            : [listSavedReports(), Promise.resolve([] as SavedRisk[])]), 'Could not load saved audit data.');
        if (ownerRef.current === owner && refreshing.current === token && data) setState(previous => ({ ...previous, owner, refreshing: false,
            status: data[0].status === 'fulfilled' ? 'ready' : 'failed', rows: data[0].status === 'fulfilled' ? data[0].value : previous.rows,
            riskStatus: data[1].status === 'fulfilled' ? 'ready' : 'failed', risks: data[1].status === 'fulfilled' ? data[1].value : previous.risks,
            riskReadAt: data[1].status === 'fulfilled' ? riskReadAt : previous.riskReadAt }));
    };
    /** Reflect a confirmed native deletion immediately; refresh reconciles remaining metadata without blanking it. */
    const forgetReport = (id: string) => setState(previous => previous.owner === owner ? { ...previous, rows: previous.rows.filter(row => row.id !== id) } : previous);
    return { ...current, refresh, perform, forgetReport, port, subject };
}
