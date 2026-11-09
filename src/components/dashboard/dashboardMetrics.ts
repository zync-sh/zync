import { runDashboardPosixScript } from './dashboardPosix.js';

export interface DashboardMetrics {
    cpu: number | null;
    cpuDetails: {
        cores: number | null;
        loadAverage: [number, number, number] | null;
        iowait: number | null;
    };
    ram: {
        used: number | null;
        total: number | null;
        percent: number | null;
        available: number | null;
        cached: number | null;
        swap: { used: number; total: number } | null;
    };
    network: Array<{
        name: string;
        receiveBytesPerSecond: number | null;
        transmitBytesPerSecond: number | null;
    }> | null;
    disk: { used: string | null; total: string | null; percent: number | null };
    info: { os: string; kernel: string; arch: string };
    uptime: string;
    processes: number | null;
}

/** One real acquisition, including its completion time shared by every consumer of the cache. */
export interface DashboardSample extends DashboardMetrics {
    sampledAt: number;
}

export interface DashboardHistoryPoint {
    sampledAt: number;
    value: number;
}

export const DASHBOARD_SAMPLE_TTL_MS = 3000;
export const DASHBOARD_HISTORY_LIMIT = 20;
export const DASHBOARD_HISTORY_GAP_MS = DASHBOARD_SAMPLE_TTL_MS * 3;
// Retain a baseline across normal refreshes, but start fresh after a dashboard has been idle.
export const DASHBOARD_CPU_BASELINE_TTL_MS = DASHBOARD_SAMPLE_TTL_MS * 10;
export const DASHBOARD_NETWORK_INTERFACE_LIMIT = 128;
const POSIX_EXTENSION_START = '__ZYNC_DASHBOARD_V1__';
const POSIX_EXTENSION_END = '__ZYNC_DASHBOARD_END__';
const POSIX_SUMMARY_ROWS = 8;

// One PowerShell process provides a complete local sample.
export const WINDOWS_DASHBOARD_COMMAND = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$os = Get-CimInstance Win32_OperatingSystem',
    '$processors = @(Get-CimInstance Win32_Processor)',
    '$cpu = ($processors | Measure-Object -Property LoadPercentage -Average).Average',
    '$cores = ($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum',
    '$drive = $os.SystemDrive',
    'if (-not $drive) { $drive = $env:SystemDrive }',
    '$disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID=\'{0}\'" -f $drive)',
    '$uptime = if ($null -ne $os.LastBootUpTime) { (Get-Date) - $os.LastBootUpTime } else { $null }',
    '$memory = $null; try { $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop } catch {}',
    '$pageFiles = $null; try { $pageFiles = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop) } catch {}',
    `$network = $null; try { $network = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction Stop | Select-Object -First ${DASHBOARD_NETWORK_INTERFACE_LIMIT} | ForEach-Object { [pscustomobject]@{ name = $_.Name; receiveBytesPerSecond = $_.BytesReceivedPersec; transmitBytesPerSecond = $_.BytesSentPersec } }) } catch {}`,
    '[pscustomobject]@{',
    'cpu = $(if ($null -ne $cpu) { [double]$cpu } else { $null })',
    'cores = $cores',
    'availableMem = $(if ($null -ne $os.FreePhysicalMemory) { [double]$os.FreePhysicalMemory / 1024 } else { $null })',
    'cachedMem = $(if ($null -ne $memory -and $null -ne $memory.CacheBytes) { [double]$memory.CacheBytes / 1MB } else { $null })',
    'swapUsed = $(if ($null -ne $pageFiles) { [double]($pageFiles | Measure-Object -Property CurrentUsage -Sum).Sum } else { $null })',
    'swapTotal = $(if ($null -ne $pageFiles) { [double]($pageFiles | Measure-Object -Property AllocatedBaseSize -Sum).Sum } else { $null })',
    'network = $network',
    'totalMem = $(if ($null -ne $os.TotalVisibleMemorySize) { [math]::Round($os.TotalVisibleMemorySize / 1024) } else { $null })',
    'usedMem = $(if ($null -ne $os.TotalVisibleMemorySize -and $null -ne $os.FreePhysicalMemory) { [math]::Round($os.TotalVisibleMemorySize / 1024) - [math]::Round($os.FreePhysicalMemory / 1024) } else { $null })',
    'diskSize = $(if ($null -ne $disk.Size) { [double]$disk.Size } else { $null })',
    'diskFree = $(if ($null -ne $disk.FreeSpace) { [double]$disk.FreeSpace } else { $null })',
    "uptime = $(if ($null -ne $uptime) { '{0}d {1}h {2}m' -f $uptime.Days, $uptime.Hours, $uptime.Minutes } else { $null })",
    'processes = @(Get-Process).Count',
    'os = $os.Caption',
    'kernel = $os.Version',
    'arch = $os.OSArchitecture',
    '} | ConvertTo-Json -Compress -Depth 4',
].join('\n');

