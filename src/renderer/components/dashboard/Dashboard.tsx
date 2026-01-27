import { Activity, Cpu, Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';

import { ResourceWidget } from './ResourceWidget';
import { RadialProgress } from './RadialProgress';
import { UptimeWidget } from './UptimeWidget';
import { ProcessWidget } from './ProcessWidget';
import { QuickActionsWidget } from './QuickActionsWidget';
import { useSettings } from '../../context/SettingsContext';

export function Dashboard({ connectionId }: { connectionId?: string }) {
  const { activeConnectionId: globalId, connections } = useConnections();
  const { settings } = useSettings();
  const activeConnectionId = connectionId || globalId;

  // Find connection status
  const isLocal = activeConnectionId === 'local';
  const connection = !isLocal ? connections.find((c) => c.id === activeConnectionId) : null;
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

  const fetchMetrics = async () => {
    if (!activeConnectionId) return;
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

      if (isWindowsLocal) {
        // --- Windows (Local) Metrics via PowerShell ---
        
        try {
          const psCommand = (cmd: string) => `powershell -NoProfile -Command "${cmd}"`;

          // CPU
          const cpuOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select -ExpandProperty Average'),
          });
          cpuLoad = parseFloat(cpuOut.trim()) || 0;

          // Memory
          // Returns: TotalKB FreeKB
          const memOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('Get-CimInstance Win32_OperatingSystem | ForEach-Object { \\"$($_.TotalVisibleMemorySize) $($_.FreePhysicalMemory)\\" }'),
          });
           // Output: "33333333 11111111"
          const [totalKB, freeKB] = memOut.trim().split(/\s+/).map(Number);
          totalMem = Math.round(totalKB / 1024); // to MB
          const freeMem = Math.round(freeKB / 1024); // to MB
          usedMem = totalMem - freeMem;

          // Uptime
          // Returns: d.hh:mm:ss.ms approx
          const uptimeOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToString()'),
          });
          uptimeStr = uptimeOut.trim().split('.')[0]; // Remove milliseconds

          // Processes
          const procOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: psCommand('(Get-Process).Count'),
          });
          procCount = parseInt(procOut.trim(), 10) || 0;

          // Disk (C:)
          // Returns: SizeBytes FreeBytes
          const diskOut = await window.ipcRenderer.invoke('ssh:exec', {
             id: activeConnectionId,
             command: psCommand('Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID=\'C:\'\\" | ForEach-Object { \\"$($_.Size) $($_.FreeSpace)\\" }'),
          });
          const [diskSizeBytes, diskFreeBytes] = diskOut.trim().split(/\s+/).map(Number);
          const diskTotalGB = (diskSizeBytes / (1024*1024*1024));
          const diskFreeGB = (diskFreeBytes / (1024*1024*1024));
          const diskUsedGB = diskTotalGB - diskFreeGB;
          
          diskTotal = diskTotalGB.toFixed(0) + 'G';
          diskUsed = diskUsedGB.toFixed(0) + 'G';
          diskPercent = Math.round((diskUsedGB / diskTotalGB) * 100);

        } catch (err) {
           console.error('Windows metrics failed', err);
        }

      } else {
        // --- Linux / Standard SSH Metrics ---

        // Fetch CPU/Load
        const loadOut = await window.ipcRenderer.invoke('ssh:exec', {
          id: activeConnectionId,
          command: "cat /proc/loadavg | awk '{print $1}'",
        });
        // Mock CPU % from load avg (Load * 10 is rough approx for visual movement) - Cap at 100
        cpuLoad = Math.min(parseFloat(loadOut) * 10, 100);

        // Fetch Memory
        const memOut = await window.ipcRenderer.invoke('ssh:exec', {
          id: activeConnectionId,
          command: "free -m | grep Mem | awk '{print $2,$3}'",
        });
        const [tMem, uMem] = memOut.trim().split(/\s+/).map(Number); 
        totalMem = tMem;
        usedMem = uMem;

        // Fetch Uptime
        const uptimeOut = await window.ipcRenderer.invoke('ssh:exec', {
          id: activeConnectionId,
          command: "uptime -p | sed 's/up //'",
        });
        uptimeStr = uptimeOut.trim();

        // Fetch Process Count
        const procOut = await window.ipcRenderer.invoke('ssh:exec', {
          id: activeConnectionId,
          command: 'ps aux | wc -l',
        });
        procCount = parseInt(procOut.trim(), 10) || 0;

        // Fetch Disk
        const diskOut = await window.ipcRenderer.invoke('ssh:exec', {
          id: activeConnectionId,
          command: "df -h / --output=size,used,pcent | tail -1 | awk '{print $1,$2,$3}'",
        });
        // df output with specified columns: 476G 80G 18%
        const [dTotal, dUsed, dPcentStr] = diskOut.trim().split(/\s+/);
        diskTotal = dTotal;
        diskUsed = dUsed;
        diskPercent = parseInt((dPcentStr || '0').replace('%', ''), 10);
      }

      const memPercent = totalMem ? (usedMem / totalMem) * 100 : 0;



      // Fetch Info
      let info = metrics.info;
      if (info.os === 'Loading...') {
        if (isWindowsLocal) {
             const psCommand = (cmd: string) => `powershell -NoProfile -Command "${cmd}"`;
             try {
                const osName = await window.ipcRenderer.invoke('ssh:exec', { id: activeConnectionId, command: psCommand('Get-CimInstance Win32_OperatingSystem | Select -ExpandProperty Caption') });
                const osArch = await window.ipcRenderer.invoke('ssh:exec', { id: activeConnectionId, command: psCommand('Get-CimInstance Win32_OperatingSystem | Select -ExpandProperty OSArchitecture') });
                const kernelVer = await window.ipcRenderer.invoke('ssh:exec', { id: activeConnectionId, command: psCommand('Get-CimInstance Win32_OperatingSystem | Select -ExpandProperty Version') });
                
                info = {
                    os: osName.trim(),
                    kernel: kernelVer.trim(),
                    arch: osArch.trim()
                };
             } catch (e) {
                 info = { os: 'Windows (Local)', kernel: 'Unknown', arch: 'Unknown' };
             }
        } else {
            const osOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: "grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"' || uname -s",
            });
            const kernelOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: 'uname -r',
            });
            const archOut = await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: 'uname -m',
            });
            info = {
            os: osOut.trim() || 'Linux',
            kernel: kernelOut.trim(),
            arch: archOut.trim(),
            };
        }
      }

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
        info,
        uptime: uptimeStr,
        processes: procCount || 0,
      });

      setHistory((prev) => ({
        cpu: [...prev.cpu.slice(1), { time: now, value: cpuLoad || 0 }],
        ram: [...prev.ram.slice(1), { time: now, value: memPercent || 0 }],
      }));
    } catch (error: any) {
      // Ignore "Connection not found" errors as they happen during disconnect/tab switch
      if (error.message && error.message.includes('Connection not found')) {
        return;
      }
      console.warn('Metrics polling failed:', error);
    }
  };

  useEffect(() => {
    if (!activeConnectionId || !isConnected) return;
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 3000); // Faster polling for smoother look
    return () => clearInterval(interval);
  }, [activeConnectionId, isConnected]);

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
