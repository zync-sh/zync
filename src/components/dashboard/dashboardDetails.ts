import { linuxCpuInterval } from './dashboardMetrics.js';
import { runDashboardPosixScript } from './dashboardPosix.js';

export type DashboardProcessSort = 'cpu' | 'memory';

export interface DashboardProcess {
    pid: number;
    name: string;
    /** Percent of the whole host's logical CPU capacity over successive observations. */
    cpu: number | null;
    /** Resident/working-set bytes, not private or proportional memory. */
    memoryBytes: number | null;
}

export interface DashboardFilesystem {
    /** Keeps distinct byte paths identifiable even when their display names use replacements. */
    key: string;
    source: string;
    mount: string;
    type: string | null;
    totalBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    percent: number | null;
    inodePercent: number | null;
}

export interface DashboardDetailSample<T> {
    sampledAt: number;
    items: T[];
    supported: boolean;
    /** The source scan or probe budget was reached; ordinary top-ten selection is not truncation. */
    truncated: boolean;
}

export interface DashboardProcessSample extends DashboardDetailSample<DashboardProcess> {
    sort: DashboardProcessSort;
}

export const DASHBOARD_PROCESS_REFRESH_MS = 10_000;
export const DASHBOARD_FILESYSTEM_REFRESH_MS = 60_000;
export const DASHBOARD_PROCESS_RESULT_LIMIT = 10;
export const DASHBOARD_PROCESS_SCAN_LIMIT = 512;
export const DASHBOARD_FILESYSTEM_LIMIT = 64;
const PROCESS_BASELINE_TTL_MS = DASHBOARD_PROCESS_REFRESH_MS * 6;
const MAX_OUTPUT_LENGTH = 1024 * 1024;
const WINDOWS_FRAME = 'ZYNC_DASHBOARD_DETAILS_V1';
const LINUX_FRAME = 'ZYNC_DASHBOARD_DETAILS_V2';
const MAX_NAME_LENGTH = 4096;
const linuxNameDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

// In the C locale awk indexes bytes, including names that are not valid UTF-8.
const LINUX_NAME_AWK = String.raw`
BEGIN {
    for (byte=1; byte<=255; byte++) hexByte[sprintf("%c",byte)]=sprintf("%02x",byte);
    mountEscape["\\040"]="20"; mountEscape["\\011"]="09";
    mountEscape["\\012"]="0a"; mountEscape["\\134"]="5c";
}
function hexName(value, fromMountInfo, i, character, escape, result) {
    for (i=1; i<=length(value); i++) {
        character=substr(value,i,1);
        if (fromMountInfo && character == "\\") {
            escape=substr(value,i,4);
            if (escape in mountEscape) {
                result=result mountEscape[escape];
                i+=3;
                continue;
            }
        }
        result=result hexByte[character];
    }
    return result;
}
`;

