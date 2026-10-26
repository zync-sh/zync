import { useRef } from 'react';
import { ChevronRight, KeyRound, Play, Square } from 'lucide-react';
import { HostConnectionNotice } from '../../../components/connections/HostConnectionNotice';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Switch } from '../../../components/ui/Switch';
import { cn } from '../../../lib/utils';
import { selectedModules as projectModules, type ModuleDefinition, type RuntimeCredentialKind, type ScopePreset } from '../domain/modules';
import { ModuleSelector } from './ModuleSelector';
import { useConnectionFocus } from '../../connections/presentation/useConnectionFocus';

interface HardeningSetupProps {
    connectionId: string;
    visible?: boolean; focused?: boolean;
    connected: boolean; local: boolean; compact: boolean; busy: boolean; stopping: boolean;
    elevationConsent: boolean; modules: readonly ModuleDefinition[]; selectedModules: readonly string[];
    presets: readonly ScopePreset[]; presetId: string; scopeStatus: 'loading' | 'ready' | 'failed';
    configuredKinds: ReadonlySet<RuntimeCredentialKind>;
    onModulesChange(ids: readonly string[]): void; onPresetChange(id: string): void; onScopeRetry(): void;
    onConfigure(module: ModuleDefinition): void; onElevationChange(value: boolean): void; onRun(): void; onCancel(): void;
}

/** Supporting qualifications stay available without repeating an assessment manual in the setup. */
function ScopeDetails() {
    return <details data-assessment-setup-scope className="group/setup-scope text-xs">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded py-1 text-app-muted hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-control-focus [&::-webkit-details-marker]:hidden">
            Run details<ChevronRight size={12} aria-hidden="true" className="transition-transform group-open/setup-scope:rotate-90 motion-reduce:transition-none" />
        </summary>
        <div className="mt-2 space-y-2 border-t border-app-border pt-3 leading-relaxed text-app-muted">
            <p>Runs only after approval, over this Linux SSH connection. Requires GNU coreutils timeout and the tools used by your chosen areas.</p>
            <p>No agent, automatic fixes or report upload. Coverage is limited to the checked settings; unavailable information stays unevaluated.</p>
            <p>Sudo and application credentials are optional per-run access. Secrets stay in memory, never saved, synced or logged. Server policy may still restrict access.</p>
        </div>
    </details>;
}

/** Offline hosts show one recovery action; live hosts expose the retained assessment choices. */
export function HardeningSetup({ connectionId, connected, local, visible = true, focused = true, compact, busy, stopping, elevationConsent, modules, selectedModules, presets, presetId,
    scopeStatus, configuredKinds, onModulesChange, onPresetChange, onScopeRetry, onConfigure, onElevationChange, onRun, onCancel }: HardeningSetupProps) {
    const heading = useRef<HTMLHeadingElement>(null);
    const beginConnectionFocus = useConnectionFocus(connected, heading, connectionId, visible && focused);
    if (!connected && !local) return <section aria-label="Assessment setup" className="my-5">
        <HostConnectionNotice connectionId={connectionId} description="Connect this host to run an assessment." onConnectStart={beginConnectionFocus} />
    </section>;

    const selected = projectModules(modules, selectedModules);
    const accessModules = selected.filter(module => module.auth);
    return <section aria-label="Assessment setup" className={cn('@container my-5 rounded-xl border border-app-border bg-app-panel', compact ? 'p-4' : 'p-5 sm:p-6')}>
        <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0"><h2 ref={heading} tabIndex={-1} className="text-sm font-semibold outline-none">{local ? 'Choose an SSH host' : 'Host hardening'}</h2>
                <p className="mt-1 text-xs text-app-muted">{local ? 'Available for Linux SSH hosts.' : 'Reads settings. Makes no changes.'}</p></div>
            {busy ? <Button variant="secondary" size="sm" onClick={onCancel} disabled={stopping}>
                <Square size={12} className="mr-2" aria-hidden="true" />{stopping ? 'Stopping…' : 'Cancel assessment'}</Button>
                : <Button size="sm" disabled={!connected || scopeStatus !== 'ready' || selectedModules.length === 0} onClick={onRun}>
                    <Play size={13} className="mr-2" aria-hidden="true" />Run assessment</Button>}
        </div>
        {!local ? scopeStatus === 'loading' ? <p role="status" className="mt-5 text-xs text-app-muted">Loading check choices…</p>
            : scopeStatus === 'failed' ? <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-app-border px-3 py-2">
                <p className="text-xs text-app-muted">Could not load check choices.</p><Button variant="ghost" size="sm" onClick={onScopeRetry}>Retry loading choices</Button></div>
                : <>
                    <div className="mt-4 grid items-end gap-3 @min-[520px]:grid-cols-[minmax(150px,0.7fr)_minmax(0,1.3fr)]">
                        <Select label="Preset" value={presetId} disabled={busy} onChange={onPresetChange} options={presets.map(preset => ({ value: preset.id, label: preset.label }))} />
                        <ModuleSelector modules={modules} selected={selectedModules} disabled={busy} onChange={onModulesChange} />
                    </div>
                    {accessModules.length > 0 && <div className="mt-3 flex flex-wrap gap-2" aria-label="Application access">
                        {accessModules.map(module => <Button key={module.id} size="sm" variant="secondary" disabled={busy || !connected} onClick={() => onConfigure(module)}>
                            <KeyRound size={12} className="mr-2 shrink-0" aria-hidden="true" />{module.label}: {configuredKinds.has(module.auth!.kind) ? 'Configured' : 'Add access'}</Button>)}
                    </div>}
                </> : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-app-border pt-3">
            {connected && <Switch label="Use sudo" checked={elevationConsent} onCheckedChange={onElevationChange} disabled={busy} showLabel className="w-auto gap-4 p-0" />}
            <ScopeDetails />
        </div>
    </section>;
}
