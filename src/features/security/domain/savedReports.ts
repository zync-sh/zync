import type { AssessmentResult, AssessmentSubject } from './assessment';
import type { RiskException } from './review';
import type { SavedRisk } from './acceptedRisks';

export type ReportExportFormat = 'json' | 'csv' | 'xlsx';
export interface ReportPackage { result: AssessmentResult; annotations: RiskException[] }
export interface SavedReportSummary {
    id: string; name: string; revision: number; createdAt: number; updatedAt: number; completedAt: number;
    host: string; username: string; port: number; fingerprint?: string | null; baseline: string;
    findings: number; attention: number; bytes: number;
}
export interface SavedReport extends ReportPackage { summary: SavedReportSummary }
export type ReportRevision = Pick<SavedReportSummary, 'id' | 'revision'>;

/** Endpoint and SSH account, rather than a mutable or deleted saved-host ID, identify local report scope. */
export function savedReportSubject(item: SavedReportSummary): AssessmentSubject {
    return { connectionId: 'saved-report', name: item.name, host: item.host, username: item.username, port: item.port };
}

/** Keep IPv6 endpoints unambiguous and include ports so similarly named hosts remain distinguishable. */
export function savedReportHostLabel(item: Pick<SavedReportSummary, 'host' | 'username' | 'port'>): string {
    const host = item.host.includes(':') && !item.host.startsWith('[') ? `[${item.host}]` : item.host;
    return `${item.username}@${host}:${item.port}`;
}

/** Collision-free filter identity retains the exact endpoint/account used by native scoped reads. */
export function savedReportHostKey(item: Pick<SavedReportSummary, 'host' | 'username' | 'port'>): string {
    return JSON.stringify([item.host, item.username, item.port]);
}
export interface ReportLibraryPort {
    list(subject: AssessmentSubject): Promise<SavedReportSummary[]>;
    load(id: string, subject: AssessmentSubject): Promise<SavedReport>;
    save(result: AssessmentResult, annotations: readonly RiskException[], name: string, replace?: ReportRevision): Promise<SavedReportSummary>;
    delete(revision: ReportRevision, subject: AssessmentSubject, riskRevisions?: readonly ReportRevision[]): Promise<void>;
    risks(subject: AssessmentSubject): Promise<SavedRisk[]>;
    saveRisks(result: AssessmentResult, annotations: readonly RiskException[], revisions: readonly ReportRevision[]): Promise<SavedRisk[]>;
    removeRisk(revision: ReportRevision, subject: AssessmentSubject): Promise<void>;
}

/** Importing an earlier connection ID is allowed; its endpoint and SSH account must still match the pane. */
export function reportBelongsToHost(result: AssessmentResult, subject: AssessmentSubject): boolean {
    return result.subject.host === subject.host && result.subject.username === subject.username && result.subject.port === subject.port;
}

/** A portable package keeps explicitly accepted risks with evidence, without any runtime access inputs. */
export function reportPayload(result: AssessmentResult, annotations: readonly RiskException[]): string {
    return JSON.stringify({ version: 3, subject: result.subject, report: result.report, startedAt: result.startedAt, completedAt: result.completedAt, annotations });
}

/** A replacement keeps the same endpoint/account and recorded key, including explicitly unqualified legacy reports. */
export function replacementReports(result: AssessmentResult, reports: readonly SavedReportSummary[]): SavedReportSummary[] {
    return reports.filter(item => item.host === result.subject.host && item.username === result.subject.username && item.port === result.subject.port
        && (item.fingerprint ?? undefined) === (result.report.transportFingerprint ?? undefined));
}
