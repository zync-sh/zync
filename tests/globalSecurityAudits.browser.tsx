import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { GlobalSecurityAuditsPanel } from '../src/features/security/ui/GlobalSecurityAuditsPanel';
import { useAppStore } from '../src/store/useAppStore';
import type { AssessmentSubject, Finding } from '../src/features/security/domain/assessment';
import type { SavedReport, SavedReportSummary } from '../src/features/security/domain/savedReports';
import type { SavedRisk } from '../src/features/security/domain/acceptedRisks';
import type { RiskException } from '../src/features/security/domain/review';
import type { ModuleDefinition } from '../src/features/security/domain/modules';
import '../src/index.css';
import './uiOverlays.browser.css';

const reports = new Map<string, SavedReport>();
const risks = new Map<string, SavedRisk>();
const now = Date.now();
let failList = false;
let failLoad = false;
let holdList = false;
let holdLoad = false;
let hideAlphaSummaries = false;
const pendingLists = new Set<() => void>();
const pendingLoads = new Set<() => void>();
const loadedIds: string[] = [];
const auditHosts = [
    { id: 'global-alpha', name: 'Alpha fixture', host: 'alpha.invalid', username: 'observer', port: 22, status: 'connected' as const, icon: 'linux', lastConnected: 1 },
    { id: 'global-beta', name: 'Beta fixture', host: 'beta.invalid', username: 'admin', port: 2222, status: 'disconnected' as const, icon: 'linux' },
];
const modules: ModuleDefinition[] = [
    { id: 'host', label: 'Host baseline', group: 'host', description: 'Synthetic host settings', checkCount: 1, recommended: true },
    { id: 'extended-host', label: 'Additional host protections', group: 'host', description: 'Additional synthetic settings', checkCount: 1, recommended: false },
];
let assessmentSubject: AssessmentSubject | undefined;

/** Store synthetic evidence only; no real SSH account, files or saved application data are read. */
function seedReport(index: number, host: string, username: string, port: number, name: string): SavedReport {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const completedAt = now - index * 60_000;
    const subject: AssessmentSubject = { connectionId: `retired-fixture-${index}`, name: host, host, username, port };
    const finding: Finding = {
        id: 'FIXTURE-SSH', moduleId: 'host', status: 'attention', title: 'Fixture SSH access policy', target: 'sshd_config',
        evidence: 'Synthetic default SSH policy', observed: 'The recorded SSH setting needs review.',
        expected: 'Review the intended access policy.', rationale: 'Access settings depend on the host’s role.',
        scope: 'Synthetic named-file observation only.', recommendation: 'Review this recorded setting with the host administrator.',
        reference: 'https://man.openbsd.org/sshd_config', ruleVersion: '1', reviewedAt: '2026-10-25',
        targetKey: 'fixture:ssh', evidenceKey: 'fixture:evidence', evidenceKind: 'namedConfiguration', priority: 'review',
    };
    const annotation: RiskException = {
        id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, host, username, port,
        transportFingerprint: 'sha256:fixture-global-audit-key', policyId: 'general', policyRevision: '1',
        moduleId: 'host', targetKey: finding.targetKey!, ruleId: finding.id, ruleVersion: '1', evidenceKey: finding.evidenceKey!,
        reason: 'Isolated fixture; review the recorded decision separately.', createdAt: completedAt, expiresAt: now + 86_400_000,
    };
    const summary: SavedReportSummary = {
        id, name, revision: 1, createdAt: completedAt, updatedAt: completedAt, completedAt, host, username, port,
        fingerprint: annotation.transportFingerprint, baseline: 'zync-linux-7 (2026-10-25)', findings: 1, attention: 1, bytes: 4096,
    };
    const saved: SavedReport = {
        summary, result: { subject, startedAt: completedAt - 1000, completedAt, report: {
            kind: 'hardening', target: 'Connected Linux host', os: 'ubuntu 24.04', version: summary.baseline,
            findings: [finding], totalFindings: 1, truncated: false, notes: [], collectorUid: 1000, elevationRequested: false,
            transportFingerprint: annotation.transportFingerprint, policy: { id: 'general', label: 'General server', revision: '1' },
            modules: [{ id: 'host', label: 'Host baseline', group: 'host', description: 'Synthetic host settings', checkCount: 1, recommended: true }],
        } }, annotations: index === 1 ? [annotation] : [],
    };
    reports.set(id, saved);
    if (index === 1) risks.set('fixture-acceptance', { id: 'fixture-acceptance', revision: 1, title: finding.title, target: finding.target, annotation });
    return saved;
}
for (let index = 1; index <= 6; index++) seedReport(index, 'alpha.invalid', 'observer', 22, `Alpha audit ${index}`);
seedReport(7, 'beta.invalid', 'admin', 2222, 'Beta audit 1');
seedReport(8, 'beta.invalid', 'admin', 2222, 'Beta audit 2');
seedReport(9, 'orphan.invalid', 'retired', 22, 'Removed host audit');

