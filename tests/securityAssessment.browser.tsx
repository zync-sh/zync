import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { SecurityPanel } from '../src/features/security/ui/SecurityPanel';
import { PaneLeafView } from '../src/components/terminal/PaneLeafView';
import { dispatchAppShortcut } from '../src/features/shortcuts/dispatch';
import type { PaneLeaf, PaneLayout } from '../src/lib/paneLayout';
import { useAppStore } from '../src/store/useAppStore';
import type { AssessmentReport, AssessmentRequest, AssessmentResult, Finding } from '../src/features/security/domain/assessment';
import type { ModuleDefinition } from '../src/features/security/domain/modules';
import type { ReportPackage, SavedReport, SavedReportSummary } from '../src/features/security/domain/savedReports';
import type { SavedRisk } from '../src/features/security/domain/acceptedRisks';
import { sameRiskAcceptance } from '../src/features/security/domain/acceptedRisks';
import { findingRiskIdentityKey, riskIdentityKey } from '../src/features/security/domain/review';
import '../src/index.css';
import './uiOverlays.browser.css';

let pending: { request: AssessmentRequest; resolve: (report: AssessmentReport) => void; reject: (error: Error) => void } | null = null;
let held: ((value: { id: string; identity: { host: string; username: string; port: number } }) => void) | null = null;
let hold = false;
let begins = 0;
let runs = 0;
let cancellations = 0;
let authenticationRequired = false;
let uncertainOnly = false;
let rootSession = false;
let genericProfile = false;
let catalogFailure = false;
let catalogCalls = 0;
let nativeCalls = 0;
let connectCalls = 0;
let cancelConnectCalls = 0;
let finishConnect: (() => void) | undefined;
let lastReport: AssessmentReport | null = null;
const paneFocusFixture = new URLSearchParams(window.location.search).has('paneFocus');
const auditPane: PaneLeaf = { type: 'pane', id: 'audit-pane', content: { kind: 'feature', featureId: 'security', instanceId: 'audit-instance' } };
const siblingPane: PaneLeaf = { type: 'pane', id: 'sibling-pane', content: { kind: 'feature', featureId: 'dashboard', instanceId: 'dashboard-instance' } };
const focusLayout: PaneLayout = { version: 1, activePaneId: auditPane.id, root: {
    type: 'split', id: 'focus-split', direction: 'horizontal', sizes: [0.5, 0.5], children: [auditPane, siblingPane],
} };
const modules: ModuleDefinition[] = [
    { id: 'host', label: 'Host baseline', description: 'Kernel, SSH, account, file and network settings', group: 'host', checkCount: 38, recommended: true },
    { id: 'extended-host', label: 'Additional host protections', description: 'Additional local protections and logging settings', group: 'host', checkCount: 12, recommended: false },
    { id: 'docker', label: 'Docker', description: 'Selected local Docker daemon settings', group: 'applications', checkCount: 6, recommended: false },
    { id: 'postgres-runtime', label: 'PostgreSQL runtime', description: 'Read-only local database settings', group: 'applications', checkCount: 3, recommended: false,
        auth: { kind: 'postgresql', defaultPort: 5432, usernameRequired: true, secretRequired: false, defaultDatabase: 'postgres', secretLabel: 'Database password', maxSecretBytes: 4096 } },
    { id: 'mysql-runtime', label: 'MySQL runtime', description: 'Read-only local server settings', group: 'applications', checkCount: 3, recommended: false,
        auth: { kind: 'mysql', defaultPort: 3306, usernameRequired: true, secretRequired: true, secretLabel: 'Database password', maxSecretBytes: 79 } },
];
const presets = [
    { id: 'general', label: 'General server', description: 'Recommended host checks', moduleIds: ['host'], revision: '1' },
    { id: 'web', label: 'Web server', description: 'Host and additional protections', moduleIds: ['host', 'extended-host'], revision: '1' },
    { id: 'database', label: 'Database server', description: 'Host and PostgreSQL runtime', moduleIds: ['host', 'postgres-runtime'], revision: '1' },
    { id: 'ci', label: 'CI worker', description: 'Host and Docker', moduleIds: ['host', 'docker'], revision: '1' },
    { id: 'router', label: 'Router', description: 'Routing context', moduleIds: ['host', 'extended-host'], revision: '1' },
];