/** Reserve one line for each application-owned summary probe, including empty results. */
function posixSummaryRow(command: string): string {
    return `printf '%s\\n' "$(${command})"`;
}

const POSIX_DASHBOARD_COMMAND = runDashboardPosixScript(
    [
        'LC_ALL=C; export LC_ALL',
        posixSummaryRow("if [ -r /proc/stat ]; then awk '/^cpu / {print; exit}' /proc/stat; fi"),
        posixSummaryRow('free -m | awk \'$1 == "Mem:" {print $2,$3; exit}\''),
        posixSummaryRow("uptime -p | sed -n '1{s/^up //;p;}'"),
        posixSummaryRow("ps -e -o pid= | awk 'NF {count++} END {if (count) print count}'"),
        posixSummaryRow(
            "df -h / --output=size,used,pcent | awk 'NR==2 && NF==3 {print $1,$2,$3; exit}'",
        ),
        `os=$(awk '/^PRETTY_NAME=/ {sub(/^PRETTY_NAME=/, ""); gsub(/^"|"$/, ""); print; exit}' /etc/os-release 2>/dev/null)`,
        posixSummaryRow('if [ -n "$os" ]; then printf "%s" "$os"; else uname -s; fi'),
        posixSummaryRow('uname -r'),
        posixSummaryRow('uname -m'),
        `printf '${POSIX_EXTENSION_START}\\n'`,
        'if [ -r /proc/stat ]; then awk \'/^cpu[0-9]+ / {n++} END {if (n) print "cores " n}\' /proc/stat; fi',
        'if [ -r /proc/loadavg ]; then awk \'{print "load " $1 " " $2 " " $3}\' /proc/loadavg; fi',
        'if [ -r /proc/meminfo ]; then awk \'/^(MemAvailable|Cached|SwapTotal|SwapFree):/ {sub(/:$/, "", $1); print "mem " $1 " " $2}\' /proc/meminfo; fi',
        `if [ -r /proc/net/dev ]; then printf 'network ready\\n'; awk -F: 'NR>2 && NF==2 {gsub(/^[ \\t]+|[ \\t]+$/, "", $1); gsub(/^[ \\t]+/, "", $2); split($2, n, /[ \\t]+/); if (++count <= ${DASHBOARD_NETWORK_INTERFACE_LIMIT}) print "net " $1 " " n[1] " " n[9]}' /proc/net/dev || printf 'network unavailable\\n'; else printf 'network unavailable\\n'; fi`,
        `printf '${POSIX_EXTENSION_END}\\n'`,
    ].join('; '),
);

/** Preserve an unavailable measured CPU value instead of presenting it as an idle processor. */
function measuredCpu(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
        ? value
        : null;
}

