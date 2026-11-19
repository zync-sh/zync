import { AlertCircle, Monitor, RefreshCw } from 'lucide-react';

import { ConnectionStateCard } from '../../../components/connections/ConnectionStateCard';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { cn } from '../../../lib/utils';

interface VncDisconnectedViewProps {
    profileName?: string;
    networkNotice?: string;
    endpoint: string;
    port: string;
    onPortChange: (port: string) => void;
    busy: boolean;
    canConnect: boolean;
    status: string;
    error: string;
    manualRetry: boolean;
    onConnect: () => void;
    onCancel: () => void;
}

/** Present connection and recovery actions without taking ownership of the VNC session. */
export function VncDisconnectedView({
    profileName,
    networkNotice,
    endpoint,
    port,
    onPortChange,
    busy,
    canConnect,
    status,
    error,
    manualRetry,
    onConnect,
    onCancel,
}: VncDisconnectedViewProps) {
    const Icon = busy ? RefreshCw : error ? AlertCircle : Monitor;
    const title = busy ? status : error ? "Couldn't connect" : 'Connect to VNC';

    return (
        <ConnectionStateCard
            title={title}
            tone={error ? 'error' : 'neutral'}
            badge={busy ? undefined : error ? 'Error' : status}
            icon={
                <Icon
                    size={20}
                    className={cn(
                        '[@media(max-height:560px)]:h-4 [@media(max-height:560px)]:w-4',
                        busy && 'motion-safe:animate-spin text-app-accent',
                    )}
                />
            }
            identity={
                profileName && (
                    <>
                        <p className="truncate text-sm font-medium text-app-text">{profileName}</p>
                        <p className="mt-0.5 break-all font-mono text-xs text-app-muted">
                            {endpoint}
                        </p>
                    </>
                )
            }
        >
            <div className="mt-3 space-y-3 sm:mt-4 [@media(max-height:560px)]:mt-2.5">
                {networkNotice && (
                    <p className="text-xs leading-relaxed text-app-muted">{networkNotice}</p>
                )}
                {error && (
                    <p
                        role="alert"
                        className="max-h-24 overflow-auto break-words rounded-lg border border-app-danger/25 bg-app-danger/5 px-3 py-2 text-xs leading-relaxed text-control-danger"
                    >
                        {error}
                    </p>
                )}
                {busy ? (
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                ) : (
                    <form
                        className="space-y-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            onConnect();
                        }}
                    >
                        {!profileName && (
                            <div className="w-36 max-w-full">
                                <Input
                                    label="Remote loopback port"
                                    inputMode="numeric"
                                    value={port}
                                    onChange={(event) => onPortChange(event.target.value)}
                                />
                            </div>
                        )}
                        <Button
                            type="submit"
                            disabled={!canConnect}
                            className="min-w-[8.5rem] [@media(max-height:560px)]:h-9 [@media(max-height:560px)]:min-w-[7.5rem]"
                        >
                            {manualRetry ? 'Try password manually' : 'Open VNC'}
                        </Button>
                    </form>
                )}
            </div>
        </ConnectionStateCard>
    );
}
