import { useCallback } from 'react';

import { getConnectionBackendEpoch } from '../../lib/terminal/connectionBackend';
import {
    createDashboardDetailsSampler,
    DASHBOARD_FILESYSTEM_REFRESH_MS,
    DASHBOARD_PROCESS_REFRESH_MS,
    type DashboardProcessSort,
} from './dashboardDetails';
import { useDashboardPolling } from './useDashboardMetrics';

const dashboardDetails = createDashboardDetailsSampler({
    /** Reuse the existing native execution boundary without opening a terminal or installing an agent. */
    execute: (connectionId, command) =>
        window.ipcRenderer.invoke('ssh:exec', { connectionId, command }),
    readEpoch: getConnectionBackendEpoch,
});

/** Keep the filesystem callback stable across component renders and detail-toggle changes. */
const sampleFilesystems = (connectionId: string, windows: boolean) =>
    dashboardDetails.filesystems(connectionId, windows);

/** Collect expensive details only while requested, independently from the fast summary. */
export function useDashboardDetails({
    connectionId,
    isConnected,
    isVisible,
    processesOpen,
    filesystemsOpen,
    processSort,
}: {
    connectionId: string | null | undefined;
    isConnected: boolean;
    isVisible: boolean;
    processesOpen: boolean;
    filesystemsOpen: boolean;
    processSort: DashboardProcessSort;
}) {
    /** A changed sort selects another view of the shared scan rather than admitting a new command. */
    const sampleProcesses = useCallback(
        (targetId: string, windows: boolean) =>
            dashboardDetails.processes(targetId, windows, processSort),
        [processSort],
    );
    const processes = useDashboardPolling({
        connectionId,
        isConnected,
        isVisible: isVisible && processesOpen,
        intervalMs: DASHBOARD_PROCESS_REFRESH_MS,
        sample: sampleProcesses,
    });
    const filesystems = useDashboardPolling({
        connectionId,
        isConnected,
        isVisible: isVisible && filesystemsOpen,
        intervalMs: DASHBOARD_FILESYSTEM_REFRESH_MS,
        sample: sampleFilesystems,
    });
    return { processes, filesystems };
}