// No process command lines are read.
// Linux stat field positions: docs.kernel.org/filesystems/proc.html, Table 1-4.
const LINUX_PROCESS_AWK =
    LINUX_NAME_AWK +
    String.raw`
BEGIN {
    printf "%s%cprocesses%clinux%c1%c", marker, 0, 0, 0, 0;
    if ((getline aggregate < "/proc/stat") > 0) {
        split(aggregate, cpu, / +/);
        if (cpu[1] == "cpu") for (i=2; i<=9; i++) printf "%s%s", (i>2 ? "," : ""), (cpu[i] == "" ? "0" : cpu[i]);
    }
    close("/proc/stat");
    printf "%c%c", 0, 0;
}
{
    if ($0 !~ /^\/proc\/[0-9]+$/) next;
    if (scanned++ >= limit) { limited=1; exit; }
    path=$0 "/stat";
    raw="";
    while ((getline part < path) > 0) {
        raw = raw (raw == "" ? "" : "\n") part;
        if (length(raw) > 4096) { limited=1; break; }
    }
    close(path);
    if (raw == "" || length(raw) > 4096) next;
    pid=raw; sub(/ .*/, "", pid);
    closing=0;
    for (i=1; i<=length(raw); i++) if (substr(raw,i,1) == ")") closing=i;
    if (pid !~ /^[0-9]+$/ || substr(raw,length(pid)+1,2) != " (" || !closing) next;
    name=substr(raw,length(pid)+3,closing-length(pid)-3);
    count=split(substr(raw,closing+2), fields, / +/);
    if (count < 22 || fields[12] !~ /^[0-9]+$/ || fields[13] !~ /^[0-9]+$/ || fields[20] !~ /^[0-9]+$/) next;
    memory="";
    if (pageSize ~ /^[0-9]+$/ && pageSize > 0 && fields[22] ~ /^[0-9]+$/) memory=sprintf("%.0f",fields[22]*pageSize);
    printf "P%c%s%c%s%c%s%c%.0f%c%s%c", 0,pid,0,hexName(name,0),0,fields[20],0,fields[12]+fields[13],0,memory,0;
}
END { printf "END%c%d%c",0,limited ? 1 : 0,0; }
`;

