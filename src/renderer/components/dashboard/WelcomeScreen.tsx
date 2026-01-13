import { useState, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Terminal, Plus, Network, Key, Lock, FileKey, Monitor, FolderOpen } from 'lucide-react';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { OSIcon } from '../icons/OSIcon';
import { motion } from 'framer-motion';

export function WelcomeScreen() {
    const connections = useAppStore(state => state.connections);
    const openTab = useAppStore(state => state.openTab);
    const setAddConnectionModalOpen = useAppStore(state => state.setAddConnectionModalOpen);
    const openAddConnectionModal = () => setAddConnectionModalOpen(true);
    const addConnection = useAppStore(state => state.addConnection);
    const [greeting, setGreeting] = useState('');
    const [time, setTime] = useState('');
    const [isAddTunnelModalOpen, setIsAddTunnelModalOpen] = useState(false);

    // Quick Connect State
    const [quickConnectInput, setQuickConnectInput] = useState('');
    const [password, setPassword] = useState('');
    const [port, setPort] = useState('');
    const [privateKeyPath, setPrivateKeyPath] = useState('');
    const [isAuthExpanded, setIsAuthExpanded] = useState(false);
    const [saveConnection, setSaveConnection] = useState(false);

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

    const handleBrowseKey = async () => {
        try {
            const result = await window.ipcRenderer.invoke('dialog:openFile');
            if (!result.canceled && result.filePaths.length > 0) {
                setPrivateKeyPath(result.filePaths[0]);
            }
        } catch (error) {
            console.error('Failed to open file dialog:', error);
        }
    };

    const handleQuickConnect = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!quickConnectInput.trim()) return;

        // Parse user@host:port
        // Regex to match optional user, host, and optional port
        // Formats: user@host, user@host:port, host:port, host

        let username = 'root';
        let host = '';
        let parsedPort = 22;

        let input = quickConnectInput.trim();

        // Check for user@
        if (input.includes('@')) {
            const parts = input.split('@');
            username = parts[0];
            input = parts[1];
        }

        // Check for :port
        if (input.includes(':')) {
            const parts = input.split(':');
            host = parts[0];
            parsedPort = parseInt(parts[1], 10) || 22;
        } else {
            host = input;
        }

        if (!host) return;

        // Use explicit port if provided, otherwise parsed port
        const finalPort = port ? parseInt(port, 10) : parsedPort;

        const newConnId = saveConnection ? crypto.randomUUID() : `temp-${crypto.randomUUID()}`;
        const newConn = {
            id: newConnId,
            name: `${username}@${host}`,
            host,
            username,
            port: finalPort,
            password: password || undefined,
            privateKeyPath: privateKeyPath || undefined,
            status: 'disconnected' as const,
            createdAt: Date.now()
        };

        // If not saving, isTemp = true
        addConnection(newConn, !saveConnection);
        openTab(newConnId);
    };

    const recentConnections = [...connections]
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))
        .slice(0, 4);

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.1
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 10 },
        visible: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            initial="hidden"
            animate="visible"
            variants={containerVariants}
            className="flex-1 h-full flex flex-col p-10 bg-app-bg text-app-text overflow-y-auto"
        >
            {/* Hero */}
            <motion.div variants={itemVariants} className="mb-10">
                <h1 className="text-4xl font-light text-app-text tracking-tight mb-2">
                    {greeting}
                </h1>
                <div className="flex items-center gap-2 text-app-muted text-lg font-light opacity-80">
                    <span>{time}</span>
                </div>
            </motion.div>

            {/* Quick Connect */}
            <motion.div variants={itemVariants} className="mb-10 max-w-2xl">
                <form onSubmit={handleQuickConnect} className="relative group flex flex-col gap-2">
                    <div className="flex items-center bg-app-panel/50 border border-app-border rounded-xl p-2 focus-within:border-app-accent focus-within:ring-1 focus-within:ring-app-accent transition-all shadow-sm">
                        <Terminal size={18} className="text-app-muted ml-3 mr-3 shrink-0" />
                        <input
                            type="text"
                            value={quickConnectInput}
                            onChange={(e) => setQuickConnectInput(e.target.value)}
                            placeholder="user@host:port (e.g. root@192.168.1.5)"
                            className="flex-1 bg-transparent border-none outline-none text-app-text placeholder:text-app-muted/50 font-mono text-sm h-10 w-full"
                        />

                        <div className="flex items-center gap-2 pr-2 shrink-0">
                            <button
                                type="button"
                                onClick={() => setIsAuthExpanded(!isAuthExpanded)}
                                className={`p-1.5 rounded-lg transition-colors ${isAuthExpanded || password || privateKeyPath
                                    ? 'bg-app-accent/10 text-app-accent'
                                    : 'text-app-muted hover:text-app-text hover:bg-app-surface'
                                    }`}
                                title="Add Authentication (Password/Key)"
                            >
                                <Key size={16} />
                            </button>

                            <div className="w-px h-6 bg-app-border mx-1" />

                            <label className="flex items-center gap-2 text-xs text-app-muted cursor-pointer hover:text-app-text transition-colors select-none px-2 py-1 rounded hover:bg-app-surface">
                                <input
                                    type="checkbox"
                                    checked={saveConnection}
                                    onChange={(e) => setSaveConnection(e.target.checked)}
                                    className="accent-app-accent"
                                />
                                <span>Save</span>
                            </label>
                            <button
                                type="submit"
                                disabled={!quickConnectInput}
                                className="bg-app-accent text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                Connect
                            </button>
                        </div>
                    </div>

                    {/* Expandable Auth Fields */}
                    {isAuthExpanded && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="bg-app-panel/30 border border-app-border rounded-xl p-4 grid grid-cols-2 gap-4"
                        >
                            <div className="relative col-span-2 sm:col-span-1">
                                <Lock size={14} className="absolute left-3 top-3 text-app-muted" />
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="Password (optional)"
                                    className="w-full bg-app-surface border border-app-border rounded-lg pl-9 pr-3 py-2 text-sm text-app-text placeholder:text-app-muted/50 focus:border-app-accent outline-none transition-colors"
                                />
                            </div>

                            <div className="relative col-span-2 sm:col-span-1">
                                <Monitor size={14} className="absolute left-3 top-3 text-app-muted" />
                                <input
                                    type="number"
                                    value={port}
                                    onChange={(e) => setPort(e.target.value)}
                                    placeholder="Port (22)"
                                    className="w-full bg-app-surface border border-app-border rounded-lg pl-9 pr-3 py-2 text-sm text-app-text placeholder:text-app-muted/50 focus:border-app-accent outline-none transition-colors"
                                />
                            </div>

                            <div className="relative col-span-2">
                                <div className="relative flex gap-2">
                                    <div className="relative flex-1">
                                        <FileKey size={14} className="absolute left-3 top-3 text-app-muted" />
                                        <input
                                            type="text"
                                            value={privateKeyPath}
                                            onChange={(e) => setPrivateKeyPath(e.target.value)}
                                            placeholder="Private Key Path (optional)"
                                            className="w-full bg-app-surface border border-app-border rounded-lg pl-9 pr-3 py-2 text-sm text-app-text placeholder:text-app-muted/50 focus:border-app-accent outline-none transition-colors"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleBrowseKey}
                                        className="px-3 py-2 bg-app-surface border border-app-border rounded-lg text-app-text hover:border-app-accent hover:text-app-accent transition-colors"
                                        title="Browse for Private Key"
                                    >
                                        <FolderOpen size={16} />
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </form>
            </motion.div>

            {/* Quick Actions */}
            <motion.div variants={itemVariants} className="grid grid-cols-3 gap-6 mb-12">
                <button
                    onClick={() => openTab('local')}
                    className="group p-6 bg-app-panel/50 border border-app-border rounded-xl hover:border-app-accent hover:bg-app-panel transition-all text-left shadow-sm hover:shadow"
                >
                    <div className="flex items-start justify-between mb-4">
                        <div className="w-10 h-10 bg-app-surface rounded-lg flex items-center justify-center text-app-accent group-hover:scale-105 transition-transform">
                            <Terminal size={20} strokeWidth={1.5} />
                        </div>
                    </div>
                    <div>
                        <h3 className="text-base font-medium text-app-text mb-1">Local Terminal</h3>
                        <p className="text-sm text-app-muted font-light">Launch session on local machine.</p>
                    </div>
                </button>

                <button
                    onClick={() => openAddConnectionModal()}
                    className="group p-6 bg-app-panel/50 border border-app-border rounded-xl hover:border-green-500/50 hover:bg-app-panel transition-all text-left shadow-sm hover:shadow"
                >
                    <div className="flex items-start justify-between mb-4">
                        <div className="w-10 h-10 bg-app-surface rounded-lg flex items-center justify-center text-green-500 group-hover:scale-105 transition-transform">
                            <Plus size={20} strokeWidth={1.5} />
                        </div>
                    </div>
                    <div>
                        <h3 className="text-base font-medium text-app-text mb-1">New Connection</h3>
                        <p className="text-sm text-app-muted font-light">Add a new SSH server.</p>
                    </div>
                </button>

                <button
                    onClick={() => setIsAddTunnelModalOpen(true)}
                    className="group p-6 bg-app-panel/50 border border-app-border rounded-xl hover:border-blue-500/50 hover:bg-app-panel transition-all text-left shadow-sm hover:shadow"
                >
                    <div className="flex items-start justify-between mb-4">
                        <div className="w-10 h-10 bg-app-surface rounded-lg flex items-center justify-center text-blue-500 group-hover:scale-105 transition-transform">
                            <Network size={20} strokeWidth={1.5} />
                        </div>
                    </div>
                    <div>
                        <h3 className="text-base font-medium text-app-text mb-1">New Tunnel</h3>
                        <p className="text-sm text-app-muted font-light">Create local/remote tunnel.</p>
                    </div>
                </button>
            </motion.div>

            <AddTunnelModal
                isOpen={isAddTunnelModalOpen}
                onClose={() => setIsAddTunnelModalOpen(false)}
            />

            {/* Recent Connections */}
            <motion.div variants={itemVariants}>
                <h2 className="text-xs font-semibold mb-6 flex items-center gap-2 text-app-muted uppercase tracking-widest opacity-80">
                    Recent Connections
                </h2>

                {connections.length === 0 ? (
                    <div className="text-app-muted text-sm font-light bg-app-panel/30 p-8 rounded-xl border border-dashed border-app-border text-center">
                        No connections saved yet. Add one to get started.
                    </div>
                ) : (
                    <div className="grid grid-cols-4 gap-4">
                        {recentConnections.map(conn => (
                            <div
                                key={conn.id}
                                onClick={() => openTab(conn.id)}
                                className="group p-4 bg-app-panel/30 border border-app-border rounded-lg hover:border-app-accent/50 hover:bg-app-panel transition-all cursor-pointer relative"
                            >
                                <div className="flex items-center gap-3 mb-3">
                                    <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors
                                        ${conn.status === 'connected'
                                            ? 'bg-green-500/10 text-green-500'
                                            : 'bg-app-surface text-app-muted group-hover:text-app-text'}
                                    `}>
                                        <OSIcon icon={conn.icon || 'Server'} className="w-4 h-4" />
                                    </div>
                                    <div className="overflow-hidden min-w-0">
                                        <div className="font-medium truncate text-app-text text-sm mb-0.5">{conn.name || conn.host}</div>
                                        <div className="text-xs text-app-muted truncate font-light opacity-80">{conn.username}@{conn.host}</div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between">
                                    <div className={`w-1.5 h-1.5 rounded-full ${conn.status === 'connected' ? 'bg-green-500' : 'bg-app-muted/30'}`} />
                                    {conn.lastConnected && (
                                        <span className="text-[10px] text-app-muted font-light opacity-60">
                                            {new Date(conn.lastConnected).toLocaleDateString()}
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
}
