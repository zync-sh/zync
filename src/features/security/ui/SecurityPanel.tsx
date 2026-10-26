import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { HardeningAuditIcon } from '../../../components/icons/HardeningAuditIcon';
import { useAppStore } from '../../../store/useAppStore';
import { builtinWorkspaceViewLabel } from '../../workspace/domain/registrations';

import { useAssessment } from '../application/useAssessment';
import { useAssessmentModules } from '../application/useAssessmentModules';

import { hardeningSudoRetryLabel, type AssessmentRequest, type AssessmentResult, type SudoRetryLabel } from '../domain/assessment';
import { selectedModules, type ModuleDefinition, type RuntimeCredential, type RuntimeCredentialKind } from '../domain/modules';

import { AssessmentPasswordDialog } from './AssessmentPasswordDialog';
import { HardeningSetup } from './HardeningSetup';
import { AssessmentReports } from './AssessmentReports';
import { AssessmentApprovalDialog } from './AssessmentApprovalDialog';
import { RuntimeCredentialDialog } from './RuntimeCredentialDialog';

interface Approval {
    owner: object; request: AssessmentRequest; retryWithSudo: SudoRetryLabel | null; modules: ModuleDefinition[]; presetLabel?: string;
}
type CredentialDrafts = Partial<Record<RuntimeCredentialKind, RuntimeCredential>>;