/** Keep optional measurements distinct from zero and reject partially numeric input. */
function optionalNumber(value: unknown): number | null {
    const number =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
              ? Number(value)
              : Number.NaN;
    return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Accept only exactly represented cumulative counters or whole processor counts. */
function optionalInteger(value: unknown): number | null {
    const number = optionalNumber(value);
    return number !== null && Number.isSafeInteger(number) ? number : null;
}

/** Derive a percentage only from a complete and consistent measured pair. */
function usagePercent(used: number | null, total: number | null): number | null {
    if (used === null || total === null || total <= 0 || used > total) {
        return null;
    }
    return (used / total) * 100;
}

/** Validate memory amounts against a known total and preserve other available fields. */
function memoryMetrics({
    used,
    total,
    available,
    cached,
    swap,
}: Omit<DashboardMetrics['ram'], 'percent'>): DashboardMetrics['ram'] {
    /** Reject an amount that exceeds the measured capacity. */
    const bounded = (amount: number | null) =>
        amount !== null && total !== null && amount > total ? null : amount;
    return {
        used: bounded(used),
        total,
        percent: usagePercent(used, total),
        available: bounded(available),
        cached: bounded(cached),
        swap,
    };
}

/** Bound display names and exclude controls that could corrupt the framed collector output. */
function networkName(value: unknown): string | null {
    return typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : null;
}

interface NetworkCounters {
    name: string;
    receive: number | null;
    transmit: number | null;
}

interface NetworkSnapshot {
    interfaces: NetworkCounters[];
    sampledAt: number;
}

interface LinuxDetails {
    cores: number | null;
    loadAverage: [number, number, number] | null;
    available: number | null;
    cached: number | null;
    swap: DashboardMetrics['ram']['swap'];
    network: NetworkCounters[] | null;
}

/** Read one unambiguous scalar from the versioned Linux extension. */
function numberField(fields: Map<string, string[]>, key: string): number | null {
    const values = fields.get(key);
    return values?.length === 1 ? optionalNumber(values[0]) : null;
}

/** Parse bounded optional Linux details without changing the legacy eight-line sample contract. */
function linuxDetails(lines: readonly string[]): LinuxDetails {
    const result: LinuxDetails = {
        cores: null,
        loadAverage: null,
        available: null,
        cached: null,
        swap: null,
        network: null,
    };
    const start = POSIX_SUMMARY_ROWS;
    const end = lines.indexOf(POSIX_EXTENSION_END, start + 1);
    if (
        lines[start] !== POSIX_EXTENSION_START ||
        end <= start ||
        end - start > DASHBOARD_NETWORK_INTERFACE_LIMIT + 16 ||
        lines.indexOf(POSIX_EXTENSION_START, start + 1) !== -1 ||
        lines.indexOf(POSIX_EXTENSION_END, end + 1) !== -1
    ) {
        return result;
    }
    const fields = new Map<string, string[]>();
    const network: NetworkCounters[] = [];
    const names = new Set<string>();
    let validNetwork = true;
    for (const line of lines.slice(start + 1, end)) {
        const [kind, ...values] = line.trim().split(/\s+/);
        if (kind === 'net') {
            const name = networkName(values[0]);
            if (
                !name ||
                values.length !== 3 ||
                names.has(name) ||
                network.length >= DASHBOARD_NETWORK_INTERFACE_LIMIT
            ) {
                validNetwork = false;
                continue;
            }
            names.add(name);
            network.push({
                name,
                receive: optionalInteger(values[1]),
                transmit: optionalInteger(values[2]),
            });
        } else {
            const key = kind === 'mem' ? `mem.${values[0]}` : kind;
            const field = kind === 'mem' ? values.slice(1) : values;
            fields.set(key, fields.has(key) ? [] : field);
        }
    }
    const cores = optionalInteger(numberField(fields, 'cores'));
    result.cores = cores !== null && cores > 0 ? cores : null;
    const load = fields.get('load')?.map(optionalNumber);
    if (load?.length === 3 && load.every((value) => value !== null)) {
        result.loadAverage = load as [number, number, number];
    }
    const available = numberField(fields, 'mem.MemAvailable');
    const cached = numberField(fields, 'mem.Cached');
    result.available = available === null ? null : available / 1024;
    result.cached = cached === null ? null : cached / 1024;
    const swapTotal = numberField(fields, 'mem.SwapTotal');
    const swapFree = numberField(fields, 'mem.SwapFree');
    if (swapTotal !== null && swapFree !== null && swapFree <= swapTotal) {
        result.swap = { total: swapTotal / 1024, used: (swapTotal - swapFree) / 1024 };
    }
    if (validNetwork && fields.get('network')?.join(' ') === 'ready') {
        result.network = network;
    }
    return result;
}

/** Derive per-interface byte rates only from advancing counters in adjacent owned acquisitions. */
function networkUsage(
    current: NetworkCounters[] | null,
    previous: NetworkSnapshot | undefined,
    sampledAt: number,
): DashboardMetrics['network'] {
    if (current === null) {
        return null;
    }
    const elapsed = previous ? (sampledAt - previous.sampledAt) / 1000 : 0;
    const old = new Map(previous?.interfaces.map((item) => [item.name, item]));
    return current.map((item) => {
        const before = old.get(item.name);
        if (
            elapsed <= 0 ||
            !before ||
            item.receive === null ||
            item.transmit === null ||
            before.receive === null ||
            before.transmit === null ||
            item.receive < before.receive ||
            item.transmit < before.transmit
        ) {
            return { name: item.name, receiveBytesPerSecond: null, transmitBytesPerSecond: null };
        }
        return {
            name: item.name,
            receiveBytesPerSecond: (item.receive - before.receive) / elapsed,
            transmitBytesPerSecond: (item.transmit - before.transmit) / elapsed,
        };
    });
}

/** Use Windows' formatted performance-counter rates without inventing a Linux counter baseline. */
function windowsNetwork(value: unknown): DashboardMetrics['network'] {
    if (!Array.isArray(value) || value.length > DASHBOARD_NETWORK_INTERFACE_LIMIT) {
        return null;
    }
    const result: NonNullable<DashboardMetrics['network']> = [];
    const names = new Set<string>();
    for (const item of value) {
        const name = networkName(item?.name);
        if (!name || names.has(name)) {
            return null;
        }
        names.add(name);
        result.push({
            name,
            receiveBytesPerSecond: optionalNumber(item.receiveBytesPerSecond),
            transmitBytesPerSecond: optionalNumber(item.transmitBytesPerSecond),
        });
    }
    return result;
}

interface LinuxCpuSnapshot {
    counters: readonly number[];
    iowait: number | null;
}

const LINUX_CPU_IDLE_INDEX = 3;
const LINUX_CPU_IOWAIT_INDEX = 4;

/** Validate the whole-host interval even when Linux revises its I/O wait counter downward. */
export function linuxCpuInterval(
    previous: readonly number[],
    current: readonly number[],
): { total: number; idle: number } | null {
    let total = 0;
    let idle = 0;
    for (let index = 0; index < current.length; index++) {
        const delta = current[index] - previous[index];
        if (index !== LINUX_CPU_IOWAIT_INDEX && delta < 0) {
            return null;
        }
        total += delta;
        if (index === LINUX_CPU_IDLE_INDEX || index === LINUX_CPU_IOWAIT_INDEX) {
            idle += delta;
        }
    }
    return total > 0 && idle >= 0 && idle <= total ? { total, idle } : null;
}

/** Read aggregate Linux counters, excluding guest time already included in user and nice. */
function linuxCpuSnapshot(line: string): LinuxCpuSnapshot | undefined {
    const [label, ...fields] = line.trim().split(/\s+/);
    if (label !== 'cpu' || fields.length < 4 || fields.length > 10) {
        return undefined;
    }
    const values = fields.map((field) => (/^\d+$/.test(field) ? Number(field) : Number.NaN));
    if (values.some((value) => !Number.isSafeInteger(value))) {
        return undefined;
    }
    const counters = Array.from({ length: 8 }, (_, index) => values[index] ?? 0);
    const total = counters.reduce((sum, counter) => sum + counter, 0);
    return Number.isSafeInteger(total)
        ? { counters, iowait: values[LINUX_CPU_IOWAIT_INDEX] ?? null }
        : undefined;
}

/** Calculate utilization only across valid, advancing counters from the same transport lifetime. */
function linuxCpuUsage(
    previous: LinuxCpuSnapshot | undefined,
    current: LinuxCpuSnapshot | undefined,
): { usage: number | null; iowait: number | null } {
    if (!previous || !current) {
        return { usage: null, iowait: null };
    }
    const interval = linuxCpuInterval(previous.counters, current.counters);
    if (!interval) {
        return { usage: null, iowait: null };
    }
    const { total, idle } = interval;
    const iowait =
        current.iowait === null || previous.iowait === null
            ? null
            : current.iowait - previous.iowait;
    return {
        usage: ((total - idle) / total) * 100,
        iowait: iowait !== null && iowait >= 0 ? (iowait / total) * 100 : null,
    };
}

/** Parses the single Windows JSON sample while deriving disk usage from actual byte counts. */
function windowsMetrics(output: string): DashboardMetrics {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid Windows dashboard metrics response');
    }
    const record = value as Record<string, unknown>;
    const diskSize = optionalNumber(record.diskSize);
    const diskFree = optionalNumber(record.diskFree);
    const diskUsed =
        diskSize !== null && diskFree !== null && diskFree <= diskSize ? diskSize - diskFree : null;
    const diskPercent = usagePercent(diskUsed, diskSize);
    const cores = optionalInteger(record.cores);
    const swapUsed = optionalNumber(record.swapUsed);
    const swapTotal = optionalNumber(record.swapTotal);
    /** Reads presentation strings without stringifying malformed provider fields. */
    const text = (field: string, fallback = '') =>
        typeof record[field] === 'string' ? (record[field] as string) : fallback;
    return {
        cpu: measuredCpu(record.cpu),
        cpuDetails: {
            cores: cores !== null && cores > 0 ? cores : null,
            loadAverage: null,
            iowait: null,
        },
        ram: memoryMetrics({
            used: optionalNumber(record.usedMem),
            total: optionalNumber(record.totalMem),
            available: optionalNumber(record.availableMem),
            cached: optionalNumber(record.cachedMem),
            swap:
                swapUsed !== null && swapTotal !== null && swapUsed <= swapTotal
                    ? { used: swapUsed, total: swapTotal }
                    : null,
        }),
        network: windowsNetwork(record.network),
        disk: {
            used: diskUsed === null ? null : `${(diskUsed / 1024 ** 3).toFixed(0)}G`,
            total: diskSize === null ? null : `${(diskSize / 1024 ** 3).toFixed(0)}G`,
            percent: diskPercent === null ? null : Math.round(diskPercent),
        },
        info: { os: text('os', 'Windows'), kernel: text('kernel'), arch: text('arch') },
        uptime: text('uptime'),
        processes: optionalInteger(record.processes),
    };
}

