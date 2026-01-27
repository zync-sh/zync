import { Activity, Cpu, Gauge } from 'lucide-react';
import { useRef, useEffect, useState } from 'react';
import { useAppStore, Connection } from '../../store/useAppStore';

import { ResourceWidget } from './ResourceWidget';
import { RadialProgress } from './RadialProgress';
import { UptimeWidget } from './UptimeWidget';
import { ProcessWidget } from './ProcessWidget';
import { QuickActionsWidget } from './QuickActionsWidget';

export function Dashboard({ connectionId }: { connectionId?: string }) {
  const globalId = useAppStore(state => state.activeConnectionId);
  const connections = useAppStore(state => state.connections);
  const settings = useAppStore(state => state.settings);

  const activeConnectionId = connectionId || globalId;

  // Find connection status
  const isLocal = activeConnectionId === 'local';
  const connection = !isLocal ? connections.find((c: Connection) => c.id === activeConnectionId) : null;
  const isConnected = isLocal || connection?.status === 'connected';

  const [metrics, setMetrics] = useState({
    cpu: 0,
    ram: { used: 0, total: 0, percent: 0 },
    disk: { used: '0', total: '0', percent: 0 },
    info: { os: 'Loading...', kernel: '', arch: '' },
    uptime: '',
    processes: 0,
  });

  const [history, setHistory] = useState<{
    cpu: { time: string; value: number }[];
    ram: { time: string; value: number }[];
  }>({
    cpu: Array(20).fill({ time: '', value: 0 }),
    ram: Array(20).fill({ time: '', value: 0 }),
  });

  const [isSaturationDetected, setIsSaturationDetected] = useState(false);
  const isFetching = useRef(false);

  const fetchMetrics = async () => {
    if (!activeConnectionId || isFetching.current) return;
    isFetching.current = true;
    try {
      // Detect if we are on Windows Local
      const isWindowsLocal = activeConnectionId === 'local' && navigator.userAgent.indexOf('Windows') !== -1;

      let cpuLoad = 0;
      let totalMem = 0;
      let usedMem = 0;
      let diskTotal = '0';
      let diskUsed = '0';
      let diskPercent = 0;
      let uptimeStr = '';
      let procCount = 0;
      let osName = metrics.info.os;
      let kernelVer = metrics.info.kernel;
      let osArch = metrics.info.arch;

      if (isWindowsLocal) {
        // ... Windows Logic (Unchanged) ...
        // Note: For Windows we might still face saturation if using multiple calls. 
        // But the issue reported is Linux. We leave Windows logic as is for now or todo later.

        // --- Windows (Local) Metrics via PowerShell ---
        // (Copying existing Windows logic for safety, though it wasn't the target of fix)
        // ... To be safe I will reuse the existing block logic but wrapped in try/catch loop
        // If "Channel open failure" happens on Windows it will be caught below.

        try {
          const psCommand = (cmd: string) => `powershell -NoProfile -Command "${cmd}"`;

          // CPU
          const cpuOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select -ExpandProperty Average'),
          });
          cpuLoad = parseFloat(cpuOut.trim()) || 0;

          // Memory
          const memOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('Get-CimInstance Win32_OperatingSystem | ForEach-Object { \\"$($_.TotalVisibleMemorySize) $($_.FreePhysicalMemory)\\" }'),
          });
          const [totalKB, freeKB] = memOut.trim().split(/\s+/).map(Number);
          totalMem = Math.round(totalKB / 1024); // to MB
          const freeMem = Math.round(freeKB / 1024); // to MB
          usedMem = totalMem - freeMem;

          // Uptime
          const uptimeOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToString()'),
          });
          uptimeStr = uptimeOut.trim().split('.')[0];

          // Processes
          const procOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('(Get-Process).Count'),
          });
          procCount = parseInt(procOut.trim(), 10) || 0;

          // Disk (C:)
          const diskOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID=\'C:\'\\" | ForEach-Object { \\"$($_.Size) $($_.FreeSpace)\\" }'),
          });
          const [diskSizeBytes, diskFreeBytes] = diskOut.trim().split(/\s+/).map(Number);
          const diskTotalGB = (diskSizeBytes / (1024 * 1024 * 1024));
          const diskFreeGB = (diskFreeBytes / (1024 * 1024 * 1024));
          const diskUsedGB = diskTotalGB - diskFreeGB;

          diskTotal = diskTotalGB.toFixed(0) + 'G';
          diskUsed = diskUsedGB.toFixed(0) + 'G';
          diskPercent = Math.round((diskUsedGB / diskTotalGB) * 100);

        } catch (err: any) {
          console.error('Windows metrics failed', err);
          throw err; // Re-throw to hit the saturation catch block
        }

      } else {
        // --- Linux / Standard SSH Metrics ---
        // Combine ALL commands to reduce channel usage to exactly 1 per interval.
        // We include OS info gathering in the same command if it's missing or just always (parsed cheaply).

        const combinedCmd = `
          cat /proc/loadavg | awk '{print $1}'
          free -m | grep Mem | awk '{print $2,$3}'
          uptime -p | sed 's/up //'
          ps aux | wc -l
          df -h / --output=size,used,pcent | tail -1 | awk '{print $1,$2,$3}'
          grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"' || uname -s
          uname -r
          uname -m
        `.trim().replace(/\n\s+/g, ';');

        const output = await window.ipcRenderer.invoke('ssh:exec', {
          id: activeConnectionId,
          command: combinedCmd,
        });

        // Parse output (newline separated)
        const lines = output.trim().split('\n');

        // 1. CPU Load
        if (lines[0]) cpuLoad = Math.min(parseFloat(lines[0]) * 10, 100);

        // 2. Memory
        if (lines[1]) {
          const [tMem, uMem] = lines[1].trim().split(/\s+/).map(Number);
          totalMem = tMem;
          usedMem = uMem;
        }

        // 3. Uptime
        if (lines[2]) uptimeStr = lines[2].trim();

        // 4. Process Count
        if (lines[3]) procCount = parseInt(lines[3].trim(), 10) || 0;

        // 5. Disk
        if (lines[4]) {
          const [dTotal, dUsed, dPcentStr] = lines[4].trim().split(/\s+/);
          diskTotal = dTotal;
          diskUsed = dUsed;
          diskPercent = parseInt((dPcentStr || '0').replace('%', ''), 10);
        }

        // 6. OS Info (Always fetch, it's cheap and saves extra channels)
        if (lines[5]) osName = lines[5].trim();
        if (lines[6]) kernelVer = lines[6].trim();
        if (lines[7]) osArch = lines[7].trim();
      }

      const memPercent = totalMem ? (usedMem / totalMem) * 100 : 0;

      // Update State
      const now = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      setMetrics({
        cpu: cpuLoad || 0,
        ram: { used: usedMem || 0, total: totalMem || 1, percent: memPercent || 0 },
        disk: { used: diskUsed || '0', total: diskTotal || '0', percent: diskPercent || 0 },
        info: { os: osName || 'Linux', kernel: kernelVer || '', arch: osArch || '' },
        uptime: uptimeStr,
        processes: procCount || 0,
      });

      // Auto-detect and set icon based on OS if not already set
      if (connection && !connection.icon && osName) {
        // ... (existing icon logic) ...
        const detectOSIcon = (osName: string): string => {
          const os = osName.toLowerCase();
          if (os.includes('ubuntu')) return 'ubuntu';
          if (os.includes('debian')) return 'debian';
          if (os.includes('centos') || os.includes('red hat') || os.includes('rhel')) return 'redhat';
          if (os.includes('arch')) return 'arch';
          if (os.includes('kali')) return 'kali';
          if (os.includes('fedora') || os.includes('amazon linux')) return 'redhat';
          if (os.includes('suse') || os.includes('opensuse')) return 'linux';
          if (os.includes('windows')) return 'windows';
          if (os.includes('darwin') || os.includes('macos') || os.includes('mac os')) return 'macos';
          if (os.includes('pop') || os.includes('mint')) return 'ubuntu';
          return 'linux'; // Default fallback
        };

        const detectedIcon = detectOSIcon(osName);
        if (connection.icon !== detectedIcon) {
          useAppStore.getState().editConnection({ ...connection, icon: detectedIcon });
        }
      }

      setHistory((prev) => ({
        cpu: [...prev.cpu.slice(1), { time: now, value: cpuLoad || 0 }],
        ram: [...prev.ram.slice(1), { time: now, value: memPercent || 0 }],
      }));

      // Success - Clear saturation flag
      setIsSaturationDetected(false);
      return true; // Continue polling

    } catch (error: any) {
      if (error.message && error.message.includes('Connection not found')) {
        console.warn('Backend lost connection, stopping dashboard polling:', activeConnectionId);
        useAppStore.getState().disconnect(activeConnectionId);
        return false; // Stop polling
      }

      // Handle Channel Open Failure - likely saturation
      if (error.message && error.message.includes('Channel open failure')) {
        console.warn('SSH Channel saturation, skipping update and backing off');
        setIsSaturationDetected(true);
        // Do not disconnect, just skip this update cycle
        return true;
      } else {
        console.warn('Metrics polling failed:', error);
        return true; // Continue trying?
      }
    } finally {
      isFetching.current = false;
    }
  };

  useEffect(() => {
    if (!activeConnectionId || !isConnected) return;

    // Initial fetch
    fetchMetrics();

    // Variable polling interval based on saturation status
    let timeoutId: NodeJS.Timeout;
    let isActive = true; // Mounted flag

    const scheduleNext = () => {
      const delay = isSaturationDetected ? 15000 : 3000; // 15s backoff if saturated, else 3s
      timeoutId = setTimeout(async () => {
        if (!isActive) return;
        const shouldContinue = await fetchMetrics();
        if (shouldContinue && isActive) {
          scheduleNext(); // Recursive schedule
        }
      }, delay);
    };

    scheduleNext();

    return () => {
      isActive = false;
      clearTimeout(timeoutId);
    };
  }, [activeConnectionId, isConnected, isSaturationDetected]); // Re-run if saturation status changes to adjust delay immediately? 
  // Ideally, if saturationDetected changes to true inside fetchMetrics, the NEXT schedule will see it.
  // But since scheduleNext reads state... Wait, scheduleNext uses closure?
  // We need to be careful. If we rely on closure, we might use stale `isSaturationDetected`.
  // Better to use `useEffect` dependencies or ref for saturation status?
  // Or just rely on re-running effect when `isSaturationDetected` changes.
  // Yes, adding it to dependencies works. 


  if (!activeConnectionId) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--color-app-muted)]">
        <p>Select a connection to view dashboard</p>
      </div>
    );
  }

  // Dynamic class for grid columns based on dashboard width is best handled by CSS Grid auto-fit

  return (
    <div className={`p-8 overflow-auto h-full scroll-smooth ${settings.enableVibrancy ? 'dashboard-vibrancy' : ''}`}>
      {/* Header */}
      <div className="mb-8 flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-[var(--color-app-text)] to-[var(--color-app-muted)] bg-clip-text text-transparent mb-2">System Overview</h1>
          <p className="text-[var(--color-app-muted)] text-base font-medium flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`} />
            {isConnected ? 'Live Monitoring' : 'Disconnected'}
          </p>
        </div>
        <div className="text-right">
          {metrics.info.os !== 'Loading...' && (
            <div className="bg-[var(--color-app-surface)]/50 backdrop-blur px-4 py-2 rounded-lg border border-[var(--color-app-border)] text-xs font-mono text-[var(--color-app-muted)]">
              {metrics.info.os} {metrics.info.arch}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 pb-20 auto-rows-[minmax(180px,auto)]">

        {/* Row 1: Primary Resources */}
        <ResourceWidget
          title="CPU Usage"
          value={`${metrics.cpu.toFixed(1)}%`}
          subtext="Load Average"
          icon={Cpu}
          data={history.cpu}
          color="#f43f5e"
          className="md:col-span-1 xl:col-span-1"
        />

        <ResourceWidget
          title="Memory Usage"
          value={`${Math.round(metrics.ram.used)} MB`}
          subtext={`of ${Math.round(metrics.ram.total)} MB`}
          icon={Activity}
          data={history.ram}
          color="#8b5cf6"
          className="md:col-span-1 xl:col-span-1"
        />

        {/* Disk & Process */}
        <RadialProgress
          value={metrics.disk.percent}
          label={metrics.disk.used}
          subtext={metrics.disk.total}
          color="#06b6d4"
          className="md:col-span-1"
        />

        <ProcessWidget
          count={metrics.processes}
          className="md:col-span-1"
        />

        {/* Row 2: Uptime & Info */}
        <UptimeWidget
          uptime={metrics.uptime}
          className="md:col-span-1 xl:col-span-2"
        />

        <div className="bg-app-panel border border-[var(--color-app-border)] rounded-2xl p-6 flex flex-col justify-between shadow-sm backdrop-blur-xl bg-opacity-60 md:col-span-2 xl:col-span-2 relative overflow-hidden group hover:border-[var(--color-app-accent)]/50 transition-all">
          <h3 className="text-xs font-medium text-[var(--color-app-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
            <Gauge size={14} className="text-[var(--color-app-muted)]/70 group-hover:text-[var(--color-app-accent)] transition-colors" /> System Info
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <div className='space-y-1'>
              <span className="text-xs text-[var(--color-app-muted)] uppercase">Kernel</span>
              <div className="font-mono text-sm text-[var(--color-app-text)]">{metrics.info.kernel || '-'}</div>
            </div>
            <div className='space-y-1'>
              <span className="text-xs text-[var(--color-app-muted)] uppercase">Architecture</span>
              <div className="font-mono text-sm text-[var(--color-app-text)]">{metrics.info.arch || '-'}</div>
            </div>
          </div>
        </div>

      </div>

      {/* Quick Actions */}
      <div className="pb-8">
        <QuickActionsWidget connectionId={activeConnectionId} />
      </div>
    </div>
  );
}