/** Quote application-owned scripts; endpoint and process data never become command source. */
function shellLiteral(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

const unsupportedProcesses = "printf '%s\\0' '" + LINUX_FRAME + "' processes linux 0 '' '' END 0";
export const LINUX_PROCESS_DETAILS_COMMAND = runDashboardPosixScript(
    [
        'if [ -r /proc/stat ] && command -v awk >/dev/null 2>&1; then',
        'LC_ALL=C; export LC_ALL',
        'pageSize=$(getconf PAGESIZE 2>/dev/null)',
        "printf '%s\\n' /proc/[0-9]* | awk -v marker=" +
            shellLiteral(LINUX_FRAME) +
            ' -v limit=' +
            DASHBOARD_PROCESS_SCAN_LIMIT +
            ' -v pageSize="$pageSize" ' +
            shellLiteral(LINUX_PROCESS_AWK),
        'else ' + unsupportedProcesses + '; fi',
    ].join('\n'),
);

// Mountinfo escapes whitespace and backslashes. Candidate discovery never stats a path.
// Only known local disk filesystems are probed; remote/autofs ancestors are excluded too.
export const LINUX_MOUNTS_AWK =
    LINUX_NAME_AWK +
    String.raw`
function local(type) { return type ~ /^(ext2|ext3|ext4|xfs|btrfs|zfs|f2fs|jfs|reiserfs|bcachefs|vfat|exfat|ntfs|ntfs3|ubifs|overlay)$/; }
function remote(type) { return type ~ /^(nfs|nfs4|cifs|smb3|9p|ceph|afs|autofs|virtiofs|fuse.*)$/; }
function visibleLocal(id, ancestor) {
    while (parents[id] in mounts && parents[id] != id) {
        ancestor=parents[id];
        if (mounts[ancestor] != mounts[id] && (covered[ancestor] || remote(types[ancestor]))) return 0;
        id=ancestor;
    }
    return 1;
}
function octalMountPath(mount, i, character, result) {
    # POSIX printf %b expects an initial zero before each octal escape.
    for (i=1; i<=length(mount); i++) {
        character=substr(mount,i,1);
        result=result (character == "\\" ? "\\0" : character);
    }
    return result;
}
{
    if (NR > 4096) { limited=1; exit; }
    separator=0;
    for (i=7;i<=NF;i++) if ($i == "-") { separator=i; break; }
    if (!separator || separator+2>NF) next;
    id=$1; parents[id]=$2; mounts[id]=$5; types[id]=$(separator+1); sources[id]=$(separator+2);
    order[++lengthOrder]=id;
}
END {
    # Later entries can cover early mounts, so a truncated graph cannot safely drive probes.
    if (limited) { print "T 1"; exit; }
    for (id in mounts) {
        ancestor=parents[id];
        if (ancestor != id && ancestor in mounts && mounts[id] == mounts[ancestor]) covered[ancestor]=1;
    }
    emitted=0;
    for (i=1;i<=lengthOrder;i++) {
        id=order[i]; mount=mounts[id]; type=types[id];
        if (!local(type) || covered[id] || !visibleLocal(id)) continue;
        if (emitted++ >= limit) { limited=1; break; }
        printf "F %s %s %s %s\n",hexName(sources[id],1),hexName(mount,1),octalMountPath(mount),type;
    }
    printf "T %d\n",limited ? 1 : 0;
}
`;

const LINUX_FILESYSTEM_SCRIPT =
    String.raw`
LC_ALL=C; export LC_ALL
printf '%s\0' "$1" filesystems linux 1
read -r started rest < /proc/uptime
started=${'$'}{started%%.*}
awk -v limit="$2" ` +
    shellLiteral(LINUX_MOUNTS_AWK) +
    String.raw` /proc/self/mountinfo | {
    limited=0
    while IFS=' ' read -r kind sourceHex mountHex encodedMount type; do
        if [ "$kind" = T ]; then
            [ "$sourceHex" = 1 ] && limited=1
            continue
        fi
        read -r current rest < /proc/uptime
        current=${'$'}{current%%.*}
        if [ "$current" -ge "$((started + 6))" ]; then limited=1; break; fi
        # Keep trailing newlines by appending/removing one literal suffix.
        decoded=$(printf '%b.' "$encodedMount"); mount=${'$'}{decoded%.}
        values=$(timeout --kill-after=0.2 1 df --no-sync --local -B1 --output=size,used,avail,pcent,ipcent -- "$mount" 2>/dev/null)
        if [ "$?" -ne 0 ]; then
            limited=1
            printf 'F\0%s\0%s\0%s\0\0\0\0\0\0' "$sourceHex" "$mountHex" "$type"
            continue
        fi
        # Only numeric df fields cross this pipe; paths never become shell syntax.
        printf 'F\0%s\0%s\0%s\0' "$sourceHex" "$mountHex" "$type"
        printf '%s\n' "$values" | awk 'NR==2 { printf "%s%c%s%c%s%c%s%c%s%c",$1,0,$2,0,$3,0,$4,0,$5,0; found=1; } END { if (!found) printf "%c%c%c%c%c",0,0,0,0,0; }'
    done
    printf 'END\0%s\0' "$limited"
}
`;

export const LINUX_FILESYSTEM_DETAILS_COMMAND = runDashboardPosixScript(
    [
        'if [ -r /proc/self/mountinfo ] && [ -r /proc/uptime ] && command -v awk >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 && df --version >/dev/null 2>&1; then',
        'timeout --kill-after=1 8 sh -c ' +
            shellLiteral(LINUX_FILESYSTEM_SCRIPT) +
            ' zync-dashboard ' +
            shellLiteral(LINUX_FRAME) +
            ' ' +
            DASHBOARD_FILESYSTEM_LIMIT,
        "else printf '%s\\0' '" + LINUX_FRAME + "' filesystems linux 0 END 0; fi",
    ].join('\n'),
);

const WINDOWS_PREAMBLE = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'function Write-DetailField($value) {',
    '  if ($null -ne $value) { [Console]::Write([Convert]::ToString($value, [Globalization.CultureInfo]::InvariantCulture)) }',
    '  [Console]::Write([char]0)',
    '}',
];

