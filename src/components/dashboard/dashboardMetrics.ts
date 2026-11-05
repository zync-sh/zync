export interface DashboardMetrics {
    cpu: number;
    ram: { used: number; total: number; percent: number };
    disk: { used: string; total: string; percent: number };
    info: { os: string; kernel: string; arch: string };
    uptime: string;
    processes: number;
}

export const DASHBOARD_SAMPLE_TTL_MS = 3000;

// One PowerShell process and one operating-system query provide a complete local sample.
export const WINDOWS_DASHBOARD_COMMAND = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$os = Get-CimInstance Win32_OperatingSystem',
    '$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    '$drive = $os.SystemDrive',
    'if (-not $drive) { $drive = $env:SystemDrive }',
    '$disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID=\'{0}\'" -f $drive)',
    '$uptime = (Get-Date) - $os.LastBootUpTime',
    '[pscustomobject]@{',
    'cpu = [double]$cpu',
    'totalMem = [math]::Round($os.TotalVisibleMemorySize / 1024)',
    'usedMem = [math]::Round($os.TotalVisibleMemorySize / 1024) - [math]::Round($os.FreePhysicalMemory / 1024)',
    'diskSize = [double]$disk.Size',
    'diskFree = [double]$disk.FreeSpace',
    "uptime = ('{0}d {1}h {2}m' -f $uptime.Days, $uptime.Hours, $uptime.Minutes)",
    'processes = @(Get-Process).Count',
    'os = $os.Caption',
    'kernel = $os.Version',
    'arch = $os.OSArchitecture',
    '} | ConvertTo-Json -Compress',
].join('\n');

const POSIX_DASHBOARD_COMMAND = [
    "cat /proc/loadavg | awk '{print $1}'",
    "free -m | grep Mem | awk '{print $2,$3}'",
    "uptime -p | sed 's/up //'",
    'ps aux | wc -l',
    "df -h / --output=size,used,pcent | tail -1 | awk '{print $1,$2,$3}'",
    "grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"' || uname -s",
    'uname -r',
    'uname -m',
].join('; ');

/** Keeps missing or malformed numeric fields out of gauges and percentage calculations. */
function finiteNumber(value: unknown): number {
    const number = typeof value === 'number' ? value : Number.parseFloat(String(value));
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

/** Parses the single Windows JSON sample while deriving disk usage from actual byte counts. */
function windowsMetrics(output: string): DashboardMetrics {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid Windows dashboard metrics response');
    }
    const record = value as Record<string, unknown>;
    const total = finiteNumber(record.totalMem);
    const used = finiteNumber(record.usedMem);
    const diskSize = finiteNumber(record.diskSize);
    const diskUsed = Math.max(0, diskSize - finiteNumber(record.diskFree));
    /** Reads presentation strings without stringifying malformed provider fields. */
    const text = (field: string, fallback = '') =>
        typeof record[field] === 'string' ? (record[field] as string) : fallback;
    return {
        cpu: Math.min(100, finiteNumber(record.cpu)),
        ram: { used, total: total || 1, percent: total ? (used / total) * 100 : 0 },
        disk: {
            used: `${(diskUsed / 1024 ** 3).toFixed(0)}G`,
            total: `${(diskSize / 1024 ** 3).toFixed(0)}G`,
            percent: diskSize ? Math.round((diskUsed / diskSize) * 100) : 0,
        },
        info: { os: text('os', 'Windows'), kernel: text('kernel'), arch: text('arch') },
        uptime: text('uptime'),
        processes: finiteNumber(record.processes),
    };
}

/** Preserves the existing combined POSIX sample and its load-average display convention. */
function posixMetrics(output: string): DashboardMetrics {
    const lines = output.trim().split('\n');
    const [totalValue, usedValue] = (lines[1] || '').trim().split(/\s+/);
    const total = finiteNumber(totalValue);
    const used = finiteNumber(usedValue);
    const [diskTotal, diskUsed, diskPercent] = (lines[4] || '').trim().split(/\s+/);
    return {
        cpu: Math.min(100, finiteNumber(lines[0]) * 10),
        ram: { used, total: total || 1, percent: total ? (used / total) * 100 : 0 },
        disk: {
            used: diskUsed || '0',
            total: diskTotal || '0',
            percent: finiteNumber(diskPercent),
        },
        info: {
            os: lines[5]?.trim() || 'Linux',
            kernel: lines[6]?.trim() || '',
            arch: lines[7]?.trim() || '',
        },
        uptime: lines[2]?.trim() || '',
        processes: finiteNumber(lines[3]),
    };
}

interface SamplerDependencies {
    execute: (connectionId: string, command: string) => Promise<string>;
    readEpoch: (connectionId: string) => number | undefined;
    now?: () => number;
}

interface CachedSample {
    epoch: number;
    windows: boolean;
    expiresAt: number;
    promise: Promise<DashboardMetrics>;
}

/** Shares active/briefly fresh samples without timers, and isolates every live transport lifetime. */
export function createDashboardMetricsSampler({
    execute,
    readEpoch,
    now = Date.now,
}: SamplerDependencies) {
    const samples = new Map<string, CachedSample>();
    /** Local sampling has a process lifetime; remote samples belong to a live SSH owner. */
    const epochFor = (id: string) => (id === 'local' ? 0 : readEpoch(id));
    return {
        /** Joins one current request or briefly fresh result, never an earlier transport's data. */
        sample(connectionId: string, windows: boolean): Promise<DashboardMetrics> {
            for (const [id, cached] of samples) {
                if (cached.expiresAt <= now() || epochFor(id) !== cached.epoch) {
                    samples.delete(id);
                }
            }
            const epoch = epochFor(connectionId);
            if (epoch === undefined) {
                return Promise.reject(new Error('Dashboard connection is no longer active'));
            }
            const cached = samples.get(connectionId);
            if (cached?.epoch === epoch && cached.windows === windows) {
                return cached.promise;
            }
            /** Checks both transport identity and exact cache ownership before native submission/publication. */
            const ownsSample = () =>
                epochFor(connectionId) === epoch && samples.get(connectionId) === sample;
            const sample: CachedSample = {
                epoch,
                windows,
                expiresAt: Infinity,
                promise: Promise.resolve()
                    .then(() => {
                        if (!ownsSample()) {
                            throw new Error(
                                'Dashboard sample was superseded by a connection change',
                            );
                        }
                        return execute(
                            connectionId,
                            windows ? WINDOWS_DASHBOARD_COMMAND : POSIX_DASHBOARD_COMMAND,
                        );
                    })
                    .then((output) => {
                        if (!ownsSample()) {
                            throw new Error(
                                'Dashboard sample was superseded by a connection change',
                            );
                        }
                        const metrics = windows ? windowsMetrics(output) : posixMetrics(output);
                        sample.expiresAt = now() + DASHBOARD_SAMPLE_TTL_MS;
                        return metrics;
                    })
                    .catch((error: unknown) => {
                        if (samples.get(connectionId) === sample) {
                            samples.delete(connectionId);
                        }
                        throw error;
                    }),
            };
            samples.set(connectionId, sample);
            return sample.promise;
        },
    };
}
