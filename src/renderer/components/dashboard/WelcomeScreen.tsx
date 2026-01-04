import { useState, useEffect } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { Terminal, Server, Plus, Clock } from 'lucide-react';

export function WelcomeScreen() {
    const { connections, openTab } = useConnections();
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
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))
        .slice(0, 4);

    return (
        <div className="flex-1 h-full flex flex-col p-12 bg-[var(--color-app-bg)] text-[var(--color-app-text)] overflow-y-auto transition-colors duration-200">
            {/* Hero */}
            <div className="mb-12">
                <h1 className="text-4xl font-bold bg-gradient-to-r from-[var(--color-app-text)] to-[var(--color-app-muted)] bg-clip-text text-transparent mb-2">
                    {greeting}, Operator.
                </h1>
                <div className="flex items-center gap-2 text-[var(--color-app-muted)] text-lg">
                    <Clock size={18} />
                    <span>{time}</span>
                </div>
            </div>

            {/* Quick Actions */}
            <div className="grid grid-cols-2 gap-6 mb-12">
                <button
                    onClick={() => openTab('local')}
                    className="group relative p-6 bg-[var(--color-app-panel)] border border-[var(--color-app-border)] rounded-2xl hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-accent)] transition-all text-left overflow-hidden shadow-lg"
                >
                    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
                        <Terminal size={120} />
                    </div>
                    <div className="relative z-10">
                        <div className="w-12 h-12 bg-[var(--color-app-accent)]/10 rounded-xl flex items-center justify-center text-[var(--color-app-accent)] mb-4 group-hover:scale-110 transition-transform">
                            <Terminal size={24} />
                        </div>
                        <h3 className="text-xl font-semibold mb-1 text-[var(--color-app-text)]">Local Terminal</h3>
                        <p className="text-sm text-[var(--color-app-muted)]">Launch a terminal session on this machine.</p>
                    </div>
                </button>

                <button
                    onClick={() => document.getElementById('new-connection-trigger')?.click()}
                    className="group relative p-6 bg-[var(--color-app-panel)] border border-[var(--color-app-border)] rounded-2xl hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-success)] transition-all text-left overflow-hidden shadow-lg"
                >
                    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
                        <Server size={120} />
                    </div>
                    <div className="relative z-10">
                        <div className="w-12 h-12 bg-[var(--color-app-success)]/10 rounded-xl flex items-center justify-center text-[var(--color-app-success)] mb-4 group-hover:scale-110 transition-transform">
                            <Plus size={24} />
                        </div>
                        <h3 className="text-xl font-semibold mb-1 text-[var(--color-app-text)]">New Connection</h3>
                        <p className="text-sm text-[var(--color-app-muted)]">Add a new SSH server to your inventory.</p>
                        <p className="text-xs text-[var(--color-app-muted)] mt-2 italic opacity-70">(Use sidebar + button)</p>
                    </div>
                </button>
            </div>

            {/* Recent Connections */}
            <div>
                <h2 className="text-lg font-semibold mb-6 flex items-center gap-2 text-[var(--color-app-text)]">
                    <Server size={18} className="text-[var(--color-app-muted)]" />
                    Recent Connections
                </h2>

                {connections.length === 0 ? (
                    <div className="text-[var(--color-app-muted)] italic bg-[var(--color-app-panel)]/30 p-8 rounded-xl border border-dashed border-[var(--color-app-border)] text-center">
                        No connections saved yet. Add one from the sidebar.
                    </div>
                ) : (
                    <div className="grid grid-cols-3 gap-4">
                        {recentConnections.map(conn => (
                            <div
                                key={conn.id}
                                onClick={() => openTab(conn.id)}
                                className="group p-4 bg-[var(--color-app-panel)] border border-[var(--color-app-border)] rounded-xl hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-border)] hover:ring-1 hover:ring-[var(--color-app-border)] transition-all cursor-pointer relative shadow-sm"
                            >
                                <div className="flex items-center gap-3 mb-3">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 
                                        ${conn.status === 'connected' ? 'bg-[var(--color-app-success)]/10 text-[var(--color-app-success)]' : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)] group-hover:text-[var(--color-app-text)]'}
                                    `}>
                                        <Server size={16} />
                                    </div>
                                    <div className="overflow-hidden">
                                        <div className="font-medium truncate text-[var(--color-app-text)]">{conn.name || conn.host}</div>
                                        <div className="text-xs text-[var(--color-app-muted)] truncate">{conn.username}@{conn.host}</div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between text-xs">
                                    <span className={`px-2 py-0.5 rounded-full ${conn.status === 'connected' ? 'bg-[var(--color-app-success)]/10 text-[var(--color-app-success)]' : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
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