/** Generate public synthetic findings, never read files or contact a host. */
function report(request: AssessmentRequest): AssessmentReport {
    const selected = modules.filter(module => (request.modules ?? ['host']).includes(module.id));
    const findings: Finding[] = Array.from({ length: selected.some(module => module.id === 'host') ? 53 : 0 }, (_, index) => {
        const needsElevatedAccess = !request.elevationConsent && !rootSession && !uncertainOnly && index % 3 === 2 && index % 2 === 0;
        const status = index % 3 === 0 ? (index % 2 === 0 ? 'passed' : 'informational') : index % 3 === 1 ? 'attention' : request.elevationConsent ? 'passed' : 'notAssessed';
        return {
            id: `AUTH-${index}`, title: index === 1 ? 'Process tracing restrictions' : `Fixture recommendation ${index}`,
            needsElevatedAccess,
            sudoRetryEligible: !request.elevationConsent && !rootSession && index % 3 === 2 && (index % 2 === 0 || index === 5),
            moduleId: 'host', category: index === 1 ? 'Kernel' : status === 'informational' ? 'SSH' : index % 2 ? 'Network' : 'Accounts', status,
            target: index === 1 ? 'kernel.yama.ptrace_scope' : index === 4 ? `/fixture/${'managed-policy-'.repeat(12)}settings.conf` : '/fixture',
            evidence: index === 1 ? `ptrace_scope=0\nSynthetic collector evidence: ${'unbroken-fixture-evidence-'.repeat(10)}` : 'Synthetic evidence only',
            observed: index === 1 ? 'Process tracing uses the least restrictive setting (ptrace_scope = 0).' : status === 'notAssessed'
                ? needsElevatedAccess ? 'Your SSH account was denied access to information for this check.' : 'Zync could not collect enough information for this check.'
                : status === 'informational' ? 'Password sign-in is disabled in the default SSH configuration.' : 'There is one local account with full administrator access.',
            expected: index === 1 ? 'Restrict which processes can inspect another process (ptrace_scope = 1–3).' : status === 'informational'
                ? 'Compare this default with the host’s needs. The active server and per-connection rules may differ.'
                : 'Keep one managed local account with full administrator access.',
            rationale: index === 1 ? 'Process tracing can expose another process’s memory and credentials.' : 'Account and access settings need to fit the work this host does.',
            scope: index === 1
                ? 'Current kernel.yama.ptrace_scope value in this host namespace only. Persistent sysctl policy, approved debugger exceptions, application compatibility and the effect on every running process were not assessed. Zync cannot determine what the host’s applications require.'
                : status === 'informational' ? 'Default SSH settings only. Settings used by the running server and per-connection Match rules were not checked.' : 'This local setting only. Zync cannot determine what the host’s applications require.',
            scopeSummary: index === 1 ? 'Current process-tracing setting only; persistence and application needs were not assessed.' : undefined,
            ruleVersion: '1', reviewedAt: '2026-10-25',
            targetKey: `fixture:${index}`, evidenceKey: `evidence:${index}:${status}`, evidenceKind: 'runtime', priority: index === 1 ? 'high' : 'review',
            recommendation: index % 3 === 2
                ? 'Review why information was unavailable in Evidence, then run the assessment again. Do not change security settings based on this unavailable check.'
                : index === 1 ? 'Review process tracing restrictions with the host administrator before changing this setting.' : 'Review host guidance before changing settings.',
            remediation: index === 1 ? {
                change: 'Review approved debugging and monitoring needs.\nRecord the current tracing value and recovery route.\nChoose a compatible restriction and update the managed kernel setting after approval.',
                impact: 'Debuggers, profilers and crash-reporting tools may need additional permission.',
                verification: 'Read the active tracing setting again.\nConfirm approved debugging still works.\nVerify persistence separately after a planned restart.',
                rollback: 'Restore the previous managed value and confirm that the original tracing behavior returns.',
            } : index === 2 ? {
                // A forged change guide must never appear for unavailable evidence or a passed result.
                change: 'Do not display this unassessed configuration change.', impact: 'Unassessed fixture impact.',
                verification: 'Unassessed fixture verification.', rollback: 'Unassessed fixture rollback.',
            } : index === 7 ? {
                // Imported strings stay inert even when they resemble HTML or shell syntax.
                change: 'Review this literal fixture text only.\n<img src=x onerror="document.body.dataset.guideExecuted=\'true\'">',
                impact: 'Literal shell syntax: $(printf fixture-only).',
                verification: 'Inspect this synthetic text without executing it.\nDo not follow literal shell syntax: $(printf fixture-only).', rollback: 'No change was made by this text.',
            } : index === 10 ? {
                // Existing recorded guides without step boundaries remain readable paragraphs.
                change: 'Review the recorded single-line change with the administrator.',
                impact: 'An approved workflow may need adjustment.',
                verification: 'Verify the recorded setting and required workflow.',
                rollback: 'Restore the prior approved configuration if needed.',
            } : index === 13 ? {
                // Imported prose must stay complete without creating an unbounded list of DOM nodes.
                change: Array.from({ length: 13 }, (_, line) => `Imported long guide line ${line + 1}.`).join('\n'),
                impact: 'Synthetic imported context only.',
                verification: Array.from({ length: 13 }, (_, line) => `Imported verification line ${line + 1}.`).join('\n'),
                rollback: 'No configuration was changed by opening this guide.',
            } : undefined,
            reference: index === 7 ? 'javascript:alert("fixture-only")' : 'https://man.openbsd.org/sshd_config',
        };
    });
    for (const module of selected.filter(module => module.id !== 'host')) {
        for (let index = 0; index < module.checkCount; index++) findings.push({
            id: `${module.id}-${index}`, moduleId: module.id, title: `${module.label} fixture check ${index + 1}`,
            category: 'Applications', status: 'informational', target: 'Synthetic local settings', evidence: 'Synthetic scoped evidence only',
            observed: 'The selected application setting was collected.', recommendation: 'Review this setting against your application requirements.',
            reference: 'https://man.openbsd.org/sshd_config',
        });
    }
    for (const index of genericProfile ? [53, 54] : []) findings.push({
        id: `AUTH-${index}`, title: index === 53 ? 'APT automatic-update configuration' : 'dpkg database consistency',
        moduleId: 'host', status: 'notApplicable', category: 'Updates',
        target: index === 53 ? 'APT::Periodic settings' : 'dpkg --audit',
        observed: 'This check does not apply to Fedora.', expected: 'These package checks are for Debian and Ubuntu.',
        applicabilityReason: index === 53 ? 'This APT check is for Debian and Ubuntu. The host runs Fedora.' : 'This dpkg check is for Debian and Ubuntu. The host runs Fedora.',
        rationale: 'Different Linux systems manage software updates in different ways.',
        scope: 'Debian and Ubuntu package tools only. Other package managers were not checked.',
        evidence: 'Synthetic applicability evidence only', recommendation: 'Review the host’s package manager separately.',
        reference: 'https://ubuntu.com/server/docs/how-to/software/automatic-updates/', ruleVersion: '1', reviewedAt: '2026-10-25',
        needsElevatedAccess: false, sudoRetryEligible: false,
    });
    return {
        kind: 'hardening', target: 'Connected Linux host', os: genericProfile ? 'fedora 41' : 'ubuntu 24.04', version: 'zync-linux-7 (2026-10-25)', findings,
        transportFingerprint: 'sha256:fixture-verified-key', policy: { id: request.presetId ?? 'general', label: presets.find(preset => preset.id === (request.presetId ?? 'general'))!.label, revision: '1' },
        profile: genericProfile ? {
            id: 'zync-linux-generic', label: 'Zync Linux generic', platformId: 'fedora', platformVersion: '41', coverage: 'generic',
            coverageNote: 'Only general Linux checks are available for Fedora. Zync has no checks written for this Fedora version. Testing on real SSH hosts and virtual machines is still required.',
        } : {
            id: 'zync-ubuntu-24.04', label: 'Zync Ubuntu 24.04', platformId: 'ubuntu', platformVersion: '24.04', coverage: 'targeted',
            coverageNote: 'Checks are written for Ubuntu 24.04 and cover selected Linux and package settings. Testing on real SSH hosts and virtual machines is still required; this label is not a support or compliance certification.',
        },
        totalFindings: findings.length, truncated: false, notes: ['Fixture coverage: restricted files may be unavailable. No changes were applied.'],
        collectorUid: rootSession ? 0 : 1000, elevationRequested: request.elevationConsent ?? false, modules: selected,
    };
}

