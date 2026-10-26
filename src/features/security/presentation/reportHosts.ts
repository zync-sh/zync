import { getConnectionDisplayLabels } from '../../connections/domain/connectionDisplay';
import type { Connection } from '../../connections/domain/types';
import { savedReportHostKey, savedReportHostLabel, type SavedReportSummary } from '../domain/savedReports';

export interface ReportHostLabel { label: string; description?: string }

/** Browse labels follow host privacy; exact endpoint/account keys remain independent from presentation. */
export function reportHostLabels(reports: readonly SavedReportSummary[], connections: readonly Connection[], showAddresses: boolean): ReadonlyMap<string, ReportHostLabel> {
    const savedHosts = new Map<string, Connection>();
    for (const connection of connections) {
        const key = savedReportHostKey(connection);
        if (!savedHosts.has(key)) savedHosts.set(key, connection);
    }
    const scopes = new Map(reports.map(report => [savedReportHostKey(report), report]));
    // Sorting makes archived aliases independent of report dates and pagination order.
    const archived = new Map([...scopes.keys()].filter(key => !savedHosts.has(key)).sort().map((key, index) => [key, index + 1]));
    return new Map([...scopes].map(([key, report]) => {
        if (showAddresses) return [key, { label: savedReportHostLabel(report) }];
        const connection = savedHosts.get(key);
        if (connection) {
            const labels = getConnectionDisplayLabels(connection, false);
            return [key, { label: labels.primary, description: labels.secondary }];
        }
        return [key, { label: `Saved host ${archived.get(key)}`, description: report.username ? `SSH, ${report.username}` : 'SSH' }];
    }));
}

/** Reuse the same safe host copy in row descriptions and the host filter. */
export function reportHostLabelText(value: ReportHostLabel | undefined): string {
    return value ? [value.label, value.description].filter(Boolean).join(' · ') : 'Saved host';
}