/** Account-free hardening workspace: compact setup, explicit access and pane-owned evidence review. */
export function SecurityPanel({ connectionId, visible = true, focused = true, setupRequest, onBackToLibrary }: {
    connectionId: string; visible?: boolean; focused?: boolean; setupRequest?: object; onBackToLibrary?(): void;
}) {
    const connection = useAppStore(state => state.connections.find(item => item.id === connectionId));
    const connected = connection?.status === 'connected' && connectionId !== 'local';
    // Local browsing and nonsecret scope belong to the host, independently of live transport epochs.
    const subject = useMemo(() => ({
        connectionId, name: connection?.name ?? 'Local workspace',
        host: connection?.host ?? '', username: connection?.username ?? '', port: connection?.port ?? 22,
    }), [connectionId, connection?.name, connection?.host, connection?.username, connection?.port]);
    const { state, controller } = useAssessment(subject, connected, connection?.lastConnected);
    const scope = useAssessmentModules(subject);
    const [retained, setRetained] = useState<{ owner: object; result: AssessmentResult } | null>(null);
    useEffect(() => {
        setRetained(previous => state.status === 'completed' ? { owner: subject, result: state.result } : previous?.owner === subject ? previous : null);
    }, [subject, state]);
    const chosenModules = useMemo(() => selectedModules(scope.modules, scope.selected), [scope.modules, scope.selected]);
    const [elevationConsent, setElevationConsent] = useState(false);
    const [confirmation, setConfirmation] = useState<Approval | null>(null);
    const [credentialState, setCredentialState] = useState<{ owner: object; values: CredentialDrafts }>({ owner: controller, values: {} });
    const [configuring, setConfiguring] = useState<{ owner: object; module: ModuleDefinition } | null>(null);
    const credentials = credentialState.owner === controller ? credentialState.values : {};
    const configuredKinds = useMemo(() => new Set(Object.values(credentials).filter((item): item is RuntimeCredential => Boolean(item)).map(item => item.kind)), [credentials]);
    const activeConfirmation = confirmation?.owner === controller ? confirmation : null;
    const configuringModule = configuring?.owner === controller ? configuring.module : null;
    const activeModules = activeConfirmation?.modules ?? chosenModules;
    useEffect(() => {
        setConfirmation(null); setElevationConsent(false); setCredentialState({ owner: controller, values: {} }); setConfiguring(null);
    }, [controller]);
    useEffect(() => {
        const allowed = new Set(activeModules.flatMap(module => module.auth ? [module.auth.kind] : []));
        setCredentialState(previous => previous.owner !== controller ? previous : {
            owner: controller, values: Object.fromEntries(Object.entries(previous.values).filter(([kind]) => allowed.has(kind as RuntimeCredentialKind))),
        });
    }, [activeModules, controller]);
    const busy = state.status === 'running' || state.status === 'stopping';
    const host = connection ? connection.username + '@' + connection.host : connectionId === 'local' ? 'Local workspace' : 'SSH host';
    const result = state.status === 'completed' ? state.result : retained?.owner === subject ? retained.result : null;
    const canRetryWithSudo = connected && !busy && result !== null && Boolean(hardeningSudoRetryLabel(result.report));

    /** Closing an approval drops its one-shot secrets while retaining the existing report. */
    const closeApproval = () => { setConfirmation(null); setConfiguring(null); setCredentialState({ owner: controller, values: {} }); };
    /** A retry uses the completed report's exact scope and policy, regardless of the next-run draft. */
    const handleRetryWithSudo = (label: SudoRetryLabel) => {
        if (!canRetryWithSudo || !result) return;
        const modules = result.report.modules;
        setConfirmation({
            owner: controller,
            request: { kind: 'hardening', elevationConsent: true, ...(modules ? { modules: modules.map(module => module.id) } : {}),
                ...(result.report.policy ? { presetId: result.report.policy.id } : {}) },
            retryWithSudo: label,
            modules: modules ? modules.map(module => ({ ...module, auth: scope.modules.find(definition => definition.id === module.id)?.auth })) : [],
            presetLabel: result.report.policy?.label,
        });
    };
    /** The final click captures credentials separately, then immediately removes them from UI state. */
    const confirmRun = () => {
        const captured = activeConfirmation;
        if (!captured || !connected || (captured.retryWithSudo && !canRetryWithSudo)) return;
        const required = captured.modules.flatMap(module => module.auth ? [module.auth.kind] : []);
        if (required.some(kind => !credentials[kind])) return;
        const inputs = required.map(kind => ({ ...credentials[kind]! }));
        closeApproval(); setElevationConsent(false);
        const run = controller.start(captured.request, inputs);
        inputs.forEach(input => { input.secret = ''; });
        void run;
    };
    /** The configure action is local; it neither tests credentials nor admits a scan. */
    const configure = (module: ModuleDefinition) => { if (module.auth && !busy) setConfiguring({ owner: controller, module }); };

    return <div className="h-full min-h-0 overflow-auto bg-app-bg text-app-text">
        <div className="mx-auto max-w-5xl px-4 py-5 sm:px-7 sm:py-7">
            <header className="flex min-w-0 items-center gap-3">
                <HardeningAuditIcon osIcon={connection?.icon} size={28} className="shrink-0 text-app-accent" />
                <div className="min-w-0"><h1 className="text-base font-semibold tracking-tight">{builtinWorkspaceViewLabel('security')}</h1><p className="mt-1 break-all text-xs text-app-muted">{host}</p></div>
            </header>
            <AssessmentReports owner={subject} presets={scope.presets} subject={subject} setupRequest={setupRequest} onBackToLibrary={onBackToLibrary}
                liveResult={result} running={busy} onLeaveSetup={() => { closeApproval(); setElevationConsent(false); }} onRetryWithSudo={canRetryWithSudo ? handleRetryWithSudo : undefined} setup={<>
            <HardeningSetup connectionId={connectionId} connected={connected} local={connectionId === 'local'} visible={visible} focused={focused}
                compact={busy || state.status === 'failed'} busy={busy} stopping={state.status === 'stopping'}
                elevationConsent={elevationConsent} onElevationChange={setElevationConsent}
                onCancel={() => { setCredentialState({ owner: controller, values: {} }); controller.cancel(); }}
                modules={scope.modules} selectedModules={scope.selected} presets={scope.presets} presetId={scope.presetId} scopeStatus={scope.status}
                configuredKinds={configuredKinds} onConfigure={configure} onModulesChange={scope.setSelected} onPresetChange={scope.setPreset} onScopeRetry={scope.retry}
                onRun={() => {
                    if (scope.status !== 'ready' || chosenModules.length === 0) return;
                    setConfirmation({ owner: controller, request: { kind: 'hardening', elevationConsent, modules: chosenModules.map(module => module.id), presetId: scope.presetId },
                        retryWithSudo: null, modules: chosenModules.map(module => ({ ...module })), presetLabel: scope.presets.find(preset => preset.id === scope.presetId)?.label });
                }} />
            {busy && <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border border-app-border bg-app-panel px-4 py-3">
                <Loader2 size={16} className="shrink-0 animate-spin text-app-accent motion-reduce:animate-none" aria-hidden="true" />
                <p className="text-xs">{state.status === 'stopping' ? 'Stopping assessment…' : state.status === 'running' && state.authenticationRequired ? 'Waiting for your sudo password…' : 'Checking the selected settings…'}</p>
            </div>}
            {state.status === 'failed' && <div role="alert" className="flex gap-3 rounded-lg border border-app-danger/30 bg-app-danger/5 p-4">
                <AlertCircle size={17} className="shrink-0 text-app-danger" aria-hidden="true" /><div><p className="text-sm font-medium">Assessment could not finish</p><p className="mt-1 break-words text-xs text-app-muted">{state.message}</p></div>
            </div>}
            {state.status === 'cancelled' && <p role="status" className="py-3 text-xs text-app-muted">Assessment cancelled. Incomplete results were not saved.</p>}
            </>} />
        </div>
        {activeConfirmation && <AssessmentApprovalDialog host={host} preset={activeConfirmation.presetLabel} modules={activeConfirmation.modules}
            elevation={activeConfirmation.request.elevationConsent ?? false} retry={activeConfirmation.retryWithSudo} configuredKinds={configuredKinds}
            disabled={!connected || Boolean(activeConfirmation.retryWithSudo && !canRetryWithSudo)} onConfigure={configure} onClose={closeApproval} onConfirm={confirmRun} />}
        {configuringModule?.auth && <RuntimeCredentialDialog key={configuringModule.id} module={configuringModule} previous={credentials[configuringModule.auth.kind]}
            onClose={() => {
                const kind = configuringModule.auth!.kind;
                setCredentialState(previous => ({ owner: controller, values: Object.fromEntries(Object.entries(previous.owner === controller ? previous.values : {}).filter(([key]) => key !== kind)) }));
                setConfiguring(null);
            }}
            onSave={credential => { setCredentialState(previous => ({ owner: controller, values: { ...(previous.owner === controller ? previous.values : {}), [credential.kind]: credential } })); setConfiguring(null); }} />}
        {state.status === 'running' && state.authenticationRequired && <AssessmentPasswordDialog key={state.startedAt} host={host} submit={password => void controller.authenticate(password)} cancel={controller.cancel} />}
    </div>;
}
