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
        <div className="flex-1 h-full flex flex-col p-12 bg-[#0f111a] text-white overflow-y-auto">
            {/* Hero */}
            <div className="mb-12">
                <h1 className="text-4xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent mb-2">
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
                    className="group relative p-6 bg-[#1e293b]/50 border border-white/5 rounded-2xl hover:bg-[#1e293b] hover:border-[#6366f1]/50 transition-all text-left overflow-hidden"
                >
                    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
                        <Terminal size={120} />
                    </div>
                    <div className="relative z-10">
                        <div className="w-12 h-12 bg-[#6366f1]/20 rounded-xl flex items-center justify-center text-[#6366f1] mb-4 group-hover:scale-110 transition-transform">
                            <Terminal size={24} />
                        </div>
                        <h3 className="text-xl font-semibold mb-1">Local Terminal</h3>
                        <p className="text-sm text-gray-400">Launch a terminal session on this machine.</p>
                    </div>
                </button>

                <button
                    onClick={() => document.getElementById('new-connection-trigger')?.click()}
                    // This is a bit hacky, but the "New Connection" modal state is in Sidebar. 
                    // Ideally we'd expose that state or move it to context.
                    // For now, I'll just make this a placeholder or trigger via Context if I refactor.
                    // Actually, let's just make it a visual placeholder or quick-connect to first server.
                    // Better: Just show "Saved Connections" below and maybe a distinct "Manage Hosts" button?
                    // Let's repurpose this to "Connect to X" or just remove the second big card if unused.
                    // I'll make it "Connect to Jump Server" or similar if we have one.
                    // Let's stick to "New Connection" concept but maybe just tell them to use Sidebar + button.
                    // OR: I can dispatch a custom event? 
                    // Let's leave it as a "Explore" card.
                    className="group relative p-6 bg-[#1e293b]/50 border border-white/5 rounded-2xl hover:bg-[#1e293b] hover:border-emerald-500/50 transition-all text-left overflow-hidden"
                >
                    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
                        <Server size={120} />
                    </div>
                    <div className="relative z-10">
                        <div className="w-12 h-12 bg-emerald-500/20 rounded-xl flex items-center justify-center text-emerald-500 mb-4 group-hover:scale-110 transition-transform">
                            <Plus size={24} />
                        </div>
                        <h3 className="text-xl font-semibold mb-1">New Connection</h3>
                        <p className="text-sm text-gray-400">Add a new SSH server to your inventory.</p>
                        <p className="text-xs text-app-muted mt-2 italic">(Use sidebar + button)</p>
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
                    <div className="text-app-muted italic bg-[#1e293b]/30 p-8 rounded-xl border border-dashed border-white/5 text-center">
                        No connections saved yet. Add one from the sidebar.
                    </div>
                ) : (
                    <div className="grid grid-cols-3 gap-4">
                        {recentConnections.map(conn => (
                            <div
                                key={conn.id}
                                onClick={() => openTab(conn.id)}
                                className="group p-4 bg-[#1e293b]/30 border border-white/5 rounded-xl hover:bg-[#1e293b] hover:border-white/20 transition-all cursor-pointer relative"
                            >
                                <div className="flex items-center gap-3 mb-3">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 
                                        ${conn.status === 'connected' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-white/5 text-gray-400 group-hover:text-white'}
                                    `}>
                                        <Server size={16} />
                                    </div>
                                    <div className="overflow-hidden">
                                        <div className="font-medium truncate text-white">{conn.name || conn.host}</div>
                                        <div className="text-xs text-gray-500 truncate">{conn.username}@{conn.host}</div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between text-xs">
                                    <span className={`px-2 py-0.5 rounded-full ${conn.status === 'connected' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-white/5 text-gray-500'
                                        }`}>
                                        {conn.status}
                                    </span>
                                    {conn.lastConnected && (
                                        <span className="text-gray-600">
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
