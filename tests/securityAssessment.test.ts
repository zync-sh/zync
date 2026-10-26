import { AssessmentController, type AssessmentPort } from '../src/features/security/application/assessmentController';
import { filterFindings, findingStatusLabel, findingSummary, findingSudoRetryLabel, hardeningAccessLabel, hardeningCoverage, hardeningSudoRetryLabel, referenceUrl, requestError, STATUS_LABELS, type AssessmentRequest, type AssessmentAdmission, type AssessmentReport, type AssessmentSubject, type Finding } from '../src/features/security/domain/assessment';
import { buildWorkspaceOpenItems } from '../src/components/layout/workspaceOpen/buildWorkspaceOpenItems';
import { SPLIT_FEATURE_IDS } from '../src/lib/paneLayout/types';
import { builtinWorkspaceViewLabel } from '../src/features/workspace/domain/registrations';
import { moduleScopeSummary, parseModuleCatalog, sameModuleSelection, selectedModules, type ModuleDefinition } from '../src/features/security/domain/modules';
import { credentialError, parseAssessmentCatalog, type RuntimeCredential } from '../src/features/security/domain/modules';
import { compareAssessments, comparisonIssue, createRiskException, matchingRiskException, mergeRiskExceptions } from '../src/features/security/domain/review';
import { reportBelongsToHost, reportPayload, replacementReports, type SavedReportSummary } from '../src/features/security/domain/savedReports';
import type { AssessmentResult } from '../src/features/security/domain/assessment';
import { acceptanceRevisions, reportRiskAnnotations, reportRiskRemovals, type SavedRisk } from '../src/features/security/domain/acceptedRisks';
import { auditPolicyRevisionLabel, auditPresetLabel, auditProfileLabel, auditRulesLabel } from '../src/features/security/domain/presentation';

