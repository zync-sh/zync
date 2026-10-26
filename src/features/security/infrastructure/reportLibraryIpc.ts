import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { AssessmentResult } from '../domain/assessment';
import type { RiskException } from '../domain/review';
import { reportPayload, type ReportExportFormat, type ReportLibraryPort, type ReportPackage, type SavedReportSummary } from '../domain/savedReports';

/** Global browsing reads the same bounded metadata index without loading reports or connecting to hosts. */
export function listSavedReports(): Promise<SavedReportSummary[]> {
    return invoke('security_assessment_saved_reports', { subject: null });
}

/** Explicit local report storage uses the native validator and transactional library, outside sync/global state. */
export const reportLibraryIpc: ReportLibraryPort = {
    list: subject => invoke('security_assessment_saved_reports', { subject }),
    load: (id, subject) => invoke('security_assessment_load_report', { id, subject }),
    save: (result, annotations, name, replace) => invoke('security_assessment_save_report', { payload: reportPayload(result, annotations), name, replace: replace ? { id: replace.id, revision: replace.revision } : null }),
    delete: (revision, subject, riskRevisions) => invoke('security_assessment_delete_report', { revision: { id: revision.id, revision: revision.revision }, subject, riskRevisions: riskRevisions?.map(({ id, revision }) => ({ id, revision })) ?? null }),
    risks: subject => invoke('security_assessment_accepted_risks', { subject }),
    saveRisks: (result, annotations, revisions) => invoke('security_assessment_save_accepted_risks', { payload: reportPayload(result, annotations), revisions: revisions.map(({ id, revision }) => ({ id, revision })) }),
    removeRisk: (revision, subject) => invoke('security_assessment_remove_accepted_risk', { revision: { id: revision.id, revision: revision.revision }, subject }),
};

/** Export all retained findings and explicit notes; the current view's filters never hide rows in an export. */
export async function exportReport(result: AssessmentResult, annotations: readonly RiskException[], format: ReportExportFormat): Promise<boolean> {
    const label = format === 'xlsx' ? 'Excel workbook' : format === 'csv' ? 'CSV spreadsheet' : 'Zync report';
    const path = await save({ defaultPath: `zync-hardening-assessment.${format}`, filters: [{ name: label, extensions: [format] }] });
    if (!path) return false;
    await invoke('security_assessment_export', { path, format, payload: reportPayload(result, annotations) });
    return true;
}

/** Import is a local preview action; saving it or running checks still requires a separate explicit action. */
export async function importReport(): Promise<ReportPackage | undefined> {
    const path = await open({ multiple: false, filters: [{ name: 'Zync report', extensions: ['json'] }] });
    if (typeof path !== 'string') return undefined;
    return invoke('security_assessment_import_package', { path });
}