/** Preserve empty slots, and reject a frame whose summary row positions are ambiguous. */
function posixSummaryLines(output: string): string[] {
    const lines = output.split(/\r?\n/);
    const extensionStart = lines.indexOf(POSIX_EXTENSION_START);
    if (
        lines.length < POSIX_SUMMARY_ROWS ||
        (extensionStart !== -1 && extensionStart !== POSIX_SUMMARY_ROWS)
    ) {
        throw new Error('Invalid POSIX dashboard summary rows');
    }
    return lines;
}

/** Accept human-readable sizes emitted by df without treating other text as disk telemetry. */
function posixDiskSize(value: string | undefined): string | null {
    return value && /^\d+(?:\.\d+)?(?:[KMGTPEZYRQ](?:i?B)?|B)?$/.test(value) ? value : null;
}

/** Preserve the combined POSIX fields while supplying CPU utilization from successive counters. */
function posixMetrics(
    lines: readonly string[],
    cpu: { usage: number | null; iowait: number | null },
    details: LinuxDetails,
    network: DashboardMetrics['network'],
): DashboardMetrics {
    const [totalValue, usedValue] = lines[1].trim().split(/\s+/);
    const [diskTotal, diskUsed, diskPercent] = lines[4].trim().split(/\s+/);
    return {
        cpu: cpu.usage,
        cpuDetails: { cores: details.cores, loadAverage: details.loadAverage, iowait: cpu.iowait },
        ram: memoryMetrics({
            used: optionalNumber(usedValue),
            total: optionalNumber(totalValue),
            available: details.available,
            cached: details.cached,
            swap: details.swap,
        }),
        network,
        disk: {
            used: posixDiskSize(diskUsed),
            total: posixDiskSize(diskTotal),
            percent: optionalNumber(diskPercent?.replace(/%$/, '')),
        },
        info: {
            os: lines[5].trim(),
            kernel: lines[6].trim(),
            arch: lines[7].trim(),
        },
        uptime: lines[2].trim(),
        processes: optionalInteger(lines[3].trim()),
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
    retainUntil: number;
    cpuSnapshot?: LinuxCpuSnapshot;
    networkSnapshot?: NetworkSnapshot;
    promise: Promise<DashboardSample>;
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
        sample(connectionId: string, windows: boolean): Promise<DashboardSample> {
            const requestedAt = now();
            for (const [id, cached] of samples) {
                if (cached.retainUntil <= requestedAt || epochFor(id) !== cached.epoch) {
                    samples.delete(id);
                }
            }
            const epoch = epochFor(connectionId);
            if (epoch === undefined) {
                return Promise.reject(new Error('Dashboard connection is no longer active'));
            }
            const cached = samples.get(connectionId);
            if (
                cached?.epoch === epoch &&
                cached.windows === windows &&
                cached.expiresAt > requestedAt
            ) {
                return cached.promise;
            }
            const previousCpu =
                !windows && cached?.epoch === epoch && !cached.windows
                    ? cached.cpuSnapshot
                    : undefined;
            const previousNetwork =
                !windows && cached?.epoch === epoch && !cached.windows
                    ? cached.networkSnapshot
                    : undefined;
            /** Checks both transport identity and exact cache ownership before native submission/publication. */
            const ownsSample = () =>
                epochFor(connectionId) === epoch && samples.get(connectionId) === sample;
            const sample: CachedSample = {
                epoch,
                windows,
                expiresAt: Infinity,
                retainUntil: Infinity,
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
                        const sampledAt = now();
                        let metrics: DashboardMetrics;
                        let cpuSnapshot: LinuxCpuSnapshot | undefined;
                        let networkSnapshot: NetworkSnapshot | undefined;
                        if (windows) {
                            metrics = windowsMetrics(output);
                        } else {
                            const lines = posixSummaryLines(output);
                            cpuSnapshot = linuxCpuSnapshot(lines[0]);
                            const details = linuxDetails(lines);
                            metrics = posixMetrics(
                                lines,
                                linuxCpuUsage(previousCpu, cpuSnapshot),
                                details,
                                networkUsage(details.network, previousNetwork, sampledAt),
                            );
                            if (details.network !== null) {
                                networkSnapshot = { interfaces: details.network, sampledAt };
                            }
                        }
                        sample.cpuSnapshot = cpuSnapshot;
                        sample.networkSnapshot = networkSnapshot;
                        sample.expiresAt = sampledAt + DASHBOARD_SAMPLE_TTL_MS;
                        sample.retainUntil =
                            sampledAt +
                            (windows ? DASHBOARD_SAMPLE_TTL_MS : DASHBOARD_CPU_BASELINE_TTL_MS);
                        return { ...metrics, sampledAt };
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