export const WINDOWS_PROCESS_DETAILS_COMMAND = [
    ...WINDOWS_PREAMBLE,
    '$cpuCount = $null',
    'try { $cpuCount = (Get-CimInstance Win32_ComputerSystem -Property NumberOfLogicalProcessors -OperationTimeoutSec 3).NumberOfLogicalProcessors } catch {}',
    '$clock = [Diagnostics.Stopwatch]::GetTimestamp() / [double][Diagnostics.Stopwatch]::Frequency',
    "Write-DetailField '" +
        WINDOWS_FRAME +
        "'; Write-DetailField 'processes'; Write-DetailField 'windows'; Write-DetailField 1",
    'Write-DetailField $clock; Write-DetailField $cpuCount',
    '$rows = @(Get-Process | Where-Object { $_.Id -gt 0 } | Select-Object -First ' +
        (DASHBOARD_PROCESS_SCAN_LIMIT + 1) +
        ')',
    '$limited = $rows.Count -gt ' + DASHBOARD_PROCESS_SCAN_LIMIT,
    '$rows | Select-Object -First ' + DASHBOARD_PROCESS_SCAN_LIMIT + ' | ForEach-Object {',
    '  $entry = $_; $started = $null; $cpu = $null; $memory = $null',
    "  try { $started = $entry.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) } catch {}",
    '  try { $cpu = $entry.TotalProcessorTime.TotalSeconds } catch {}',
    '  try { $memory = $entry.WorkingSet64 } catch {}',
    "  Write-DetailField 'P'; Write-DetailField $entry.Id; Write-DetailField $entry.ProcessName",
    '  Write-DetailField $started; Write-DetailField $cpu; Write-DetailField $memory',
    '}',
    "Write-DetailField 'END'; Write-DetailField ([int]$limited)",
].join('\n');

export const WINDOWS_FILESYSTEM_DETAILS_COMMAND = [
    ...WINDOWS_PREAMBLE,
    '$rows = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3" -OperationTimeoutSec 3 | Select-Object -First ' +
        (DASHBOARD_FILESYSTEM_LIMIT + 1) +
        ')',
    "Write-DetailField '" +
        WINDOWS_FRAME +
        "'; Write-DetailField 'filesystems'; Write-DetailField 'windows'; Write-DetailField 1",
    '$limited = $rows.Count -gt ' + DASHBOARD_FILESYSTEM_LIMIT,
    '$rows | Select-Object -First ' + DASHBOARD_FILESYSTEM_LIMIT + ' | ForEach-Object {',
    '  $disk = $_; $used = $null; $percent = $null',
    '  if ($null -ne $disk.Size -and $null -ne $disk.FreeSpace -and $disk.Size -gt 0) { $used = $disk.Size - $disk.FreeSpace; $percent = 100 * $used / $disk.Size }',
    "  Write-DetailField 'F'; Write-DetailField $disk.DeviceID; Write-DetailField ($disk.DeviceID + '\\'); Write-DetailField $disk.FileSystem",
    '  Write-DetailField $disk.Size; Write-DetailField $used; Write-DetailField $disk.FreeSpace; Write-DetailField $percent; Write-DetailField $null',
    '}',
    "Write-DetailField 'END'; Write-DetailField ([int]$limited)",
].join('\n');

interface Dependencies {
    execute(connectionId: string, command: string): Promise<string>;
    readEpoch(connectionId: string): number | undefined;
    now?: () => number;
}
interface RawProcess {
    pid: number;
    name: string;
    identity: string;
    cpu: number | null;
    memoryBytes: number | null;
}
interface ProcessScan {
    sampledAt: number;
    supported: boolean;
    truncated: boolean;
    clock: number | null;
    counters?: number[];
    logicalProcessors: number | null;
    items: RawProcess[];
    calculated: DashboardProcess[];
}
interface Entry<T> {
    epoch: number;
    windows: boolean;
    expiresAt: number;
    retainUntil: number;
    value?: T;
    promise: Promise<T>;
}

