import { useState, useEffect } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { Terminal, Server, Plus, Clock, Network } from 'lucide-react';
import { AddTunnelModal } from '../modals/AddTunnelModal';

export function WelcomeScreen() {
    const { connections, openTab, openAddConnectionModal } = useConnections();
    const [greeting, setGreeting] = useState('');
    const [time, setTime] = useState('');
    const [isAddTunnelModalOpen, setIsAddTunnelModalOpen] = useState(false);

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
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))
        .slice(0, 4);

    return (
        <div className="flex-1 h-full flex flex-col p-8 bg-[var(--color-app-bg)] text-[var(--color-app-text)] overflow-y-auto transition-colors duration-200">
            {/* Hero */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold bg-gradient-to-r from-[var(--color-app-text)] to-[var(--color-app-muted)] bg-clip-text text-transparent mb-1">
                    {greeting}
                </h1>
                <div className="flex items-center gap-2 text-[var(--color-app-muted)] text-base">
                    <Clock size={16} />
                    <span>{time}</span>
                </div>
            </div>

            {/* Quick Actions */}
            <div className="grid grid-cols-3 gap-4 mb-8">
                <button
                    onClick={() => openTab('local')}
                    className="group relative p-4 bg-[var(--color-app-panel)] border border-[var(--color-app-border)] rounded-xl hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-accent)] transition-all text-left overflow-hidden shadow-sm hover:shadow-md flex flex-col items-start h-32"
                >
                    <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.08] transition-opacity">
                        <Terminal size={80} />
                    </div>
                    <div className="relative z-10 flex-1 flex flex-col">
                        <div className="w-8 h-8 bg-[var(--color-app-accent)]/10 rounded-lg flex items-center justify-center text-[var(--color-app-accent)] mb-3 group-hover:scale-110 transition-transform">
                            <Terminal size={16} />
                        </div>
                        <h3 className="text-lg font-semibold mb-0.5 text-[var(--color-app-text)]">Local Terminal</h3>
                        <p className="text-xs text-[var(--color-app-muted)] line-clamp-2">Launch session on local machine.</p>
                    </div>
                </button>

                <button
                    onClick={() => openAddConnectionModal()}
                    className="group relative p-4 bg-[var(--color-app-panel)] border border-[var(--color-app-border)] rounded-xl hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-success)] transition-all text-left overflow-hidden shadow-sm hover:shadow-md flex flex-col items-start h-32"
                >
                    <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.08] transition-opacity">
                        <Server size={80} />
                    </div>
                    <div className="relative z-10 flex-1 flex flex-col">
                        <div className="w-8 h-8 bg-[var(--color-app-success)]/10 rounded-lg flex items-center justify-center text-[var(--color-app-success)] mb-3 group-hover:scale-110 transition-transform">
                            <Plus size={16} />
                        </div>
                        <h3 className="text-lg font-semibold mb-0.5 text-[var(--color-app-text)]">New Connection</h3>
                        <p className="text-xs text-[var(--color-app-muted)] line-clamp-2">Add a new SSH server.</p>
                    </div>
                </button>

                <button
                    onClick={() => setIsAddTunnelModalOpen(true)}
                    className="group relative p-4 bg-[var(--color-app-panel)] border border-[var(--color-app-border)] rounded-xl hover:bg-[var(--color-app-surface)] hover:border-blue-500 transition-all text-left overflow-hidden shadow-sm hover:shadow-md flex flex-col items-start h-32"
                >
                    <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.08] transition-opacity">
                        <Network size={80} />
                    </div>
                    <div className="relative z-10 flex-1 flex flex-col">
                        <div className="w-8 h-8 bg-blue-500/10 rounded-lg flex items-center justify-center text-blue-500 mb-3 group-hover:scale-110 transition-transform">
                            <Network size={16} />
                        </div>
                        <h3 className="text-lg font-semibold mb-0.5 text-[var(--color-app-text)]">New Tunnel</h3>
                        <p className="text-xs text-[var(--color-app-muted)] line-clamp-2">Create local/remote tunnel.</p>
                    </div>
                </button>
            </div>

            <AddTunnelModal
                isOpen={isAddTunnelModalOpen}
                onClose={() => setIsAddTunnelModalOpen(false)}
            />

            {/* Recent Connections */}
            <div>
                <h2 className="text-sm font-semibold mb-4 flex items-center gap-2 text-[var(--color-app-text)] uppercase tracking-wider opacity-90">
                    <Server size={14} className="text-[var(--color-app-muted)]" />
                    Recent Connections
                </h2>

                {connections.length === 0 ? (
                    <div className="text-[var(--color-app-muted)] text-sm italic bg-[var(--color-app-panel)]/30 p-6 rounded-xl border border-dashed border-[var(--color-app-border)] text-center">
                        No connections saved yet. Add one from the sidebar.
                    </div>
                ) : (
                    <div className="grid grid-cols-4 gap-3">
                        {recentConnections.map(conn => (
                            <div
                                key={conn.id}
                                onClick={() => openTab(conn.id)}
                                className="group p-3 bg-[var(--color-app-panel)] border border-[var(--color-app-border)] rounded-lg hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-border)] hover:ring-1 hover:ring-[var(--color-app-border)] transition-all cursor-pointer relative shadow-sm"
                            >
                                <div className="flex items-center gap-3 mb-2">
                                    <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 
                                        ${conn.status === 'connected' ? 'bg-[var(--color-app-success)]/10 text-[var(--color-app-success)]' : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)] group-hover:text-[var(--color-app-text)]'}
                                    `}>
                                        <Server size={14} />
                                    </div>
                                    <div className="overflow-hidden min-w-0">
                                        <div className="font-medium truncate text-[var(--color-app-text)] text-sm">{conn.name || conn.host}</div>
                                        <div className="text-[10px] text-[var(--color-app-muted)] truncate">{conn.username}@{conn.host}</div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between text-[10px]">
                                    <span className={`px-1.5 py-0.5 rounded-full ${conn.status === 'connected' ? 'bg-[var(--color-app-success)]/10 text-[var(--color-app-success)]' : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
                                        }`}>
                                        {conn.status}
                                    </span>
                                    {conn.lastConnected && (
                                        <span className="text-[var(--color-app-muted)] opacity-70">
                                            {new Date(conn.lastConnected).toLocaleDateString()}
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