const savedReports = new Map<string, SavedReport>();
const savedRisks = new Map<string, SavedRisk>();
const seededRisks = new Set<string>();
/** Synthetic acceptance rows cover pagination and expired-note removal without touching real storage. */
window.addEventListener('fixture-seed-risk-pages', () => {
    const original = [...savedRisks.values()][0]; if (!original) return;
    for (let index = 1; index <= 6; index++) {
        const id = `sha256:${String(index).padStart(64, '0')}`;
        const copy = structuredClone(original); copy.id = id; copy.title = `Risk page fixture ${index}`;
        copy.annotation.id = crypto.randomUUID(); copy.annotation.ruleId = `FIXTURE-${index}`;
        if (index === 6) { copy.annotation.createdAt = Date.now() - 2000; copy.annotation.expiresAt = Date.now() - 1000; }
        savedRisks.set(id, copy); seededRisks.add(id);
    }
});
window.addEventListener('fixture-clear-risk-pages', () => { seededRisks.forEach(id => savedRisks.delete(id)); seededRisks.clear(); });
/** Seed additional inert summaries only for the inline list's bounded pagination regression. */
window.addEventListener('fixture-seed-report-pages', () => {
    const original = [...savedReports.values()][0]; if (!original) return;
    for (let index = 0; index < 6; index++) {
        const copy = structuredClone(original); copy.summary.id = crypto.randomUUID(); copy.summary.name = `History page fixture ${index + 1}`;
        savedReports.set(copy.summary.id, copy);
    }
});
let releaseSavedLoad: (() => void) | undefined;
window.addEventListener('fixture-release-saved-load', () => { document.body.dataset.holdSavedLoad = ''; releaseSavedLoad?.(); releaseSavedLoad = undefined; });
let releaseSavedList: (() => void) | undefined;
window.addEventListener('fixture-release-saved-list', () => { document.body.dataset.holdSavedList = ''; releaseSavedList?.(); releaseSavedList = undefined; });
/** The library fixture survives pane teardown, while native tests verify real database restarts and transactions. */
async function libraryFixture(command: string, args: Record<string, unknown>) {
    const revision = command === 'security_assessment_save_report' ? args.replace : command === 'security_assessment_delete_report' ? args.revision : undefined;
    if (revision && Object.keys(revision).sort().join(',') !== 'id,revision') throw 'Native revisions accept only id and revision.';
    const riskRows = () => { document.body.dataset.savedRisks = String(savedRisks.size); };
    if (command === 'security_assessment_accepted_risks') {
        const subject = args.subject as { host: string; username: string; port: number };
        return [...savedRisks.values()].filter(row => row.annotation.host === subject.host && row.annotation.username === subject.username && row.annotation.port === subject.port);
    }
    if (command === 'security_assessment_save_accepted_risks') {
        const { version: _version, annotations, ...result } = JSON.parse(String(args.payload));
        const expected = args.revisions as { id: string; revision: number }[];
        const records: SavedRisk[] = [];
        for (const annotation of annotations) {
            const key = riskIdentityKey(annotation);
            const finding = result.report.findings.find((item: Finding) => findingRiskIdentityKey(result, item) === key);
            if (!finding) continue;
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
            const id = 'sha256:' + [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
            const old = savedRisks.get(id);
            if (old && !expected.some(item => item.id === id && item.revision === old.revision) && !sameRiskAcceptance(old.annotation, annotation)) throw 'This accepted risk changed.';
            records.push({ id, revision: old ? old.revision + 1 : 1, title: finding.title, target: finding.target, annotation });
        }
        if (!records.length) throw 'No matching accepted risks.';
        records.forEach(row => savedRisks.set(row.id, row)); riskRows(); return records;
    }
    if (command === 'security_assessment_remove_accepted_risk') {
        const revision = args.revision as { id: string; revision: number }; const item = savedRisks.get(revision.id);
        if (!item || item.revision !== revision.revision) throw 'This accepted risk changed.';
        savedRisks.delete(revision.id); riskRows(); return;
    }
    if (command === 'security_assessment_saved_reports') {
        document.body.dataset.savedListCalls = String(Number(document.body.dataset.savedListCalls || 0) + 1);
        if (document.body.dataset.holdSavedList === 'true') { document.body.dataset.savedListPending = 'true'; await new Promise<void>(resolve => { releaseSavedList = resolve; }); document.body.dataset.savedListPending = ''; }
        const subject = args.subject as { host: string; username: string; port: number };
        return [...savedReports.values()].map(item => item.summary).filter(item => item.host === subject.host && item.username === subject.username && item.port === subject.port);
    }
    if (command === 'security_assessment_load_report') {
        document.body.dataset.savedLoads = String(Number(document.body.dataset.savedLoads || 0) + 1);
        if (document.body.dataset.holdSavedLoad === 'true') { document.body.dataset.savedLoadPending = 'true'; await new Promise<void>(resolve => { releaseSavedLoad = resolve; }); document.body.dataset.savedLoadPending = ''; }
        const item = savedReports.get(String(args.id)); if (!item) throw 'Saved report not found.'; return structuredClone(item);
    }
    if (command === 'security_assessment_save_report') {
        const value = JSON.parse(String(args.payload));
        const replacement = args.replace as { id: string; revision: number } | undefined;
        const previous = replacement ? savedReports.get(replacement.id) : undefined;
        if (replacement && previous?.summary.revision !== replacement.revision) throw 'This report changed. Refresh saved reports.';
        const id = previous?.summary.id ?? crypto.randomUUID();
        const summary: SavedReportSummary = { id, name: String(args.name), revision: (previous?.summary.revision ?? 0) + 1, createdAt: previous?.summary.createdAt ?? Date.now(), updatedAt: Date.now(), completedAt: value.completedAt,
            host: value.subject.host, username: value.subject.username, port: value.subject.port, fingerprint: value.report.transportFingerprint, baseline: value.report.version, findings: value.report.findings.length,
            attention: value.report.findings.filter((finding: Finding) => finding.status === 'attention').length, bytes: String(args.payload).length };
        const { version: _version, annotations, ...result } = value;
        savedReports.set(id, { summary, result, annotations }); document.body.dataset.savedReports = String(savedReports.size); return summary;
    }
    if (command === 'security_assessment_delete_report') {
        const revision = args.revision as { id: string; revision: number }; const report = savedReports.get(revision.id);
        if (!report || report.summary.revision !== revision.revision) throw 'This report changed.';
        const risks = (args.riskRevisions ?? []) as { id: string; revision: number }[];
        for (const revision of risks) {
            const row = savedRisks.get(revision.id);
            if (!row || row.revision !== revision.revision || !report.annotations.some(item => sameRiskAcceptance(row.annotation, item))) throw 'This accepted risk changed.';
        }
        risks.forEach(revision => savedRisks.delete(revision.id)); riskRows();
        savedReports.delete(revision.id); document.body.dataset.savedReports = String(savedReports.size); return;
    }
    if (command === 'security_assessment_export') { document.body.dataset.export = String(args.payload); document.body.dataset.exportFormat = String(args.format); return; }
    if (command === 'security_assessment_import_package') {
        if (!lastReport) throw new Error('No report fixture');
        return { result: { subject: { connectionId: 'fixture', name: 'Production lab', host: 'fixture.invalid', username: 'fixture', port: 22 }, report: structuredClone(lastReport), startedAt: Date.now() - 120000, completedAt: Date.now() - 60000 }, annotations: [] } satisfies ReportPackage;
    }
    throw new Error('Unknown report fixture command');
}

Object.assign(window, { __TAURI_INTERNALS__: { async invoke(command: string, args: Record<string, unknown>) {
    document.body.dataset.nativeCalls = String(++nativeCalls);
    if (['security_assessment_saved_reports', 'security_assessment_load_report', 'security_assessment_save_report', 'security_assessment_delete_report', 'security_assessment_export', 'security_assessment_import_package', 'security_assessment_accepted_risks', 'security_assessment_save_accepted_risks', 'security_assessment_remove_accepted_risk'].includes(command)) return libraryFixture(command, args);
    if (command === 'plugin:dialog|save') return (args.options as { defaultPath?: string })?.defaultPath?.includes('accepted-risks') ? 'C:\\fixture\\accepted.json' : 'C:\\fixture\\assessment.json';
    if (command === 'plugin:dialog|open') return 'C:\\fixture\\imported.json';
    if (command === 'security_assessment_run') {
        document.body.dataset.runs = String(++runs);
        document.body.dataset.request = JSON.stringify(args.request);
        const credentials = args.credentials as { secret: string; kind: string; port: number; username: string; database: string }[];
        document.body.dataset.runtimeAuthenticated = String(credentials.some(item => item.secret === 'runtime-fixture-secret' && item.kind === 'postgresql' && item.username === 'observer' && item.port === 5432));
        return new Promise<AssessmentReport>((resolve, reject) => { pending = { request: args.request as AssessmentRequest, resolve, reject }; });
    }
    if (command === 'security_assessment_needs_password') return authenticationRequired;
    if (command === 'security_assessment_authenticate') {
        authenticationRequired = false;
        document.body.dataset.authenticated = String(args.password === 'fixture-secret');
        if (args.password !== 'fixture-secret') { pending?.reject(new Error('Sudo authentication was not accepted. The password was not retried.')); pending = null; }
        return;
    }
    throw new Error(`Unexpected Tauri fixture call: ${command}`);
} } });
window.ipcRenderer = { async invoke(channel: string, payload: Record<string, unknown>) {
    document.body.dataset.nativeCalls = String(++nativeCalls);
    if (channel === 'security_assessment_catalog') {
        document.body.dataset.catalogCalls = String(++catalogCalls);
        if (catalogFailure) throw new Error('Fixture catalog unavailable');
        return { version: '1', modules: modules.map(module => ({ ...module })), presets: presets.map(preset => ({ ...preset, moduleIds: [...preset.moduleIds] })), defaultPresetId: 'general' };
    }
    if (channel === 'security_assessment_modules') {
        document.body.dataset.catalogCalls = String(++catalogCalls);
        if (catalogFailure) throw new Error('Fixture catalog unavailable');
        return modules.map(module => ({ ...module }));
    }
    if (channel === 'security_assessment_begin') {
        document.body.dataset.begins = String(++begins);
        if ((payload.expected as { host: string }).host !== 'fixture.invalid') throw new Error('The saved host differs from the live SSH connection. Reconnect before starting an assessment.');
        if (hold) return new Promise(resolve => { held = resolve; });
        return { id: `fixture-${begins}`, identity: payload.expected };
    }
    if (channel === 'security_assessment_run') return new Promise<AssessmentReport>((resolve, reject) => { document.body.dataset.request = JSON.stringify(payload.request); pending = { request: payload.request as AssessmentRequest, resolve, reject }; });
    if (channel === 'security_assessment_cancel') { authenticationRequired = false; document.body.dataset.cancellations = String(++cancellations); return; }
    if (channel === 'fs_write_file') { document.body.dataset[String(payload.path).includes('accepted') ? 'annotations' : 'export'] = String(payload.content); return; }
    if (channel === 'security_assessment_import_report') {
        if (!lastReport) throw new Error('No report fixture');
        const previous = JSON.parse(JSON.stringify(lastReport)) as AssessmentReport;
        if (document.body.dataset.comparisonFixture === 'previous-sudo') {
            previous.elevationRequested = true;
            previous.findings = previous.findings.map(finding => finding.status === 'notAssessed' ? { ...finding, status: 'passed', needsElevatedAccess: false, evidenceKey: 'earlier-readable-evidence' } : finding);
        } else if (document.body.dataset.comparisonFixture !== 'unchanged') previous.findings[0] = { ...previous.findings[0], status: 'attention', evidenceKey: 'older-evidence' };
        return { subject: { connectionId: 'fixture', name: 'Production lab', host: 'fixture.invalid', username: 'fixture', port: 22 }, report: previous,
            startedAt: Date.now() - 120000, completedAt: Date.now() - 60000 } satisfies AssessmentResult;
    }
    if (channel === 'security_assessment_import_annotations') return document.body.dataset.annotations ? JSON.parse(document.body.dataset.annotations).annotations : [];
    if (channel === 'shell:open') { document.body.dataset.reference = String(payload); return; }
    throw new Error(`Unexpected assessment fixture command: ${channel}`);
} } as typeof window.ipcRenderer;
useAppStore.setState({ connections: [{ id: 'fixture', name: 'Production lab', host: 'fixture.invalid', username: 'fixture', port: 22, status: 'connected', lastConnected: 1 }],
    ...(paneFocusFixture ? {
        tabs: [{ id: 'fixture-host', type: 'connection' as const, connectionId: 'fixture', title: 'Production lab', view: 'security' }],
        activeTabId: 'fixture-host', activeConnectionId: 'fixture', showWelcomeScreen: false,
        terminals: { fixture: [] }, paneLayouts: { fixture: { audit: focusLayout } },
        activePaneGroupOwner: { fixture: 'audit' }, activeTerminalIds: { fixture: null },
        saveSession: async () => {},
    } : {}),
    connect: async id => {
        document.body.dataset.connectCalls = String(++connectCalls);
        useAppStore.setState(state => ({ connections: state.connections.map(item => item.id === id ? { ...item, status: 'connecting' } : item) }));
        await new Promise<void>(resolve => { finishConnect = resolve; });
    },
    cancelConnect: async id => {
        document.body.dataset.cancelConnectCalls = String(++cancelConnectCalls);
        useAppStore.setState(state => ({ connections: state.connections.map(item => item.id === id ? { ...item, status: 'disconnected' } : item) }));
        finishConnect?.(); finishConnect = undefined;
    },
    showToast: (type, message) => { document.body.dataset.toast = `${type}:${message}`; } });

/** Fixture controls are outside the production panel and never call native APIs. */
function Fixture() {
    const [open, setOpen] = useState(true);
    const [local, setLocal] = useState(false);
    const layout = useAppStore(state => state.paneLayouts.fixture?.audit);
    useEffect(() => {
        if (!paneFocusFixture) return;
        const onKeyDown = (event: KeyboardEvent) => { if (dispatchAppShortcut(event)) event.preventDefault(); };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);
    return <TooltipProvider><div className="flex h-screen flex-col bg-app-bg text-app-text">
        <div className="flex flex-wrap gap-3 border-b border-app-border p-2 text-xs" aria-label="Fixture controls">
            <button onClick={() => { if (pending) { const run = pending; pending = null; lastReport = report(run.request); run.resolve(lastReport); } }}>Complete scan fixture</button>
            <button onClick={() => { uncertainOnly = !uncertainOnly; }}>Toggle uncertain-only fixture</button>
            <button onClick={() => { rootSession = !rootSession; }}>Toggle root fixture</button>
            <button onClick={() => { genericProfile = !genericProfile; }}>Toggle generic profile fixture</button>
            <button onClick={() => { catalogFailure = !catalogFailure; }}>Toggle catalog failure fixture</button>
            <button onClick={() => { authenticationRequired = true; }}>Request sudo fixture</button>
            <button onClick={() => { pending?.reject(new Error('Host collection unavailable. Try again later.')); pending = null; }}>Fail scan fixture</button>
            <button onClick={() => { hold = true; }}>Hold admission fixture</button>
            <button onClick={() => { hold = false; held?.({ id: 'held-id', identity: { host: 'fixture.invalid', username: 'fixture', port: 22 } }); held = null; }}>Release admission fixture</button>
            <button onClick={() => useAppStore.setState(state => ({ connections: state.connections.map(item => ({ ...item, status: item.status === 'connected' ? 'disconnected' : 'connected', lastConnected: (item.lastConnected ?? 1) + 1 })) }))}>Toggle connection fixture</button>
            <button onClick={() => {
                if (!finishConnect) return;
                useAppStore.setState(state => ({ connections: state.connections.map(item => ({ ...item, status: 'connected', lastConnected: (item.lastConnected ?? 1) + 1 })) }));
                finishConnect?.(); finishConnect = undefined;
            }}>Complete connection fixture</button>
            <button onClick={() => void useAppStore.getState().cancelConnect('fixture')}>Cancel connection fixture</button>
            <button onClick={() => setOpen(!open)}>Toggle pane fixture</button>
            <button onClick={() => setLocal(!local)}>Toggle local fixture</button>
            <button onClick={() => useAppStore.setState(state => ({ connections: state.connections.map(item => ({ ...item, host: item.host === 'fixture.invalid' ? 'edited.invalid' : 'fixture.invalid' })) }))}>Edit saved host fixture</button>
        </div>
        <div data-assessment-fixture-panel className="min-h-0 flex-1">{open && (paneFocusFixture && layout
            ? <div data-fixture-focused-pane={layout.activePaneId} className="flex h-full">
                <div className="min-w-0 flex-1"><PaneLeafView connectionId="fixture" node={auditPane} layout={layout} split edges={{ top: false, right: true, bottom: false, left: false }} workspaceActive panelVisible /></div>
                <div className="w-12" aria-label="Sibling pane fixture" />
            </div> : <SecurityPanel connectionId={local ? 'local' : 'fixture'} />)}</div>
    </div></TooltipProvider>;
}
document.body.dataset.overlayGalleryTheme = 'dark';
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