/** Fail without coupling the browser-oriented project to Node type declarations. */
function check(value: unknown, message: string): void { if (!value) throw new Error(message); }
/** Control admission and execution races without a real SSH transport or network request. */
function deferred<T>() { let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

const subject: AssessmentSubject = { connectionId: 'fixture', name: 'Fixture', host: 'fixture.invalid', username: 'fixture', port: 22 };
const report: AssessmentReport = { kind: 'hardening', target: 'Connected Linux host', os: 'ubuntu 24.04', version: 'fixture', findings: [], totalFindings: 0, truncated: false,
    notes: ['fixture coverage'] };
const request = { kind: 'hardening' as const };
check(auditRulesLabel('zync-linux-7 (2026-10-25)') === 'Linux audit rules · v7', 'Baseline display explains its revision without exposing the internal prefix');
check(auditRulesLabel('zync-linux-7 (2026-10-25)', true) === 'Linux audit rules · v7 (2026-10-25)', 'Expanded metadata retains the exact recorded revision date without timezone conversion');
check(auditRulesLabel('zync-linux-5') === 'Linux audit rules · v5', 'Earlier baseline revisions remain identifiable');
for (const custom of ['custom-baseline', 'zync-linux-next', 'zync-linux-7 (custom)']) check(auditRulesLabel(custom, true) === custom, 'Unknown baseline metadata stays recorded text without an invented revision');
const namedProfile = Object.freeze({ id: 'zync-ubuntu-24.04', label: 'Zync Ubuntu 24.04', platformId: 'ubuntu', platformVersion: '24.04', coverage: 'targeted' as const, coverageNote: 'Selected checks' });
check(auditProfileLabel(namedProfile) === 'Ubuntu 24.04' && namedProfile.id === 'zync-ubuntu-24.04', 'Profile names are readable without mutating their compatibility identity');
check(auditProfileLabel({ ...namedProfile, id: 'zync-linux-generic', label: 'Zync Linux generic', platformVersion: '25.04', coverage: 'generic' }) === 'General Linux checks', 'Generic checks are not relabeled as an authored Ubuntu profile');
check(auditProfileLabel({ ...namedProfile, label: 'Custom recorded profile' }) === 'Custom recorded profile', 'Custom imported profile labels remain intact');
check(auditProfileLabel({ ...namedProfile, label: '' }) === namedProfile.id, 'A missing legacy profile name retains its recorded identifier instead of becoming blank');
check(auditPresetLabel('general', [{ id: 'general', label: 'Native preset label', description: '', moduleIds: ['host'], revision: 'zync-role-1' }]) === 'Native preset label', 'Accepted risks reuse native catalog names rather than duplicate preset definitions');
check(auditPresetLabel('legacy-preset', []) === 'legacy-preset', 'Unavailable historical preset names have an honest fallback');
check(auditPolicyRevisionLabel('zync-role-1') === 'Revision 1' && auditPolicyRevisionLabel('1') === 'Revision 1' && auditPolicyRevisionLabel('custom-rules') === 'custom-rules', 'Known policy revisions are readable and unknown versions stay unchanged');
check(STATUS_LABELS.notAssessed === 'Evidence unavailable', 'Missing check evidence is not presented as a failed check');
check(findingStatusLabel({ status: 'notAssessed', needsElevatedAccess: true }) === 'Needs elevated access', 'Verified restricted evidence has an explicit access badge');
check(findingStatusLabel({ status: 'notAssessed' }) === 'Evidence unavailable', 'Old reports and unknown causes do not claim sudo is required');
check(findingStatusLabel({ status: 'passed', needsElevatedAccess: true }) === 'Passed', 'An inconsistent access flag cannot override a completed check');
check(!requestError({ kind: 'hardening', elevationConsent: true }), 'Explicit hardening elevation is allowed');
for (const modules of [[], ['host', 'host'], ['bad;command'], ['unknown/path'], Array(65).fill('host')]) {
    check(Boolean(requestError({ kind: 'hardening', modules })), 'Malformed or empty scope fails before admission');
}
const scopeCatalog: ModuleDefinition[] = [
    { id: 'host', label: 'Host baseline', description: 'Host settings', group: 'host', checkCount: 38, recommended: true },
    { id: 'docker', label: 'Docker', description: 'Application settings', group: 'applications', checkCount: 6, recommended: false },
];
check(parseModuleCatalog(scopeCatalog).length === 2, 'Native catalog metadata drives available choices');
for (const invalid of [null, [], [...scopeCatalog, scopeCatalog[0]], [{ ...scopeCatalog[0], checkCount: -1 }], [{ ...scopeCatalog[0], group: 'remote-command' }]]) {
    let failed = false;
    try { parseModuleCatalog(invalid); } catch { failed = true; }
    check(failed, 'Malformed or duplicated metadata never invents available checks');
}
check(selectedModules(scopeCatalog, ['docker', 'host']).map(module => module.id).join(',') === 'host,docker', 'Catalog order stabilizes selected labels and counts');
check(moduleScopeSummary(scopeCatalog) === 'Host baseline + 1 more · 44 checks', 'Scope summary uses native counts');
check(moduleScopeSummary([]) === 'Choose at least one area', 'Empty scope receives a clear action');
check(sameModuleSelection(['docker', 'host'], scopeCatalog), 'Native scope ordering does not change approved coverage');
check(!sameModuleSelection(['host'], scopeCatalog) && !sameModuleSelection(['host'], undefined), 'Additional or absent response scope cannot satisfy an explicit request');
const identity = { host: subject.host, username: subject.username, port: subject.port };
const begins = deferred<AssessmentAdmission>();
let beginCalls = 0;
let runCalls = 0;
const cancelled: string[] = [];
const port: AssessmentPort = { begin: async () => { beginCalls++; return begins.promise; },
    run: async () => { runCalls++; return report; }, cancel: async id => { cancelled.push(id); } };
const controller = new AssessmentController(subject, port);
check(beginCalls === 0 && controller.snapshot().status === 'idle', 'Opening/restoring a pane never starts work');
const starting = controller.start(request);
await controller.start(request);
check(beginCalls === 1, 'One pending run per pane');
controller.cancel();
begins.resolve({ id: 'pending-id', identity });
await starting;
check(runCalls === 0 && cancelled.includes('pending-id'), 'Early cancellation cannot launch collectors');
check(controller.snapshot().status === 'cancelled', 'Admission cancellation stays cancelled');

const running = deferred<AssessmentReport>();
const active = new AssessmentController(subject, { ...port, begin: async () => ({ id: 'active', identity }), run: async () => running.promise });
const operation = active.start(request);
await Promise.resolve();
active.cancel();
running.resolve(report);
await operation;
check(active.snapshot().status === 'cancelled', 'Late results cannot overwrite cancellation');

const mutableSubject = { ...subject };
const captured = new AssessmentController(mutableSubject, { ...port, begin: async () => ({ id: 'captured', identity }), run: async () => report });
const completed = captured.start(request);
mutableSubject.host = 'changed.invalid';
await completed;
const result = captured.snapshot();
check(result.status === 'completed', 'Explicit completion publishes report');
if (result.status !== 'completed') throw new Error('Missing completed fixture');
check(result.result.subject.host === 'fixture.invalid', 'Report captures the live host identity');
check(result.result.startedAt <= result.result.completedAt, 'Export timestamps are ordered');
const scopeAdmission = deferred<AssessmentAdmission>();
const mutableScope = ['host'];
let submittedScope = '';
const scoped = new AssessmentController(subject, { ...port, begin: () => scopeAdmission.promise,
    run: async (_id, capturedRequest) => { submittedScope = capturedRequest.modules?.join(',') ?? ''; return { ...report, modules: [scopeCatalog[0]] }; } });
const scopeRun = scoped.start({ kind: 'hardening', modules: mutableScope });
mutableScope.push('docker');
scopeAdmission.resolve({ id: 'scope', identity });
await scopeRun;
check(submittedScope === 'host' && scoped.snapshot().status === 'completed', 'Scope is deeply captured before admission awaits');
const changedScope = new AssessmentController(subject, { ...port, begin: async () => ({ id: 'wrong-scope', identity }), run: async () => ({ ...report, modules: scopeCatalog }) });
await changedScope.start({ kind: 'hardening', modules: ['host'] });
check(changedScope.snapshot().status === 'failed', 'Response scope cannot silently add checks to the approval');

const mismatch = new AssessmentController(subject, { ...port, begin: async () => ({ id: 'wrong', identity }), run: async () => ({ ...report, kind: 'unsupported' } as unknown as AssessmentReport) });
await mismatch.start(request);
check(mismatch.snapshot().status === 'failed', 'Mismatched response type is rejected');
let wrongHostRuns = 0;
const edited = new AssessmentController({ ...subject, host: 'edited.invalid' }, { ...port, begin: async () => ({ id: 'old-live-transport', identity }), run: async () => { wrongHostRuns++; return report; } });
await edited.start(request);
check(edited.snapshot().status === 'failed' && wrongHostRuns === 0, 'Saved edits cannot relabel a still-live transport');
const unsupported = new AssessmentController(subject, port);
await unsupported.start({ kind: 'vulnerabilities' } as unknown as AssessmentRequest);
check(unsupported.snapshot().status === 'failed' && beginCalls === 1, 'Removed VA requests fail before admission');
check(!requestError(request), 'Hardening does not require online consent');
const failure = new AssessmentController(subject, { ...port, begin: async () => { throw new Error('Host collection unavailable'); } });
await failure.start(request);
check(failure.snapshot().status === 'failed', 'Failed assessment is not an empty clean report');

const authenticationReport = deferred<AssessmentReport>();
let answered = 0;
let needsAuthentication = true;
const secretSnapshots: string[] = [];
const authentication = new AssessmentController(subject, { ...port,
    begin: async () => ({ id: 'authentication', identity }), run: async () => authenticationReport.promise,
    needsPassword: async () => needsAuthentication,
    authenticate: async (id, password) => { check(id === 'authentication' && password === 'fixture-secret', 'Password goes only to its native challenge'); answered++; needsAuthentication = false; },
});
const unsubscribe = authentication.subscribe(() => secretSnapshots.push(JSON.stringify(authentication.snapshot())));
const authenticationRun = authentication.start({ ...request, elevationConsent: true });
const waitUntil = Date.now() + 2000;
while (Date.now() < waitUntil) { const snapshot = authentication.snapshot(); if (snapshot.status === 'running' && snapshot.authenticationRequired) break; await new Promise(resolve => setTimeout(resolve, 10)); }
const challenged = authentication.snapshot();
check(challenged.status === 'running' && challenged.authenticationRequired, 'Only a native challenge opens the password input');
await authentication.authenticate('fixture-secret');
await authentication.authenticate('fixture-secret');
check(answered === 1, 'A password is submitted at most once to the run-bound mailbox');
authenticationReport.resolve(report);
await authenticationRun;
check(authentication.snapshot().status === 'completed', 'Authenticated collection can finish');
check(secretSnapshots.every(snapshot => !snapshot.includes('fixture-secret')), 'No password enters published states, completed results or exports');
unsubscribe();
check(referenceUrl('https://man.openbsd.org/sshd_config') !== null, 'Reviewed hardening references are navigable');
check(referenceUrl('https://ubuntu.com/server/docs/how-to/software/automatic-updates/') !== null, 'The reviewed update/reboot source is navigable');
for (const url of ['https://nginx.org/en/docs/http/ngx_http_core_module.html', 'https://nginx.org/en/docs/http/ngx_http_autoindex_module.html',
    'https://nginx.org/en/docs/http/configuring_https_servers.html', 'https://redis.io/docs/latest/operate/oss_and_stack/management/security/',
    'https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/', 'https://docs.docker.com/engine/security/',
    'https://docs.docker.com/engine/security/seccomp/', 'https://docs.docker.com/engine/security/rootless/',
    'https://docs.docker.com/engine/logging/configure/', 'https://docs.docker.com/engine/daemon/live-restore/',
    'https://docs.kernel.org/admin-guide/sysctl/fs.html', 'https://docs.kernel.org/admin-guide/perf-security.html',
    'https://docs.kernel.org/admin-guide/sysctl/kernel.html', 'https://docs.kernel.org/admin-guide/sysrq.html',
    'https://docs.kernel.org/networking/ip-sysctl.html', 'https://man7.org/linux/man-pages/man5/group.5.html',
    'https://man7.org/linux/man-pages/man5/gshadow.5.html', 'https://www.sudo.ws/docs/man/sudoers.man/',
    'https://man7.org/linux/man-pages/man5/crontab.5.html', 'https://docs.kernel.org/security/lsm.html',
    'https://man7.org/linux/man-pages/man8/getenforce.8.html', 'https://ubuntu.com/server/docs/how-to/security/apparmor/',
    'https://man7.org/linux/man-pages/man8/auditctl.8.html', 'https://www.freedesktop.org/software/systemd/man/latest/timedatectl.html']) {
    check(referenceUrl(url) === url, 'Reviewed application references are navigable');
    check(referenceUrl(`${url}?redirect=untrusted`) === null && referenceUrl(`${url}/unreviewed`) === null, 'Reference allowlisting remains exact rather than trusting an entire documentation domain');
}
for (const url of ['javascript:alert(1)', 'https://osv.dev/vulnerability/CVE-fixture', 'https://man.openbsd.org.evil.invalid/sshd_config', 'https://man.openbsd.org/sshd_config?redirect=evil', 'https://evil.invalid']) check(referenceUrl(url) === null, 'Untrusted or removed advisory navigation is rejected');
const findings: Finding[] = ['passed', 'attention', 'notAssessed', 'informational'].map((status, index) => ({
    id: `CHECK-${index}`, status: status as Finding['status'], title: 'Fixture', target: '/fixture', evidence: 'fixture',
    recommendation: 'Review host policy', reference: 'https://man.openbsd.org/sshd_config',
}));
const coverageFixtures: Finding[] = [
    { ...findings[0], status: 'passed', needsElevatedAccess: true, sudoRetryEligible: true },
    { ...findings[0], status: 'attention', sudoRetryEligible: true },
    { ...findings[0], status: 'notAssessed', needsElevatedAccess: true, sudoRetryEligible: true },
    { ...findings[0], status: 'notAssessed', sudoRetryEligible: true },
    { ...findings[0], status: 'notAssessed' },
    { ...findings[0], status: 'informational', sudoRetryEligible: true },
];
const coverageSnapshot = JSON.stringify(coverageFixtures);
check(JSON.stringify(hardeningCoverage(coverageFixtures)) === JSON.stringify({ evaluated: 3, elevated: 1, unavailable: 2, notApplicable: 0, passed: 1, attention: 1, informational: 1 }), 'Coverage groups are disjoint and information counts as evaluated without counting as attention or passed');
check(findingStatusLabel(findings[1]) === 'Needs attention' && findingStatusLabel(findings[3]) === 'Informational', 'Attention and contextual observations have distinct labels');
check(filterFindings(coverageFixtures, '', 'attention').length === 1 && filterFindings(coverageFixtures, '', 'informational').length === 1, 'Attention and information filters agree with their counts');
check(hardeningCoverage([]).evaluated === 0, 'An empty report cannot imply complete coverage');
check(filterFindings(coverageFixtures, '', 'needsElevatedAccess').length === 1, 'The elevated-access filter matches its summary count');
check(filterFindings(coverageFixtures, '', 'evidenceUnavailable').length === 2, 'Other unavailable evidence is a distinct result filter');
check(filterFindings(coverageFixtures, '', 'notAssessed').length === 3, 'Underlying unavailable export status stays compatible');
check(findingSudoRetryLabel(coverageFixtures[2]) === 'Retry with sudo', 'Verified denial has a retry action');
check(findingSudoRetryLabel(coverageFixtures[3]) === 'Try with sudo' && findingStatusLabel(coverageFixtures[3]) === 'Evidence unavailable', 'Optional elevation never relabels an uncertain failure as access denied');
for (const index of [0, 1, 4, 5]) check(findingSudoRetryLabel(coverageFixtures[index]) === undefined, 'Assessed results and unqualified old failures cannot suggest sudo');
const retryReport: AssessmentReport = { ...report, collectorUid: 1000, elevationRequested: false, findings: coverageFixtures };
check(hardeningSudoRetryLabel(retryReport) === 'Retry with sudo', 'Summary prioritizes a confirmed denial when both types exist');
check(hardeningSudoRetryLabel({ ...retryReport, findings: [coverageFixtures[3]] }) === 'Try with sudo', 'A report with only eligible uncertain failures still offers approved elevation');
for (const patch of [{ collectorUid: 0 }, { collectorUid: undefined }, { collectorUid: null }, { collectorUid: NaN }, { collectorUid: -1 }, { elevationRequested: true }, { elevationRequested: undefined }]) {
    check(hardeningSudoRetryLabel({ ...retryReport, ...patch }) === undefined, 'Root, unknown privileges and already-approved sudo reports cannot offer elevated retry');
}
check(hardeningAccessLabel(retryReport) === 'Standard access', 'Known unelevated user access is disclosed');
check(hardeningAccessLabel({ collectorUid: 1000, elevationRequested: true }) === 'Sudo allowed', 'Authorization does not claim that elevation succeeded');
check(hardeningAccessLabel({ collectorUid: 0, elevationRequested: false }) === 'Root session', 'A root connection is not mislabeled standard access');
check(hardeningAccessLabel({}) === 'Access not recorded', 'Old missing access metadata is not guessed');
check(JSON.stringify(coverageFixtures) === coverageSnapshot, 'Coverage, filters and retry presentation never mutate exports');
check(findingSummary({ ...findings[0], id: 'SSH-pubkeyauthentication', status: 'notAssessed' }) === 'Zync could not collect enough information for this check.', 'Old unavailable summaries do not infer a cause or security rule from an identifier');
check(findingSummary({ ...findings[0], status: 'notAssessed', needsElevatedAccess: true }) === 'Your SSH account was denied access to information for this check.', 'Verified restricted evidence has a short access explanation');
check(findingSummary({ ...findings[0], status: 'notAssessed' }) === 'Zync could not collect enough information for this check.', 'Other unavailable summaries stay generic without guessing a cause');
check(findingSummary({ ...findings[0], status: 'passed', needsElevatedAccess: true }) === 'This check meets the expected condition.', 'A stale access flag cannot override an assessed result');
check(findingSummary({ ...findings[0], status: 'attention' }).includes('requirements'), 'Attention summaries preserve contextual interpretation');
check(findingSummary({ ...findings[0], status: 'informational' }) === 'Information to review. This check has no automatic pass or fail result.', 'Information never suggests a failed security check');
const nativeObservation: Finding = { ...findings[0], status: 'informational', observed: 'Password sign-in is disabled in the default SSH configuration.', expected: 'Compare this default with the host’s needs.', rationale: 'Context matters.', scope: 'Default configuration; Match policy not verified.', ruleVersion: '1', reviewedAt: '2026-10-25' };
check(findingSummary(nativeObservation) === nativeObservation.observed, 'Concise native observations replace generic state prose without parsing evidence');
check(findingSummary({ ...nativeObservation, id: 'CUSTOM-id' }) === nativeObservation.observed, 'Presentation has no identifier-based security interpretation');
const notApplicable: Finding = { ...nativeObservation, status: 'notApplicable', observed: 'Not applicable to this host.', applicabilityReason: 'The detected platform does not use this package profile.', needsElevatedAccess: true, sudoRetryEligible: true };
check(findingStatusLabel(notApplicable) === 'Not applicable' && findingSudoRetryLabel(notApplicable) === undefined, 'Inapplicability cannot become an access denial or suggest sudo even with stale flags');
check(JSON.stringify(hardeningCoverage([notApplicable])) === JSON.stringify({ evaluated: 0, elevated: 0, unavailable: 0, notApplicable: 1, passed: 0, attention: 0, informational: 0 }), 'Inapplicability is excluded from evaluated and unavailable totals');
check(filterFindings([notApplicable, ...coverageFixtures], '', 'notApplicable').length === 1, 'Not-applicable checks have their own filter');
check(filterFindings([notApplicable], '', 'evidenceUnavailable').length === 0 && filterFindings([notApplicable], '', 'needsElevatedAccess').length === 0, 'Unavailable filters never absorb not-applicable checks');
check(hardeningSudoRetryLabel({ ...retryReport, findings: [notApplicable] }) === undefined, 'A report with only not-applicable checks cannot suggest elevation');
for (const query of ['password sign-in', 'match policy', 'context matters']) check(filterFindings([nativeObservation], query).length === 1, 'Search covers native observations, scope and rationale');
check(filterFindings([notApplicable], 'package profile').length === 1, 'Search covers the native applicability reason');
check(filterFindings(findings, 'fixture').map(item => item.status).join(',') === 'attention,notAssessed,informational,passed', 'Attention sorts first, then unavailable evidence, information and passes');
check(findings[0].status === 'passed', 'Filtering does not mutate the retained report');
check(filterFindings(findings, 'CHECK-2', 'notAssessed').length === 1, 'Search and status compose');
check(filterFindings([{ ...findings[0], status: 'passed' }], '', 'attention').length === 0, 'Status filtering excludes other result types');
check(filterFindings([{ ...findings[0], category: 'Network' }, { ...findings[1], category: 'Accounts' }], '', 'all', 'Network').length === 1, 'Category filtering separates independent check families');
check(filterFindings([{ ...findings[0], moduleId: 'host' }, { ...findings[1], moduleId: 'docker' }], '', 'all', 'all', 'docker').length === 1, 'Module filters compose independently of categories and never parse titles');
check(filterFindings(findings, 'host policy').length === 4, 'Search includes recommendation text as advertised');
check(filterFindings([{ ...findings[1], scope: 'Complete technical context', scopeSummary: 'Current process setting only' }], 'process setting').length === 1, 'Search finds the concise scope displayed in the report');
check(filterFindings([{ ...findings[1], scope: 'Complete technical context', scopeSummary: 'Current process setting only' }], 'technical context').length === 1, 'Full recorded scope remains searchable alongside its concise summary');
check(SPLIT_FEATURE_IDS.includes('security') && builtinWorkspaceViewLabel('security') === 'Security hardening audit', 'Audit naming retains the stable workspace feature identity');
check(buildWorkspaceOpenItems({ shells: [], canOpenFeature: true }).some(item => item.featureId === 'security'), 'Workspace Open discovers Security');
const catalog = parseAssessmentCatalog({ version: '1', modules: scopeCatalog,
    presets: [{ id: 'general', label: 'General server', description: 'Host scope', moduleIds: ['host'], revision: '1' }], defaultPresetId: 'general' });
check(catalog.presets[0].moduleIds[0] === 'host', 'Native preset scope loads without a renderer module map');
for (const invalid of [{ ...catalog, defaultPresetId: 'missing' }, { ...catalog, presets: [{ ...catalog.presets[0], moduleIds: ['arbitrary-command'] }] }, { ...catalog, version: '2' }]) {
    let failed = false; try { parseAssessmentCatalog(invalid); } catch { failed = true; } check(failed, 'Malformed preset catalogs cannot authorize invented scope');
}
const runtimeAuth = { kind: 'postgresql' as const, defaultPort: 5432, usernameRequired: true, secretRequired: false, secretLabel: 'Password', maxSecretBytes: 4096 };
check(!credentialError({ kind: 'postgresql', port: 5432, username: 'observer', database: 'postgres', secret: '' }, runtimeAuth), 'An explicitly configured trust observer can omit a password where native metadata permits it');
check(Boolean(credentialError({ kind: 'postgresql', port: 0, username: 'observer', database: '', secret: '' }, runtimeAuth)), 'Local service ports remain bounded');
check(Boolean(credentialError({ kind: 'postgresql', port: 5432, username: 'observer', database: 'postgres', secret: '' }, { ...runtimeAuth, secretRequired: true })), 'Required secrets come from native metadata');
check(Boolean(credentialError({ kind: 'postgresql', port: 5432, username: 'observer', database: 'postgres', secret: 'é'.repeat(40) }, { ...runtimeAuth, maxSecretBytes: 79 })), 'Credential limits count UTF-8 bytes rather than characters');
check(Boolean(credentialError({ kind: 'postgresql', port: 5432, username: 'é'.repeat(65), database: 'postgres', secret: '' }, runtimeAuth)), 'Application usernames follow the native 128-byte limit');
check(Boolean(credentialError({ kind: 'postgresql', port: 5432, username: 'observer', database: 'é'.repeat(65), secret: '' }, runtimeAuth)), 'Database names follow the native 128-byte limit');
check(Boolean(credentialError({ kind: 'postgresql', port: 5432, username: 'observer', database: '', secret: '' }, runtimeAuth)), 'PostgreSQL always names the database actually queried');
check(Boolean(credentialError({ kind: 'postgresql', port: 5432, username: 'ob\u0085server', database: 'postgres', secret: '' }, runtimeAuth)), 'Control characters beyond CR/LF/NUL are rejected before showing Configured');
check(Boolean(credentialError({ kind: 'jenkins', port: 8080, username: 'observer:admin', database: '', secret: 'token' })), 'Jenkins Basic-auth usernames cannot contain a colon');
check(Boolean(credentialError({ kind: 'mysql', port: 3306, username: 'observer', database: '', secret: 'x'.repeat(80) })), 'MySQL client credential limits also apply before native admission');
const runtimeAdmission = deferred<AssessmentAdmission>();
const mutableCredential: RuntimeCredential = { kind: 'postgresql', port: 5432, username: 'observer', database: 'postgres', secret: 'one-shot-private-fixture' };
let sentCredential = '';
const runtimeSnapshots: string[] = [];
const runtimeController = new AssessmentController(subject, { ...port, begin: () => runtimeAdmission.promise,
    run: async (_id, capturedRequest, credentials) => {
        check(capturedRequest.presetId === 'general', 'The approved native policy preset is captured');
        sentCredential = credentials?.[0].secret ?? '';
        return { ...report, modules: [scopeCatalog[0]], policy: { id: 'general', label: 'General server', revision: '1' } };
    } });
runtimeController.subscribe(() => runtimeSnapshots.push(JSON.stringify(runtimeController.snapshot())));
const runtimeRun = runtimeController.start({ kind: 'hardening', modules: ['host'], presetId: 'general' }, [mutableCredential]);
mutableCredential.secret = 'changed-after-admission';
runtimeAdmission.resolve({ id: 'runtime', identity }); await runtimeRun;
check(sentCredential === 'one-shot-private-fixture', 'Credential properties are captured before admission awaits');
check(runtimeSnapshots.every(value => !value.includes('private-fixture') && !value.includes('changed-after-admission')), 'Secrets never enter published controller state or result snapshots');
const wrongPolicy = new AssessmentController(subject, { ...port, begin: async () => ({ id: 'wrong-policy', identity }), run: async () => ({ ...report, policy: { id: 'router', label: 'Router', revision: '1' } }) });
await wrongPolicy.start({ kind: 'hardening', presetId: 'general' });
check(wrongPolicy.snapshot().status === 'failed', 'A completed response cannot silently change the approved policy');

const reviewFinding: Finding = { id: 'RULE', moduleId: 'host', targetKey: 'local:rule', ruleVersion: '1', evidenceKey: 'evidence-a', status: 'attention', title: 'Rule', target: '/fixture', evidence: 'value=a', recommendation: 'Review', reference: '' };
/** Reports are synthetic identity-bound data, never observations collected from this machine. */
function reviewResult(finding: Finding): AssessmentResult {
    return { subject: { ...subject }, startedAt: 1, completedAt: 2, report: { ...report, findings: [finding], modules: [scopeCatalog[0]],
        transportFingerprint: 'sha256:fixture', policy: { id: 'general', label: 'General server', revision: '1' } } };
}
const baseline = reviewResult({ ...reviewFinding });
const unchanged = reviewResult({ ...reviewFinding });
check(compareAssessments(unchanged, baseline)[0].state === 'unchanged', 'Identical native evidence and policy remain unchanged');
check(compareAssessments(reviewResult({ ...reviewFinding, evidenceKey: 'complete-sample-changed' }), baseline)[0].state === 'changed', 'A changed complete-evidence identity is visible even when displayed summaries match');
check(compareAssessments(reviewResult({ ...reviewFinding, status: 'passed', evidenceKey: 'evidence-b' }), baseline)[0].state === 'resolved', 'Only a comparable attention-to-passed result is resolved');
const olderPassed = reviewResult({ ...reviewFinding, status: 'passed', evidenceKey: 'evidence-b' });
for (const newer of [{ ...baseline, startedAt: 3, completedAt: 4 }, { ...baseline, completedAt: 3 }]) {
    check(Boolean(comparisonIssue(olderPassed, newer)), 'A later imported report cannot become an earlier baseline');
    check(compareAssessments(olderPassed, newer).every(row => row.state === 'notCompared'), 'An older pass never resolves attention recorded by a later scan');
}
for (const finding of [{ ...reviewFinding, status: 'notApplicable' as const }, { ...reviewFinding, ruleVersion: '2' }]) {
    check(compareAssessments(reviewResult(finding), baseline)[0].state === 'notCompared', 'Unavailable, excluded or revised checks are never reported resolved');
}
const restricted = reviewResult({ ...reviewFinding, status: 'notAssessed', needsElevatedAccess: true, evidenceKey: 'restricted' });
for (const status of ['passed', 'attention', 'informational'] as const) {
    const evaluated = reviewResult({ ...reviewFinding, status });
    check(compareAssessments(evaluated, restricted)[0].state === 'nowAssessed', 'Newly readable evidence is coverage gained, including passes and attention findings');
    check(compareAssessments(restricted, evaluated)[0].state === 'noLongerAssessed', 'Losing readable evidence is visible and never counts as a resolved finding');
}
check(compareAssessments(restricted, restricted)[0].state === 'notCompared', 'Two unavailable checks do not imply a comparable security result');
for (const finding of [
    { ...reviewFinding, status: 'notAssessed' as const, needsElevatedAccess: false },
    { ...reviewFinding, status: 'notAssessed' as const, sudoRetryEligible: true },
]) check(compareAssessments(unchanged, reviewResult(finding))[0].state === 'nowAssessed', 'Coverage differences do not assume that sudo caused an earlier collection failure');
for (const finding of [
    { ...reviewFinding, ruleVersion: '2' }, { ...reviewFinding, evidenceKey: undefined }, { ...reviewFinding, targetKey: undefined },
]) check(compareAssessments(reviewResult(finding), restricted).every(row => row.state !== 'nowAssessed'), 'Coverage comparisons retain target, rule and evidence identity guards');
const incompatibleCoverage = { ...restricted, report: { ...restricted.report, transportFingerprint: 'sha256:other' } };
check(compareAssessments(unchanged, incompatibleCoverage).every(row => row.state === 'notCompared'), 'A different verified host cannot manufacture a coverage gain');
const unselectedCoverage = { ...restricted, report: { ...restricted.report, modules: [] } };
check(compareAssessments(unchanged, unselectedCoverage).every(row => row.state === 'notCompared'), 'Coverage gains require the module to have been selected in both runs');
check(compareAssessments(unchanged, reviewResult({ ...reviewFinding, status: 'notApplicable' }))[0].state === 'notCompared', 'An inapplicable check cannot be relabeled as newly assessed evidence');
const newTarget = compareAssessments(reviewResult({ ...reviewFinding, targetKey: 'recreated:workload', status: 'passed' }), baseline);
check(!newTarget.some(row => row.state === 'resolved') && newTarget.some(row => !row.current && row.state === 'notCompared'), 'A recreated target cannot resolve the disappeared workload');
const missingScope = reviewResult({ ...reviewFinding, status: 'passed' }); missingScope.report.modules = [];
check(compareAssessments(missingScope, baseline)[0].state === 'notCompared', 'Unselected module scope cannot manufacture resolution');
for (const changed of [
    { ...baseline, subject: { ...subject, host: 'other.invalid' } },
    { ...baseline, report: { ...baseline.report, transportFingerprint: 'sha256:other' } },
    { ...baseline, report: { ...baseline.report, policy: { id: 'general', label: 'General server', revision: '2' } } },
    { ...baseline, report: { ...baseline.report, transportFingerprint: undefined } },
]) check(Boolean(comparisonIssue(unchanged, changed)), 'Comparisons require matching verified host, account and policy revision');
const now = 1_000_000;
const annotation = createRiskException(unchanged, reviewFinding, '  Temporary workload requirement  ', now + 30 * 86400000, now, 'annotation-id');
check(annotation?.reason === 'Temporary workload requirement', 'Acceptance requires a bounded explained reason');
if (!annotation) throw new Error('Acceptance fixture missing');
const savedRisk: SavedRisk = { id: 'risk-fixture', revision: 2, title: reviewFinding.title, target: reviewFinding.target, annotation };
const renewed = { ...annotation, id: 'renewed-id', createdAt: now + 1000, expiresAt: annotation.expiresAt + 1000 };
check(reportRiskAnnotations(unchanged, [annotation, renewed])[0] === renewed, 'Current reports choose the newest matching acceptance');
const expiredRenewal = { ...renewed, expiresAt: now + 1500 };
check(matchingRiskException(unchanged, reviewFinding, reportRiskAnnotations(unchanged, [annotation, expiredRenewal]), now + 2000) === undefined, 'An expired renewal cannot revive an older acceptance');
check(reportRiskAnnotations(unchanged, [{ ...annotation, host: 'foreign.invalid' }]).length === 0, 'Registry notes cannot cross host identity');
check(reportRiskAnnotations(reviewResult({ ...reviewFinding, evidenceKey: 'changed-evidence' }), [annotation]).length === 0, 'Evidence changes do not inherit accepted risk');
check(acceptanceRevisions([savedRisk], [renewed])[0].revision === 2, 'Renewal captures the exact existing registry revision');
check(reportRiskRemovals([savedRisk], [annotation]).length === 1 && reportRiskRemovals([savedRisk], [renewed]).length === 0, 'Deleting an old report never selects a separately renewed acceptance');
for (const reason of ['\u001b', '\u202e', ' \u001b\u202e ']) {
    check(!createRiskException(unchanged, reviewFinding, reason, now + 1, now, 'invisible'), 'A reason erased by native text normalization cannot create an accepted risk');
}
if (!annotation) throw new Error('Missing annotation fixture');
check(matchingRiskException(unchanged, reviewFinding, [annotation], now)?.id === annotation.id, 'Matching active accepted risks annotate the exact result');
check(!matchingRiskException(unchanged, { ...reviewFinding, evidenceKey: 'new-evidence' }, [annotation], now), 'Changed evidence invalidates acceptance');
check(!matchingRiskException(unchanged, reviewFinding, [annotation], annotation.expiresAt), 'Acceptance expires without changing evidence');
check(!matchingRiskException(unchanged, { ...reviewFinding, status: 'passed' }, [annotation], now), 'An annotation never changes a pass or unavailable status');
check(!createRiskException(unchanged, reviewFinding, '', now + 1, now, 'empty') && !createRiskException(unchanged, reviewFinding, 'reason', now + 91 * 86400000, now, 'long'), 'Acceptance requires a reason and at most90days');
check(mergeRiskExceptions([annotation], [{ ...annotation, reason: 'Updated' }]).length === 1, 'Repeated imported annotation IDs replace rather than accumulate');
check(mergeRiskExceptions([], Array.from({ length: 1200 }, (_, index) => ({ ...annotation, id: String(index) }))).length === 1000, 'Annotation retention stays bounded while covering a complete report');
check(unchanged.report.findings[0].status === 'attention' && hardeningCoverage(unchanged.report.findings).attention === 1, 'Comparisons and accepted risks never mutate native status or coverage');
console.log('Security ownership, consent, scoped credentials, comparison, expiry, coverage and filtering regressions passed.');
const savedSummary: SavedReportSummary = { id: 'saved-fixture', name: 'Prior report', revision: 1, createdAt: 1, updatedAt: 2, completedAt: 2,
    host: unchanged.subject.host, username: unchanged.subject.username, port: unchanged.subject.port, fingerprint: unchanged.report.transportFingerprint,
    baseline: unchanged.report.version, findings: 1, attention: 1, bytes: 200 };
check(reportBelongsToHost({ ...unchanged, subject: { ...unchanged.subject, connectionId: 'restored' } }, subject), 'A restored connection ID can open history for the same endpoint/account');
check(!reportBelongsToHost({ ...unchanged, subject: { ...unchanged.subject, host: 'other.invalid' } }, subject), 'An imported report for another host cannot become this pane’s preview');
check(replacementReports(unchanged, [savedSummary, { ...savedSummary, id: 'changed-key', fingerprint: 'other-key' }, { ...savedSummary, id: 'other-account', username: 'other' }]).length === 1, 'Replacement choices require the same verified endpoint and account');
check(replacementReports({ ...unchanged, report: { ...unchanged.report, transportFingerprint: undefined } }, [{ ...savedSummary, fingerprint: null }]).length === 1, 'Legacy reports consistently treat an absent recorded key and native null as unqualified identity');
const archive = JSON.parse(reportPayload(unchanged, [annotation]));
check(archive.version === 3 && archive.annotations[0].expiresAt === annotation.expiresAt && archive.report.findings[0].status === 'attention', 'Saved report payloads retain evidence, reason and expiry without rewriting native status');
check(!('request' in archive) && !('credentials' in archive), 'Portable report packages contain no assessment access inputs');
export {};
