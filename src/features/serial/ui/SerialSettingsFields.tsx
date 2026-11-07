import { ChevronRight, RefreshCw } from 'lucide-react';
import { useId } from 'react';

import { IconButton } from '../../../components/ui/IconButton';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import type { SerialLineEnding, SerialSettings } from '../domain/serialSettings';
import type { SerialPort } from '../infrastructure/serialSession';

const DATA_BITS = [5, 6, 7, 8].map((value) => ({ value: String(value), label: String(value) }));
const STOP_BITS = [1, 2].map((value) => ({ value: String(value), label: String(value) }));
const PARITY = [
    { value: 'none', label: 'None' },
    { value: 'odd', label: 'Odd' },
    { value: 'even', label: 'Even' },
];
const FLOW_CONTROL = [
    { value: 'none', label: 'None' },
    { value: 'hardware', label: 'RTS/CTS' },
    { value: 'software', label: 'XON/XOFF' },
];
const LINE_ENDINGS = [
    { value: 'cr', label: 'CR' },
    { value: 'lf', label: 'LF' },
    { value: 'crlf', label: 'CRLF' },
];

interface SerialSettingsFieldsProps {
    ports: readonly Pick<SerialPort, 'id' | 'label'>[];
    portId: string;
    onPortChange: (port: string) => void;
    baud: string;
    onBaudChange: (baud: string) => void;
    validBaud: boolean;
    settings: Readonly<SerialSettings>;
    onSettingsChange: (patch: Partial<SerialSettings>) => void;
    ending: SerialLineEnding;
    onEndingChange: (ending: SerialLineEnding) => void;
    busy: boolean;
    scanning: boolean;
    onRefresh: () => void;
    portError?: string;
    baudError?: string;
    endingDisabled?: boolean;
}

/** Share setup fields between the initial card and the retained session's settings dialog. */
export function SerialSettingsFields({
    ports,
    portId,
    onPortChange,
    baud,
    onBaudChange,
    validBaud,
    settings,
    onSettingsChange,
    ending,
    onEndingChange,
    busy,
    scanning,
    onRefresh,
    portError,
    baudError,
    endingDisabled = false,
}: SerialSettingsFieldsProps) {
    const portErrorId = useId();
    return (
        <div className="space-y-4">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                <Select
                    label="Serial port"
                    value={portId}
                    options={ports.map((port) => ({ value: port.id, label: port.label }))}
                    disabled={busy || scanning}
                    placeholder={scanning ? 'Scanning…' : 'No ports found'}
                    onChange={onPortChange}
                    portal
                    ariaDescribedBy={portError ? portErrorId : undefined}
                />
                <IconButton
                    label="Refresh ports"
                    title="Refresh ports"
                    icon={<RefreshCw size={15} />}
                    variant="secondary"
                    className="h-[var(--zync-control-height-md)] w-[var(--zync-control-height-md)]"
                    disabled={busy || scanning}
                    isLoading={scanning}
                    onClick={onRefresh}
                />
            </div>
            {portError && (
                <p
                    id={portErrorId}
                    className="text-xs text-control-danger"
                    role="alert"
                >
                    {portError}
                </p>
            )}
            <Input
                label="Baud rate"
                inputMode="numeric"
                disabled={busy}
                value={baud}
                error={baudError ?? (validBaud ? undefined : 'Enter a positive baud rate.')}
                onChange={(event) => onBaudChange(event.target.value)}
            />
            <details className="group rounded-lg border border-app-border/60 bg-app-surface/20">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-app-muted hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-control-focus [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                        size={14}
                        aria-hidden
                        className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                    />
                    <span className="min-w-0 flex-1">Serial settings</span>
                    <span className="shrink-0 font-mono text-[11px]">
                        {settings.dataBits}
                        {settings.parity[0].toUpperCase()}
                        {settings.stopBits}
                    </span>
                </summary>
                <div className="grid gap-3 border-t border-app-border/50 p-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,8rem),1fr))]">
                    <Select
                        label="Data bits"
                        options={DATA_BITS}
                        value={String(settings.dataBits)}
                        disabled={busy}
                        onChange={(value) =>
                            onSettingsChange({
                                dataBits: Number(value) as SerialSettings['dataBits'],
                            })
                        }
                        showSearch={false}
                        portal
                    />
                    <Select
                        label="Parity"
                        options={PARITY}
                        value={settings.parity}
                        disabled={busy}
                        onChange={(value) =>
                            onSettingsChange({ parity: value as SerialSettings['parity'] })
                        }
                        showSearch={false}
                        portal
                    />
                    <Select
                        label="Stop bits"
                        options={STOP_BITS}
                        value={String(settings.stopBits)}
                        disabled={busy}
                        onChange={(value) =>
                            onSettingsChange({
                                stopBits: Number(value) as SerialSettings['stopBits'],
                            })
                        }
                        showSearch={false}
                        portal
                    />
                    <Select
                        label="Flow control"
                        options={FLOW_CONTROL}
                        value={settings.flowControl}
                        disabled={busy}
                        onChange={(value) =>
                            onSettingsChange({
                                flowControl: value as SerialSettings['flowControl'],
                            })
                        }
                        showSearch={false}
                        portal
                    />
                    <Select
                        label="Enter sends"
                        options={LINE_ENDINGS}
                        value={ending}
                        disabled={endingDisabled}
                        onChange={(value) => onEndingChange(value as SerialLineEnding)}
                        showSearch={false}
                        portal
                    />
                </div>
            </details>
        </div>
    );
}