function increment(key: string) { document.body.dataset[key] = String(Number(document.body.dataset[key] || 0) + 1); }
function sameSubject(item: Pick<SavedReportSummary, 'host' | 'username' | 'port'>, subject: AssessmentSubject) {
    return item.host === subject.host && item.username === subject.username && item.port === subject.port;
}
function publishCounts() { document.body.dataset.savedReports = String(reports.size); document.body.dataset.savedRisks = String(risks.size); }

window.addEventListener('fixture-fail-global-list', () => { failList = true; });
window.addEventListener('fixture-recover-global-list', () => { failList = false; });
window.addEventListener('fixture-hold-global-list', () => { holdList = true; });
window.addEventListener('fixture-release-global-list', () => { holdList = false; pendingLists.forEach(resolve => resolve()); pendingLists.clear(); });
window.addEventListener('fixture-fail-global-load', () => { failLoad = true; });
window.addEventListener('fixture-recover-global-load', () => { failLoad = false; });
window.addEventListener('fixture-hold-global-load', () => { holdLoad = true; });
window.addEventListener('fixture-release-global-load', () => { holdLoad = false; pendingLoads.forEach(resolve => resolve()); pendingLoads.clear(); });
window.addEventListener('fixture-remove-beta-host', () => useAppStore.setState(state => ({ connections: state.connections.filter(item => item.id !== 'global-beta') })));
window.addEventListener('fixture-restore-audit-hosts', () => useAppStore.setState({ connections: auditHosts.map(item => ({ ...item })) }));
window.addEventListener('fixture-hide-alpha-summaries', () => { hideAlphaSummaries = true; });
window.addEventListener('fixture-restore-alpha-summaries', () => { hideAlphaSummaries = false; });
for (const [event, showHostAddressesInLists] of [['fixture-show-host-addresses', true], ['fixture-hide-host-addresses', false]] as const) {
    window.addEventListener(event, () => useAppStore.setState(state => ({ settings: { ...state.settings, privacy: { ...state.settings.privacy, showHostAddressesInLists } } })));
}

