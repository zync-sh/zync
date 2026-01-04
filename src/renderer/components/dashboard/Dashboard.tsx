import { Activity, Cpu, Gauge, HardDrive } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { Skeleton } from '../ui/Skeleton';
import { ResourceWidget } from './ResourceWidget';

export function Dashboard({ connectionId }: { connectionId?: string }) {
  const { activeConnectionId: globalId, connections } = useConnections();
  const activeConnectionId = connectionId || globalId;

  // Find connection status
  const isLocal = activeConnectionId === 'local';
  const connection = !isLocal ? connections.find((c) => c.id === activeConnectionId) : null;
  const isConnected = isLocal || connection?.status === 'connected';

  // const { showToast } = useToast();

  const [metrics, setMetrics] = useState({
    cpu: 0,
    ram: { used: 0, total: 0, percent: 0 },
    disk: { used: '0', total: '0', percent: 0 },
    info: { os: 'Loading...', kernel: '', arch: '' },
  });

  const [history, setHistory] = useState<{
    cpu: { time: string; value: number }[];
    ram: { time: string; value: number }[];
  }>({
    cpu: Array(10).fill({ time: '', value: 0 }),
    ram: Array(10).fill({ time: '', value: 0 }),
  });

  const fetchMetrics = async () => {
    if (!activeConnectionId) return;
    try {
      // Fetch CPU/Load
      const loadOut = await window.ipcRenderer.invoke('ssh:exec', {
        id: activeConnectionId,
        command: "cat /proc/loadavg | awk '{print $1}'",
      });
      // Mock CPU % from load avg (Load * 10 is rough approx for visual movement)
      const cpuLoad = Math.min(parseFloat(loadOut) * 10, 100);

      // Fetch Memory
      const memOut = await window.ipcRenderer.invoke('ssh:exec', {
        id: activeConnectionId,
        command: "free -m | grep Mem | awk '{print $2,$3}'",
      });
      const [totalMem, usedMem] = memOut.trim().split(/\s+/).map(Number);
      const memPercent = (usedMem / totalMem) * 100;

      // Fetch Disk
      const diskOut = await window.ipcRenderer.invoke('ssh:exec', {
        id: activeConnectionId,
        command: 'df -h / --output=size,used,pcent | tail -1',
      });
      const [diskTotal, diskUsed, diskPcentStr] = diskOut.trim().split(/\s+/);
      const diskPercent = parseInt(diskPcentStr.replace('%', ''), 10);

      // Fetch Info (Once or lazily? We'll do it here for simplicity, optimization later)
      // Ideally we check if info is already loaded.
      let info = metrics.info;
      if (info.os === 'Loading...') {
        const osOut = await window.ipcRenderer.invoke('ssh:exec', {
          id: activeConnectionId,
          command: "grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"'",
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

      // Update State
      const now = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      setMetrics({
        cpu: cpuLoad,
        ram: { used: usedMem, total: totalMem, percent: memPercent },
        disk: { used: diskUsed, total: diskTotal, percent: diskPercent },
        info,
      });

      setHistory((prev) => ({
        cpu: [...prev.cpu.slice(1), { time: now, value: cpuLoad }],
        ram: [...prev.ram.slice(1), { time: now, value: memPercent }],
      }));
    } catch (error) {
      console.error('Failed to fetch metrics', error);
    }
  };

  useEffect(() => {
    if (!activeConnectionId || !isConnected) return;
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [activeConnectionId, isConnected, fetchMetrics]); // Added isConnected to dependency array

  if (!activeConnectionId) {
    return (
      <div className="h-full flex items-center justify-center text-app-muted">
        <p>Select a connection to view dashboard</p>
      </div>
    );
  }

  return (
    <div className="p-6 overflow-auto h-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-min">
      {/* Header */}
      <div className="col-span-full mb-4">
        <h1 className="text-2xl font-bold text-[var(--color-app-text)] mb-2">System Overview</h1>
        <p className="text-app-muted">Real-time metrics for currently active server</p>
      </div>

      <ResourceWidget
        title="CPU Usage"
        value={`${metrics.cpu.toFixed(1)}%`}
        subtext="Load Average (1m)"
        icon={Cpu}
        data={history.cpu}
        color="#f43f5e"
      />

      <ResourceWidget
        title="Memory Usage"
        value={`${Math.round(metrics.ram.used)} MB`}
        subtext={`of ${Math.round(metrics.ram.total)} MB`}
        icon={Activity}
        data={history.ram}
        color="#8b5cf6"
      />

      <div className="bg-app-panel border border-app-border rounded-lg p-4 flex flex-col h-40">
        <h3 className="text-sm font-medium text-app-muted flex items-center gap-2 mb-2">
          <HardDrive size={14} /> Disk Storage (Root)
        </h3>
        <div className="flex-1 flex flex-col justify-center">
          <div className="flex justify-between items-end mb-2">
            <span className="text-2xl font-bold text-[var(--color-app-text)]">{metrics.disk.percent}%</span>
            <span className="text-xs text-app-muted">
              {metrics.disk.used} / {metrics.disk.total}
            </span>
          </div>
          <div className="h-2 bg-app-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${metrics.disk.percent}%` }}
            />
          </div>
        </div>
      </div>

      {/* System Info with Loading State */}
      <div className="bg-app-panel border border-app-border rounded-lg p-4 flex flex-col h-40">
        <h3 className="text-sm font-medium text-app-muted flex items-center gap-2 mb-2">
          <Gauge size={14} /> System Info
        </h3>
        {metrics.info.os === 'Loading...' ? (
          <div className="flex-1 flex flex-col justify-center gap-2">
            <div className="flex justify-between items-center">
              <span className="text-app-muted text-sm">OS</span> <Skeleton className="h-4 w-24" />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-app-muted text-sm">Kernel</span> <Skeleton className="h-4 w-16" />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-app-muted text-sm">Arch</span> <Skeleton className="h-4 w-12" />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col justify-center text-sm gap-1">
            <div className="flex justify-between">
              <span className="text-app-muted">OS</span>{' '}
              <span className="text-[var(--color-app-text)] truncate max-w-[150px]" title={metrics.info.os}>
                {metrics.info.os}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-app-muted">Kernel</span> <span className="text-[var(--color-app-text)]">{metrics.info.kernel}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-app-muted">Arch</span> <span className="text-[var(--color-app-text)]">{metrics.info.arch}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
