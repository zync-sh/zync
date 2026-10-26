import type { AssessmentResult, AssessmentState } from '../src/features/security/domain/assessment';

type ElementNode = { type: unknown; props: Record<string, unknown> };
type SourceLoader = (path: string, dependencies?: Record<string, unknown>, globals?: Record<string, unknown>) => Record<string, unknown>;

/** Exercise the real panel's retry projection and approval callbacks while substituting only its React/service boundaries. */
export function runSecurityPanelRetryChecks(loadSource: SourceLoader): void {
    const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
    const assessment = loadSource('features/security/domain/assessment.ts');
    const modules = loadSource('features/security/domain/modules.ts');
    const eligible: AssessmentResult = {
        subject: { connectionId: 'fixture', name: 'Fixture', host: 'fixture.invalid', username: 'fixture', port: 22 },
        report: { kind: 'hardening', target: 'Fixture host', os: 'ubuntu', version: 'fixture', totalFindings: 1, truncated: false, notes: [],
            collectorUid: 1000, elevationRequested: false, findings: [{ id: 'protected-check', status: 'notAssessed', title: 'Protected check',
                target: '/fixture', evidence: 'Access denied', recommendation: 'Retry with approved access', reference: '', needsElevatedAccess: true }] },
        startedAt: 1, completedAt: 2,
    };
    /** Find the production child boundary without executing its independent report/dialog implementation. */
    function find(node: unknown, type: string): ElementNode | undefined {
        if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean);
        if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
        const element = node as ElementNode;
        return element.type === type ? element : find(element.props.children, type);
    }
    function fixture(initial: AssessmentState) {
        let currentState = initial;
        let connectionStatus = 'connected';
        let stateCursor = 0; let memoCursor = 0; let effectCursor = 0;
        const states: unknown[] = [];
        const memos: Array<{ dependencies: readonly unknown[]; value: unknown }> = [];
        const effectDependencies: Array<readonly unknown[]> = [];
        let effects: Array<() => void> = [];
        const starts: unknown[] = [];
        const controller = { start: (request: unknown) => { starts.push(request); return Promise.resolve(); }, cancel: () => {}, authenticate: () => {} };
        const sameDependencies = (left: readonly unknown[] | undefined, right: readonly unknown[]) => Boolean(left && left.length === right.length && left.every((item, index) => Object.is(item, right[index])));
        const react = {
            useState: (initialValue: unknown) => {
                const index = stateCursor++;
                if (!(index in states)) states[index] = initialValue;
                return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
            },
            useMemo: (factory: () => unknown, dependencies: readonly unknown[]) => {
                const index = memoCursor++;
                if (!sameDependencies(memos[index]?.dependencies, dependencies)) memos[index] = { dependencies, value: factory() };
                return memos[index].value;
            },
            useEffect: (effect: () => void, dependencies: readonly unknown[]) => {
                const index = effectCursor++;
                if (!sameDependencies(effectDependencies[index], dependencies)) { effectDependencies[index] = dependencies; effects.push(effect); }
            },
        };
        const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
        const { SecurityPanel } = loadSource('features/security/ui/SecurityPanel.tsx', {
            react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
            'lucide-react': { AlertCircle: 'AlertCircle', Loader2: 'Loader2' },
            '../../../components/icons/HardeningAuditIcon': { HardeningAuditIcon: 'AuditIcon' },
            '../../../store/useAppStore': { useAppStore: (select: (store: unknown) => unknown) => select({ connections: [
                { ...eligible.subject, id: 'fixture', status: connectionStatus, lastConnected: 1 },
                { ...eligible.subject, id: 'other', status: connectionStatus, lastConnected: 1 },
            ] }) },
            '../../workspace/domain/registrations': { builtinWorkspaceViewLabel: () => 'Security hardening audit' },
            '../application/useAssessment': { useAssessment: () => ({ state: currentState, controller }) },
            '../application/useAssessmentModules': { useAssessmentModules: () => ({ modules: [], selected: [], presets: [], presetId: 'general', status: 'ready' }) },
            '../domain/assessment': assessment, '../domain/modules': modules,
            './AssessmentPasswordDialog': { AssessmentPasswordDialog: 'PasswordDialog' },
            './HardeningSetup': { HardeningSetup: 'Setup' }, './AssessmentReports': { AssessmentReports: 'Reports' },
            './AssessmentApprovalDialog': { AssessmentApprovalDialog: 'Approval' }, './RuntimeCredentialDialog': { RuntimeCredentialDialog: 'Credentials' },
        }) as { SecurityPanel: (props: { connectionId: string }) => ElementNode };
        const render = (state = currentState, status = connectionStatus, connectionId = 'fixture') => {
            currentState = state; connectionStatus = status;
            stateCursor = memoCursor = effectCursor = 0; effects = [];
            const tree = SecurityPanel({ connectionId });
            effects.forEach(effect => effect());
            return { tree, reports: find(tree, 'Reports')!, approval: find(tree, 'Approval') };
        };
        return { render, starts };
    }

    const h = fixture({ status: 'completed', result: eligible });
    let rendered = h.render();
    check(typeof rendered.reports.props.onRetryWithSudo === 'function', 'An eligible completed result exposes retry approval');
    (rendered.reports.props.onRetryWithSudo as (label: string) => void)('Retry with sudo');
    rendered = h.render();
    check(rendered.approval?.props.disabled === false && h.starts.length === 0, 'Retry opens approval without starting a scan');
    for (const status of ['running', 'stopping'] as const) {
        rendered = h.render({ status, kind: 'hardening', startedAt: 3 });
        check(rendered.reports.props.liveResult === eligible, `${status} retains the previous report for review`);
        check(rendered.reports.props.onRetryWithSudo === undefined, `${status} never exposes a retry handler for the retained report`);
        check(rendered.approval?.props.disabled === true, `${status} disables an already-open retry approval`);
        (rendered.approval!.props.onConfirm as () => void)();
        check(h.starts.length === 0, `${status} also rejects a direct stale approval callback`);
    }
    rendered = h.render({ status: 'idle' });
    check(typeof rendered.reports.props.onRetryWithSudo === 'function' && rendered.approval?.props.disabled === false, 'Idle state restores eligible retry after the active run has stopped');
    (rendered.approval!.props.onConfirm as () => void)();
    check(h.starts.length === 1 && (h.starts[0] as { elevationConsent: boolean }).elevationConsent === true, 'Idle retry still requires approval and preserves elevation consent');
    check(h.render({ status: 'idle' }, 'disconnected').reports.props.onRetryWithSudo === undefined, 'A disconnected host cannot retry retained evidence');
    check(h.render({ status: 'idle' }, 'connected', 'other').reports.props.onRetryWithSudo === undefined, 'A different host cannot reuse the retained report');
    check(fixture({ status: 'idle' }).render().reports.props.onRetryWithSudo === undefined, 'No completed result means no retry');
    for (const report of [{ ...eligible.report, collectorUid: 0 }, { ...eligible.report, elevationRequested: true }, { ...eligible.report, findings: [] }]) {
        check(fixture({ status: 'completed', result: { ...eligible, report } }).render().reports.props.onRetryWithSudo === undefined, 'Existing report eligibility checks still prevent retry');
    }
}