/** Native subject checks remain strict for bodies and mutations, while only the summary endpoint accepts null. */
Object.assign(window, { __TAURI_INTERNALS__: { async invoke(command: string, args: Record<string, unknown>) {
    if (command === 'security_assessment_saved_reports') {
        const subject = args.subject as AssessmentSubject | null;
        increment(subject ? 'hostListCalls' : 'globalListCalls');
        if (!subject && holdList) { document.body.dataset.globalListPending = 'true'; await new Promise<void>(resolve => { pendingLists.add(resolve); }); document.body.dataset.globalListPending = ''; }
        if (!subject && failList) throw 'Synthetic global library unavailable.';
        return [...reports.values()].map(item => item.summary).filter(item => subject ? sameSubject(item, subject) : !hideAlphaSummaries || item.host !== 'alpha.invalid');
    }
    if (command === 'security_assessment_load_report') {
        increment('bodyLoads');
        loadedIds.push(String(args.id)); document.body.dataset.loadedIds = JSON.stringify(loadedIds);
        document.body.dataset.lastLoadSubject = JSON.stringify(args.subject);
        if (holdLoad) { document.body.dataset.loadPending = 'true'; await new Promise<void>(resolve => { pendingLoads.add(resolve); }); document.body.dataset.loadPending = ''; }
        if (failLoad) throw 'Synthetic saved report unavailable.';
        const saved = reports.get(String(args.id));
        if (!saved || !args.subject || !sameSubject(saved.summary, args.subject as AssessmentSubject)) throw 'Choose a report for this host and account.';
        return structuredClone(saved);
    }
    if (command === 'security_assessment_accepted_risks') {
        increment('riskReads');
        if (!args.subject) throw 'Accepted-risk reads require a host scope.';
        return [...risks.values()].filter(item => sameSubject(item.annotation, args.subject as AssessmentSubject));
    }
    if (command === 'security_assessment_delete_report') {
        const revision = args.revision as { id: string; revision: number };
        const saved = reports.get(revision.id);
        if (!saved || !args.subject || !sameSubject(saved.summary, args.subject as AssessmentSubject) || saved.summary.revision !== revision.revision) throw 'Saved report changed.';
        const selected = args.riskRevisions as { id: string; revision: number }[] | null;
        document.body.dataset.deletedRiskCount = String(selected?.length ?? 0);
        for (const item of selected ?? []) { if (risks.get(item.id)?.revision !== item.revision) throw 'Accepted risk changed.'; }
        reports.delete(revision.id); for (const item of selected ?? []) risks.delete(item.id); publishCounts(); return;
    }
    if (command === 'plugin:dialog|save') return 'C:\\fixture\\global-audit.json';
    if (command === 'security_assessment_export') { increment('exports'); document.body.dataset.exportFormat = String(args.format); return; }
    if (command === 'security_assessment_run') {
        increment('runs');
        if (!assessmentSubject || args.id !== 'fixture-global-admission') throw 'Synthetic assessment has no admission.';
        document.body.dataset.runConnection = assessmentSubject.connectionId; document.body.dataset.runHost = assessmentSubject.host;
        return structuredClone([...reports.values()].find(item => sameSubject(item.summary, assessmentSubject!))!.result.report);
    }
    if (command === 'security_assessment_needs_password') return false;
    increment('unexpectedCalls'); throw new Error(`Unexpected global audit fixture call: ${command}`);
} } });
window.ipcRenderer = {
    async invoke(command: string, args?: Record<string, unknown>) {
        if (command === 'security_assessment_catalog') {
            increment('catalogCalls');
            return { version: '1', modules, presets: [
                { id: 'general', label: 'General server', description: 'Synthetic host baseline', revision: '1', moduleIds: ['host'] },
                { id: 'extended', label: 'Extended fixture', description: 'Additional synthetic checks', revision: '1', moduleIds: ['host', 'extended-host'] },
            ], defaultPresetId: 'general' };
        }
        if (command === 'security_assessment_begin') {
            increment('begins');
            const host = useAppStore.getState().connections.find(item => item.id === args?.connectionId);
            if (!host || host.status !== 'connected' || !args?.expected || !sameSubject(host, args.expected as AssessmentSubject)) throw 'Synthetic admission identity mismatch.';
            assessmentSubject = { connectionId: host.id, name: host.name, host: host.host, username: host.username, port: host.port };
            document.body.dataset.begunConnection = host.id; document.body.dataset.activeConnectionAtBegin = String(useAppStore.getState().activeConnectionId);
            return { id: 'fixture-global-admission', identity: { host: host.host, username: host.username, port: host.port } };
        }
        if (command === 'security_assessment_cancel') { increment('cancellations'); return; }
        increment('remoteCalls'); throw new Error(`Global report browsing must not invoke ${command}`);
    },
    send() {}, on() { return () => {}; }, off() {},
};
useAppStore.setState({ connections: auditHosts.map(item => ({ ...item })), activeConnectionId: null,
    connect: async (id, options) => {
        increment('connectCalls'); document.body.dataset.connectedHost = id; document.body.dataset.connectOptions = JSON.stringify(options);
        useAppStore.setState(state => ({ connections: state.connections.map(item => item.id === id ? { ...item, status: 'connected', lastConnected: (item.lastConnected ?? 0) + 1 } : item) }));
    },
    openConnectionModal: id => { document.body.dataset.editedHost = id ?? ''; },
    showToast: (kind, message) => {
    document.body.dataset.toastKind = kind; document.body.dataset.toastMessage = message;
} });
publishCounts();
document.body.dataset.overlayGalleryTheme = 'dark';

/** Keep the panel mounted across simulated workspace-tab switches, as the real layout does. */
function GlobalAuditsFixture() {
    const [active, setActive] = useState(!new URLSearchParams(location.search).has('inactive'));
    useEffect(() => {
        const changeActive = (event: Event) => setActive((event as CustomEvent<boolean>).detail);
        window.addEventListener('fixture-audits-active', changeActive);
        return () => window.removeEventListener('fixture-audits-active', changeActive);
    }, []);
    useEffect(() => { document.body.dataset.auditsActive = String(active); }, [active]);
    return <GlobalSecurityAuditsPanel active={active} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><TooltipProvider><GlobalAuditsFixture /></TooltipProvider></StrictMode>);
