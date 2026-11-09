import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getConnectionBackendEpoch } from '../../lib/terminal/connectionBackend';
import { useAppStore } from '../../store/useAppStore';
import {
    createDashboardMetricsSampler,
    DASHBOARD_HISTORY_LIMIT,
    DASHBOARD_SAMPLE_TTL_MS,
    type DashboardHistoryPoint,
    type DashboardSample,
} from './dashboardMetrics';

interface DashboardReading<T extends { sampledAt: number }> {
    connectionId: string;
    epoch: number;
    sample: T;
    updatedAt: number;
}

interface DashboardIssue {
    connectionId: string;
    epoch: number;
    message: string;
    saturated: boolean;
}

const SATURATION_BACKOFF_MS = DASHBOARD_SAMPLE_TTL_MS * 5;
const dashboardMetrics = createDashboardMetricsSampler({
    /** Execute the combined sample through the existing local/SSH command boundary. */
    execute: (connectionId, command) =>
        window.ipcRenderer.invoke('ssh:exec', { connectionId, command }),
    readEpoch: getConnectionBackendEpoch,
});

/** Preserve the existing host icon inference without replacing a user's saved choice. */
function detectOSIcon(osName: string): string {
    const os = osName.toLowerCase();
    if (os.includes('ubuntu')) {
        return 'ubuntu';
    }
    if (os.includes('debian')) {
        return 'debian';
    }
    if (os.includes('centos') || os.includes('red hat') || os.includes('rhel')) {
        return 'redhat';
    }
    if (os.includes('arch')) {
        return 'arch';
    }
    if (os.includes('kali')) {
        return 'kali';
    }
    if (os.includes('fedora') || os.includes('amazon linux')) {
        return 'redhat';
    }
    if (os.includes('suse') || os.includes('opensuse')) {
        return 'linux';
    }
    if (os.includes('windows')) {
        return 'windows';
    }
    if (os.includes('darwin') || os.includes('macos') || os.includes('mac os')) {
        return 'macos';
    }
    if (os.includes('pop') || os.includes('mint')) {
        return 'ubuntu';
    }
    return 'linux';
}

/** Retain actual successful readings only; unavailable samples never invent chart points. */
function appendHistory(
    history: readonly DashboardHistoryPoint[],
    value: number | null,
    sampledAt: number,
): DashboardHistoryPoint[] {
    return value !== null && Number.isFinite(value)
        ? [...history.slice(-(DASHBOARD_HISTORY_LIMIT - 1)), { sampledAt, value }]
        : [...history];
}

interface DashboardPollingOptions<T extends { sampledAt: number }> {
    connectionId: string | null | undefined;
    isConnected: boolean;
    isVisible: boolean;
    intervalMs: number;
    sample: (connectionId: string, windows: boolean) => Promise<T>;
    disconnectOnMissing?: boolean;
}

