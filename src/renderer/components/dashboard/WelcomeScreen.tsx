import { Clock, LayoutDashboard, Plus, Server, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';

export function WelcomeScreen({ onGoToApp }: { onGoToApp?: () => void }) {
  const { connections, openTab, openAddConnectionModal } = useConnections();
  const [greeting, setGreeting] = useState('');
  const [time, setTime] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hour = now.getHours();

      if (hour < 12) setGreeting('Good Morning');
      else if (hour < 18) setGreeting('Good Afternoon');
      else setGreeting('Good Evening');

      setTime(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const recentConnections = [...connections]
    .sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0))
    .slice(0, 4);

  return (
    <div className="flex-1 h-full flex flex-col p-12 bg-app-bg text-app-text overflow-y-auto w-full relative">
      {/* Go to App Button */}
      {onGoToApp && (
        <button
          onClick={onGoToApp}
          className="absolute top-12 right-12 flex items-center gap-2 px-4 py-2 bg-app-surface/50 hover:bg-app-surface border border-app-border rounded-xl transition-all text-sm font-medium text-app-muted hover:text-app-text"
        >
          <LayoutDashboard size={16} />
          <span>Go to App</span>
        </button>
      )}

      {/* Hero */}
      <div className="mb-12">
        <h1 className="text-4xl font-bold bg-gradient-to-r from-app-text to-app-muted bg-clip-text text-transparent mb-2">
          {greeting}, Operator.
        </h1>
        <div className="flex items-center gap-2 text-app-muted text-lg">
          <Clock size={18} />
          <span>{time}</span>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-6 mb-12">
        <button
          onClick={() => openTab('local')}
          className="group relative p-6 bg-app-surface/30 border border-app-border rounded-2xl hover:bg-app-surface hover:border-app-accent/50 transition-all text-left overflow-hidden col-span-2 md:col-span-1"
        >
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
            <Terminal size={120} />
          </div>
          <div className="relative z-10">
            <div className="w-12 h-12 bg-app-accent/20 rounded-xl flex items-center justify-center text-app-accent mb-4 group-hover:scale-110 transition-transform">
              <Terminal size={24} />
            </div>
            <h3 className="text-xl font-semibold mb-1">Local Terminal</h3>
            <p className="text-sm text-app-muted">Launch a terminal session on this machine.</p>
          </div>
        </button>

        <button
          onClick={() => openAddConnectionModal()}
          className="group relative p-6 bg-app-surface/30 border border-app-border rounded-2xl hover:bg-app-surface hover:border-app-success/50 transition-all text-left overflow-hidden col-span-2 md:col-span-1"
        >
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
            <Server size={120} />
          </div>
          <div className="relative z-10">
            <div className="w-12 h-12 bg-app-success/20 rounded-xl flex items-center justify-center text-app-success mb-4 group-hover:scale-110 transition-transform">
              <Plus size={24} />
            </div>
            <h3 className="text-xl font-semibold mb-1">New Connection</h3>
            <p className="text-sm text-app-muted">Add a new SSH server to your inventory.</p>
          </div>
        </button>
      </div>

      {/* Recent Connections */}
      <div>
        <h2 className="text-lg font-semibold mb-6 flex items-center gap-2">
          <Server size={18} className="text-app-muted" />
          Recent Connections
        </h2>

        {connections.length === 0 ? (
          <div className="text-app-muted italic bg-app-surface/30 p-8 rounded-xl border border-dashed border-app-border text-center">
            No connections saved yet. Add one from the sidebar.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {recentConnections.map((conn) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
              <div
                key={conn.id}
                onClick={() => openTab(conn.id)}
                className="group p-4 bg-app-surface/30 border border-app-border rounded-xl hover:bg-app-surface hover:border-app-border/80 transition-all cursor-pointer relative"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 
                                        ${conn.status === 'connected' ? 'bg-app-success/20 text-app-success' : 'bg-app-text/5 text-app-muted group-hover:text-app-text'}
                                    `}
                  >
                    <Server size={16} />
                  </div>
                  <div className="overflow-hidden">
                    <div className="font-medium truncate text-app-text">{conn.name || conn.host}</div>
                    <div className="text-xs text-app-muted truncate">
                      {conn.username}@{conn.host}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs">
                  <span
                    className={`px-2 py-0.5 rounded-full ${
                      conn.status === 'connected'
                        ? 'bg-app-success/10 text-app-success'
                        : 'bg-app-text/5 text-app-muted'
                    }`}
                  >
                    {conn.status}
                  </span>
                  <span className="text-app-muted opacity-0 group-hover:opacity-100 transition-opacity">
                    Connect &rarr;
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