/** Treat nonnumeric/missing fields as unavailable rather than turning them into healthy zeroes. */
function numberField(value: string, integer = false): number | null {
    if (!/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && (!integer || Number.isSafeInteger(number))
        ? number
        : null;
}

/** Decode ASCII-framed Linux names, substituting replacement characters for invalid UTF-8 bytes. */
function decodeLinuxName(hex: string): string {
    if (hex.length > MAX_NAME_LENGTH * 2 || !/^(?:[0-9a-f]{2})*$/.test(hex)) {
        throw new Error('Invalid dashboard detail name');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        if (byte === 0) {
            throw new Error('Invalid dashboard detail name');
        }
        bytes[index] = byte;
    }
    return linuxNameDecoder.decode(bytes);
}

/** Accept only a complete, bounded frame with exactly the requested provider and record shape. */
function frame(output: string, kind: 'processes' | 'filesystems', windows: boolean) {
    if (output.length > MAX_OUTPUT_LENGTH || !output.endsWith('\0')) {
        throw new Error('Invalid dashboard detail frame');
    }
    const fields = output.split('\0');
    fields.pop();
    if (
        fields[0] !== (windows ? WINDOWS_FRAME : LINUX_FRAME) ||
        fields[1] !== kind ||
        fields[2] !== (windows ? 'windows' : 'linux') ||
        !['0', '1'].includes(fields[3])
    ) {
        throw new Error('Invalid dashboard detail frame');
    }
    return { fields, supported: fields[3] === '1' };
}

/** Require an explicit end marker; truncated/partial command output must never resemble success. */
function endFrame(fields: string[], offset: number): boolean {
    if (
        fields[offset] !== 'END' ||
        !['0', '1'].includes(fields[offset + 1]) ||
        offset + 2 !== fields.length
    ) {
        throw new Error('Incomplete dashboard detail frame');
    }
    return fields[offset + 1] === '1';
}

/** Parse bounded resident memory and identity counters while preserving untrusted names as text. */
function parseProcesses(output: string, windows: boolean, sampledAt: number): ProcessScan {
    const { fields, supported } = frame(output, 'processes', windows);
    const counters =
        !windows && fields[4]
            ? fields[4].split(',').map((field) => numberField(field, true))
            : undefined;
    const validCounters =
        counters?.length === 8 && counters.every((value): value is number => value !== null)
            ? counters
            : undefined;
    const total = validCounters?.reduce((sum, value) => sum + value, 0);
    const clock = windows
        ? numberField(fields[4])
        : total !== undefined && Number.isSafeInteger(total)
          ? total
          : null;
    const items: RawProcess[] = [];
    const seen = new Set<number>();
    let offset = 6;
    while (fields[offset] === 'P') {
        if (items.length >= DASHBOARD_PROCESS_SCAN_LIMIT || offset + 6 >= fields.length) {
            throw new Error('Oversized dashboard process frame');
        }
        const pid = numberField(fields[offset + 1], true);
        const name = windows
            ? fields[offset + 2]
            : decodeLinuxName(fields[offset + 2]) || 'Unnamed process';
        const identity = fields[offset + 3];
        if (
            pid === null ||
            pid < 1 ||
            seen.has(pid) ||
            !name ||
            name.length > MAX_NAME_LENGTH ||
            identity.length > 128
        ) {
            throw new Error('Invalid dashboard process record');
        }
        seen.add(pid);
        items.push({
            pid,
            name,
            identity,
            cpu: numberField(fields[offset + 4], !windows),
            memoryBytes: numberField(fields[offset + 5], true),
        });
        offset += 6;
    }
    const truncated = endFrame(fields, offset);
    if (!supported && items.length) {
        throw new Error('Unsupported dashboard process frame contains data');
    }
    return {
        sampledAt,
        supported,
        truncated,
        clock,
        counters: validCounters,
        logicalProcessors: numberField(fields[5], true),
        items,
        calculated: [],
    };
}

/** Keep each mount's data together; names are never split on whitespace or executed. */
function parseFilesystems(
    output: string,
    windows: boolean,
    sampledAt: number,
): DashboardDetailSample<DashboardFilesystem> {
    const { fields, supported } = frame(output, 'filesystems', windows);
    const items: DashboardFilesystem[] = [];
    const seen = new Set<string>();
    let offset = 4;
    while (fields[offset] === 'F') {
        if (items.length >= DASHBOARD_FILESYSTEM_LIMIT || offset + 8 >= fields.length) {
            throw new Error('Oversized dashboard filesystem frame');
        }
        const key = fields[offset + 2];
        const source = windows ? fields[offset + 1] : decodeLinuxName(fields[offset + 1]);
        const mount = windows ? key : decodeLinuxName(key);
        const type = fields[offset + 3];
        if (
            !source ||
            !mount ||
            source.length > MAX_NAME_LENGTH ||
            mount.length > MAX_NAME_LENGTH ||
            type.length > 128 ||
            seen.has(key)
        ) {
            throw new Error('Invalid dashboard filesystem record');
        }
        seen.add(key);
        /** Missing inode support remains unavailable; strip only df's explicit percentage suffix. */
        const percent = (value: string) =>
            numberField(value.endsWith('%') ? value.slice(0, -1) : value);
        items.push({
            key,
            source,
            mount,
            type: type || null,
            totalBytes: numberField(fields[offset + 4], true),
            usedBytes: numberField(fields[offset + 5], true),
            availableBytes: numberField(fields[offset + 6], true),
            percent: percent(fields[offset + 7]),
            inodePercent: percent(fields[offset + 8]),
        });
        offset += 9;
    }
    const truncated = endFrame(fields, offset);
    if (!supported && items.length) {
        throw new Error('Unsupported dashboard filesystem frame contains data');
    }
    return { sampledAt, items, supported, truncated };
}

/** Match PID lifetime and host capacity; a fresh/reset baseline is unavailable, never lifetime CPU. */
function processesFor(
    scan: ProcessScan,
    previous: ProcessScan | undefined,
    windows: boolean,
): DashboardProcess[] {
    let capacity: number | null = null;
    if (scan.clock !== null && previous && previous.clock !== null) {
        const delta = scan.clock - previous.clock;
        if (!windows && scan.counters && previous.counters) {
            capacity = linuxCpuInterval(previous.counters, scan.counters)?.total ?? null;
        } else if (
            windows &&
            delta > 0 &&
            scan.logicalProcessors &&
            scan.logicalProcessors === previous.logicalProcessors
        ) {
            capacity = delta * scan.logicalProcessors;
        }
    }
    const baselines = new Map(previous?.items.map((item) => [item.pid, item]));
    return scan.items.map((item) => {
        const prior = baselines.get(item.pid);
        const delta =
            item.cpu !== null && prior?.cpu !== null && prior?.cpu !== undefined
                ? item.cpu - prior.cpu
                : null;
        const cpu =
            capacity &&
            item.identity &&
            item.identity === prior?.identity &&
            delta !== null &&
            delta >= 0
                ? Math.min(100, (delta / capacity) * 100)
                : null;
        return { pid: item.pid, name: item.name, cpu, memoryBytes: item.memoryBytes };
    });
}

/** Share slower read-only acquisitions while fencing both admission and late transport responses. */
export function createDashboardDetailsSampler({
    execute,
    readEpoch,
    now = Date.now,
}: Dependencies) {
    const processCache = new Map<string, Entry<ProcessScan>>();
    const filesystemCache = new Map<string, Entry<DashboardDetailSample<DashboardFilesystem>>>();
    /** Local reads share the app lifetime; SSH reads belong to the current transport epoch. */
    const epochFor = (id: string) => (id === 'local' ? 0 : readEpoch(id));

    /** Prune expired snapshots lazily; no timer or background SSH work is created by a cache. */
    function acquire<T>(
        cache: Map<string, Entry<T>>,
        id: string,
        windows: boolean,
        ttl: number,
        retain: number,
        command: string,
        parse: (output: string, time: number, previous?: T) => T,
    ): Promise<T> {
        const requestedAt = now();
        for (const [key, entry] of cache) {
            if (entry.retainUntil <= requestedAt || epochFor(key) !== entry.epoch) {
                cache.delete(key);
            }
        }
        const epoch = epochFor(id);
        if (epoch === undefined) {
            return Promise.reject(new Error('Dashboard connection is no longer active'));
        }
        const cached = cache.get(id);
        if (
            cached?.epoch === epoch &&
            cached.windows === windows &&
            cached.expiresAt > requestedAt
        ) {
            return cached.promise;
        }
        const previous =
            cached?.epoch === epoch && cached.windows === windows ? cached.value : undefined;
        /** A late response may publish only while it owns both the transport and cache entry. */
        const owns = () => epochFor(id) === epoch && cache.get(id) === entry;
        const entry: Entry<T> = {
            epoch,
            windows,
            expiresAt: Infinity,
            retainUntil: Infinity,
            promise: Promise.resolve()
                .then(() => {
                    if (!owns()) {
                        throw new Error('Dashboard detail sample was superseded');
                    }
                    return execute(id, command);
                })
                .then((output) => {
                    if (!owns()) {
                        throw new Error('Dashboard detail sample was superseded');
                    }
                    const time = now();
                    const value = parse(output, time, previous);
                    entry.value = value;
                    entry.expiresAt = time + ttl;
                    entry.retainUntil = time + retain;
                    return value;
                })
                .catch((error: unknown) => {
                    if (cache.get(id) === entry) {
                        cache.delete(id);
                    }
                    throw error;
                }),
        };
        cache.set(id, entry);
        return entry.promise;
    }

    return {
        /** Select top rows from the same cached scan for both CPU and memory sorting. */
        async processes(
            connectionId: string,
            windows: boolean,
            sort: DashboardProcessSort,
        ): Promise<DashboardProcessSample> {
            const scan = await acquire(
                processCache,
                connectionId,
                windows,
                DASHBOARD_PROCESS_REFRESH_MS,
                PROCESS_BASELINE_TTL_MS,
                windows ? WINDOWS_PROCESS_DETAILS_COMMAND : LINUX_PROCESS_DETAILS_COMMAND,
                (output, time, baseline) => {
                    const parsed = parseProcesses(output, windows, time);
                    // Retain calculated values with this acquisition so later sorts share identical intervals.
                    return { ...parsed, calculated: processesFor(parsed, baseline, windows) };
                },
            );
            const items = [...scan.calculated]
                .sort((a, b) => {
                    const left = sort === 'cpu' ? a.cpu : a.memoryBytes;
                    const right = sort === 'cpu' ? b.cpu : b.memoryBytes;
                    return (
                        (right ?? -1) - (left ?? -1) ||
                        (sort === 'cpu' ? (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1) : 0) ||
                        a.pid - b.pid
                    );
                })
                .slice(0, DASHBOARD_PROCESS_RESULT_LIMIT);
            return {
                sampledAt: scan.sampledAt,
                sort,
                items,
                supported: scan.supported,
                truncated: scan.truncated,
            };
        },
        /** Refresh only local disk filesystems; unsupported platforms return an explicit capability result. */
        filesystems(
            connectionId: string,
            windows: boolean,
        ): Promise<DashboardDetailSample<DashboardFilesystem>> {
            return acquire(
                filesystemCache,
                connectionId,
                windows,
                DASHBOARD_FILESYSTEM_REFRESH_MS,
                DASHBOARD_FILESYSTEM_REFRESH_MS,
                windows ? WINDOWS_FILESYSTEM_DETAILS_COMMAND : LINUX_FILESYSTEM_DETAILS_COMMAND,
                (output, time) => parseFilesystems(output, windows, time),
            );
        },
    };
}