/** Share lifecycle rules across independently paced, cached summary and detail collectors. */
export function useDashboardPolling<T extends { sampledAt: number }>({
    connectionId: activeConnectionId,
    isConnected,
    isVisible,
    intervalMs,
    sample,
    disconnectOnMissing = false,
}: DashboardPollingOptions<T>) {
    const isLocal = activeConnectionId === 'local';
    const epoch = isLocal
        ? 0
        : activeConnectionId
          ? getConnectionBackendEpoch(activeConnectionId)
          : undefined;
    const [reading, setReading] = useState<DashboardReading<T> | null>(null);
    const [issue, setIssue] = useState<DashboardIssue | null>(null);
    const [expiredReadingAt, setExpiredReadingAt] = useState<number | null>(null);
    const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
    const isFetching = useRef<{
        connectionId: string;
        epoch: number;
        isPolling: () => boolean;
    } | null>(null);
    const currentTarget = useRef({
        id: activeConnectionId,
        visible: isVisible,
        connected: isConnected,
    });

    // Async completions consult committed ownership rather than a speculative render.
    useLayoutEffect(() => {
        currentTarget.current = {
            id: activeConnectionId,
            visible: isVisible,
            connected: isConnected,
        };
    }, [activeConnectionId, isVisible, isConnected]);

    // Resume immediately when the app is shown instead of waiting for a slow detail interval.
    useEffect(() => {
        /** Reflect actual page visibility, including changes before this effect subscribed. */
        const updateVisibility = () => setDocumentVisible(!document.hidden);
        updateVisibility();
        document.addEventListener('visibilitychange', updateVisibility);
        return () => document.removeEventListener('visibilitychange', updateVisibility);
    }, []);

    const currentReading =
        reading && reading.connectionId === activeConnectionId && reading.epoch === epoch
            ? reading
            : null;
    const currentIssue =
        issue && issue.connectionId === activeConnectionId && issue.epoch === epoch ? issue : null;
    const updatedAt = currentReading?.updatedAt;

    // One freshness deadline per accepted reading, never a continuously ticking UI clock.
    useEffect(() => {
        if (updatedAt === undefined || !isConnected || !isVisible || !documentVisible) {
            return;
        }
        const timeout = setTimeout(
            () => setExpiredReadingAt(updatedAt),
            Math.max(0, updatedAt + intervalMs * 2 - Date.now()),
        );
        return () => clearTimeout(timeout);
    }, [updatedAt, intervalMs, isConnected, isVisible, documentVisible]);

    /** Return the next poll delay, or stop when this pane's current transport is lost. */
    const fetchMetrics = useCallback(
        async (isPolling: () => boolean): Promise<number | undefined> => {
            const targetId = activeConnectionId;
            const targetEpoch =
                targetId === 'local'
                    ? 0
                    : targetId
                      ? getConnectionBackendEpoch(targetId)
                      : undefined;
            if (!targetId || targetEpoch === undefined || !isVisible || document.hidden) {
                return intervalMs;
            }
            if (
                isFetching.current?.connectionId === targetId &&
                isFetching.current.epoch === targetEpoch &&
                isFetching.current.isPolling()
            ) {
                return intervalMs;
            }
            const request = { connectionId: targetId, epoch: targetEpoch, isPolling };
            isFetching.current = request;
            /** Discard success and failure after a hide, target change, or transport replacement. */
            const isCurrent = () =>
                isPolling() &&
                !document.hidden &&
                currentTarget.current.id === targetId &&
                currentTarget.current.visible &&
                currentTarget.current.connected &&
                (targetId === 'local' || getConnectionBackendEpoch(targetId) === targetEpoch);
            try {
                const result = await sample(
                    targetId,
                    targetId === 'local' && navigator.userAgent.includes('Windows'),
                );
                if (!isCurrent()) {
                    return intervalMs;
                }
                setReading((previous) => {
                    if (
                        previous &&
                        previous.connectionId === targetId &&
                        previous.epoch === targetEpoch &&
                        previous.sample === result
                    ) {
                        return previous;
                    }
                    return {
                        connectionId: targetId,
                        epoch: targetEpoch,
                        sample: result,
                        updatedAt: result.sampledAt,
                    };
                });
                setIssue(null);
                return intervalMs;
            } catch (failure: unknown) {
                if (!isCurrent()) {
                    return intervalMs;
                }
                const message = failure instanceof Error ? failure.message : String(failure);
                if (disconnectOnMissing && message.includes('Connection not found')) {
                    void useAppStore.getState().disconnect(targetId);
                    return undefined;
                }
                const saturated = message.includes('Channel open failure');
                setIssue({ connectionId: targetId, epoch: targetEpoch, message, saturated });
                return saturated ? Math.max(SATURATION_BACKOFF_MS, intervalMs) : intervalMs;
            } finally {
                if (isFetching.current === request) {
                    isFetching.current = null;
                }
            }
        },
        [activeConnectionId, isVisible, intervalMs, sample, disconnectOnMissing],
    );

    useEffect(() => {
        if (!activeConnectionId || !isConnected || !isVisible || !documentVisible) {
            return;
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let active = true;
        /** Await one sample before scheduling its successor, including saturation backoff. */
        const poll = async () => {
            const delay = await fetchMetrics(() => active);
            if (active && delay !== undefined) {
                timeout = setTimeout(() => void poll(), delay);
            }
        };
        void poll();
        return () => {
            active = false;
            clearTimeout(timeout);
        };
    }, [activeConnectionId, epoch, isConnected, isVisible, documentVisible, fetchMetrics]);

    return {
        reading: currentReading,
        issue: currentIssue,
        stale: Boolean(currentIssue) || (updatedAt !== undefined && expiredReadingAt === updatedAt),
        loading: !currentReading && !currentIssue && isConnected && isVisible,
    };
}

/** Bind the stable sampler method without allocating a new polling callback on every render. */
const sampleMetrics = (connectionId: string, windows: boolean) =>
    dashboardMetrics.sample(connectionId, windows);

/** Keep real, bounded summary history separate from the reusable polling lifecycle. */
export function useDashboardMetrics(options: {
    connectionId: string | null | undefined;
    isConnected: boolean;
    isVisible: boolean;
}) {
    const resource = useDashboardPolling({
        ...options,
        intervalMs: DASHBOARD_SAMPLE_TTL_MS,
        sample: sampleMetrics,
        disconnectOnMissing: true,
    });
    const [history, setHistory] = useState<{
        connectionId: string;
        epoch: number;
        sample: DashboardSample;
        cpu: DashboardHistoryPoint[];
        ram: DashboardHistoryPoint[];
    } | null>(null);
    const reading = resource.reading;

    useEffect(() => {
        if (!reading) {
            return;
        }
        const { connectionId, epoch, sample } = reading;
        if (connectionId !== 'local' && getConnectionBackendEpoch(connectionId) !== epoch) {
            return;
        }
        setHistory((previous) => {
            const sameOwner = previous?.connectionId === connectionId && previous.epoch === epoch;
            if (sameOwner && previous.sample === sample) {
                return previous;
            }
            return {
                connectionId,
                epoch,
                sample,
                cpu: appendHistory(sameOwner ? previous.cpu : [], sample.cpu, sample.sampledAt),
                ram: appendHistory(
                    sameOwner ? previous.ram : [],
                    sample.ram.percent,
                    sample.sampledAt,
                ),
            };
        });
        if (connectionId !== 'local' && sample.info.os) {
            void useAppStore
                .getState()
                .setConnectionIconIfMissing(connectionId, detectOSIcon(sample.info.os))
                .catch((error) => console.warn('Could not save detected host icon:', error));
        }
    }, [reading]);

    const currentHistory =
        reading && history?.connectionId === reading.connectionId && history.epoch === reading.epoch
            ? history
            : { cpu: [], ram: [] };
    return {
        ...resource,
        reading: reading ? { ...reading, metrics: reading.sample, history: currentHistory } : null,
    };
}
