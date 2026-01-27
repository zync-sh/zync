import { useState, useEffect, useRef, MouseEvent } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Terminal, Plus, Network, Key, Lock, FileKey, Monitor, FolderOpen, Star, Sparkles, Command } from 'lucide-react';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { OSIcon } from '../icons/OSIcon';
import { motion, AnimatePresence, useMotionTemplate, useMotionValue } from 'framer-motion';
import { cn } from '../../lib/utils';

// Helper function to get relative time
function getRelativeTime(timestamp: number): string {
    if (!timestamp) return '';
    const now = Date.now();
    const diff = now - timestamp;

    // Handle future dates or incorrect system time
    if (diff < 0) return 'Just now';

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    // Use short date format strictly
    return new Date(timestamp).toLocaleDateString(undefined, {
        month: 'numeric',
        day: 'numeric',
        year: '2-digit'
    });
}

// Connection templates
const CONNECTION_TEMPLATES = [
    { id: 'aws-ec2', name: 'AWS EC2', username: 'ec2-user', port: 22 },
    { id: 'digitalocean', name: 'DigitalOcean', username: 'root', port: 22 },
    { id: 'ubuntu', name: 'Ubuntu Server', username: 'ubuntu', port: 22 },
    { id: 'raspberry-pi', name: 'Raspberry Pi', username: 'pi', port: 22 },
];

function Card({ children, className, onClick }: { children: React.ReactNode, className?: string, onClick?: (e: any) => void }) {
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);

    function handleMouseMove({ currentTarget, clientX, clientY }: MouseEvent) {
        const { left, top } = currentTarget.getBoundingClientRect();
        mouseX.set(clientX - left);
        mouseY.set(clientY - top);
    }

    return (
        <div
            className={cn(
                "group relative border border-app-border/50 bg-app-panel/50 overflow-hidden rounded-lg transition-colors hover:border-app-accent/50",
                className
            )}
            onMouseMove={handleMouseMove}
            onClick={onClick}
        >
            <motion.div
                className="pointer-events-none absolute -inset-px rounded-xl opacity-0 transition duration-300 group-hover:opacity-100"
                style={{
                    background: useMotionTemplate`
            radial-gradient(
              650px circle at ${mouseX}px ${mouseY}px,
              rgba(99, 102, 241, 0.1),
              transparent 80%
            )
          `,
                }}
            />
            <div className="relative h-full">{children}</div>
        </div>
    );
}

export function WelcomeScreen() {
    const connections = useAppStore(state => state.connections);
    const openTab = useAppStore(state => state.openTab);
    const setAddConnectionModalOpen = useAppStore(state => state.setAddConnectionModalOpen);
    const openAddConnectionModal = () => setAddConnectionModalOpen(true);
    const addConnection = useAppStore(state => state.addConnection);
    const toggleFavorite = useAppStore(state => state.toggleFavorite);
    const [greeting, setGreeting] = useState('');
    const [time, setTime] = useState('');
    const [isAddTunnelModalOpen, setIsAddTunnelModalOpen] = useState(false);

    // Detect OS for keyboard shortcut display
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const commandKey = isMac ? '⌘P' : 'Ctrl+P';

    // Quick Connect State
    const [quickConnectInput, setQuickConnectInput] = useState('');
    const [password, setPassword] = useState('');
    const [port, setPort] = useState('');
    const [privateKeyPath, setPrivateKeyPath] = useState('');
    const [isAuthExpanded, setIsAuthExpanded] = useState(false);
    const [saveConnection, setSaveConnection] = useState(true);

    // Autocomplete state
    const [showAutocomplete, setShowAutocomplete] = useState(false);
    const [showTemplates, setShowTemplates] = useState(false);
    const autocompleteRef = useRef<HTMLDivElement>(null);

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

    // Click outside to close autocomplete/templates
    useEffect(() => {
        const handleClickOutside = (e: any) => {
            if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
                setShowAutocomplete(false);
                setShowTemplates(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
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

        let username = 'root';
        let host = '';
        let parsedPort = 22;
        let input = quickConnectInput.trim();

        if (input.includes('@')) {
            const parts = input.split('@');
            username = parts[0];
            input = parts[1];
        }

        if (input.includes(':')) {
            const parts = input.split(':');
            host = parts[0];
            parsedPort = parseInt(parts[1], 10) || 22;
        } else {
            host = input;
        }

        if (!host) return;

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

        addConnection(newConn, !saveConnection);
        openTab(newConnId);
    };

    const handleSelectAutocomplete = (conn: any) => {
        setQuickConnectInput(`${conn.username}@${conn.host}:${conn.port}`);
        setShowAutocomplete(false);
        openTab(conn.id);
    };

    const handleSelectTemplate = (template: typeof CONNECTION_TEMPLATES[0]) => {
        setQuickConnectInput(template.username + '@');
        setPort(template.port.toString());
        setShowTemplates(false);
    };

    const handleCommandPalette = () => {
        // Trigger command palette
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'p',
            ctrlKey: true,
            metaKey: true
        }));
    };

    // Filter autocomplete suggestions
    const autocompleteSuggestions = connections.filter(c =>
        quickConnectInput && (
            c.name?.toLowerCase().includes(quickConnectInput.toLowerCase()) ||
            c.host.toLowerCase().includes(quickConnectInput.toLowerCase()) ||
            c.username.toLowerCase().includes(quickConnectInput.toLowerCase())
        )
    ).slice(0, 5);

    // Separate favorites and recent
    const favoriteConnections = connections
        .filter(c => c.isFavorite)
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))
        .slice(0, 5);

    const recentConnections = connections
        .filter(c => !c.isFavorite)
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))
        .slice(0, 5);

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.05
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 5 },
        visible: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            initial="hidden"
            animate="visible"
            variants={containerVariants}
            className="flex-1 h-full flex flex-col p-8 bg-app-bg text-app-text overflow-y-auto relative isolate"
        >
            {/* Dot Grid Background */}
            <div className="absolute inset-0 -z-10 h-full w-full bg-app-bg bg-[radial-gradient(#2a2d3d_1px,transparent_1px)] [background-size:16px_16px] [mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-30"></div>

            {/* Compact Header - Greeting + Time */}
            <motion.div variants={itemVariants} className="mb-6">
                <div className="flex items-baseline gap-3">
                    <h1 className="text-3xl font-light text-app-text tracking-tight">
                        {greeting}
                    </h1>
                    <span className="text-sm text-app-muted/60 font-mono">{time}</span>
                </div>
            </motion.div>

            {/* Quick Connect */}
            <motion.div variants={itemVariants} className="mb-6 max-w-2xl relative" ref={autocompleteRef}>
                <form onSubmit={handleQuickConnect} className="relative group flex flex-col gap-2">
                    <div className="flex items-center bg-app-panel/80 backdrop-blur-sm border border-app-border/50 rounded-lg p-2 focus-within:border-app-accent transition-all shadow-sm">
                        <Terminal size={16} className="text-app-muted ml-2 mr-2 shrink-0" />
                        <input
                            type="text"
                            value={quickConnectInput}
                            onChange={(e) => {
                                setQuickConnectInput(e.target.value);
                                setShowAutocomplete(e.target.value.length > 0);
                            }}
                            onFocus={() => quickConnectInput && setShowAutocomplete(true)}
                            placeholder="user@host:port (e.g. root@192.168.1.5)"
                            className="flex-1 bg-transparent border-none outline-none text-app-text placeholder:text-app-muted/40 font-mono text-sm h-8 w-full"
                        />

                        <div className="flex items-center gap-1 pr-1 shrink-0">
                            <button
                                type="button"
                                onClick={() => setShowTemplates(!showTemplates)}
                                className="p-1.5 rounded transition-all text-app-muted hover:text-app-accent hover:bg-app-accent/10"
                                title="Templates"
                            >
                                <Sparkles size={14} />
                            </button>

                            <button
                                type="button"
                                onClick={() => setIsAuthExpanded(!isAuthExpanded)}
                                className={`p-1.5 rounded transition-all ${isAuthExpanded || password || privateKeyPath
                                    ? 'bg-app-accent/10 text-app-accent'
                                    : 'text-app-muted hover:text-app-text hover:bg-app-surface'
                                    }`}
                                title="Auth"
                            >
                                <Key size={14} />
                            </button>

                            <label className="flex items-center gap-1.5 text-xs text-app-muted cursor-pointer hover:text-app-text transition-colors select-none px-2 py-1 rounded hover:bg-app-surface">
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
                                className="bg-app-accent text-white px-4 py-1.5 rounded text-sm font-medium hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
                            >
                                Connect
                            </button>
                        </div>
                    </div>

                    {/* Templates Dropdown */}
                    <AnimatePresence>
                        {showTemplates && (
                            <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="absolute top-full mt-2 left-0 right-0 bg-app-panel/95 backdrop-blur-xl border border-app-border rounded-lg shadow-xl overflow-hidden z-50"
                            >
                                <div className="p-1.5">
                                    {CONNECTION_TEMPLATES.map(template => (
                                        <button
                                            key={template.id}
                                            onClick={() => handleSelectTemplate(template)}
                                            className="w-full text-left px-2.5 py-2 text-sm text-app-text hover:bg-app-surface rounded transition-colors flex items-center gap-2.5"
                                        >
                                            <Terminal size={12} className="text-app-accent" />
                                            <div>
                                                <div className="font-medium text-xs">{template.name}</div>
                                                <div className="text-[10px] text-app-muted font-mono">{template.username}@host:{template.port}</div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Autocomplete Dropdown */}
                    <AnimatePresence>
                        {showAutocomplete && autocompleteSuggestions.length > 0 && !showTemplates && (
                            <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="absolute top-full mt-2 left-0 right-0 bg-app-panel/95 backdrop-blur-xl border border-app-border rounded-lg shadow-xl overflow-hidden z-50"
                            >
                                <div className="p-1.5">
                                    {autocompleteSuggestions.map(conn => (
                                        <button
                                            key={conn.id}
                                            onClick={() => handleSelectAutocomplete(conn)}
                                            className="w-full text-left px-2.5 py-2 text-sm text-app-text hover:bg-app-surface rounded transition-colors flex items-center gap-2.5"
                                        >
                                            <OSIcon icon={conn.icon || 'Server'} className="w-3.5 h-3.5" />
                                            <div className="flex-1 min-w-0">
                                                <div className="font-medium text-xs truncate">{conn.name || conn.host}</div>
                                                <div className="text-[10px] text-app-muted truncate font-mono">{conn.username}@{conn.host}:{conn.port}</div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Expandable Auth Fields */}
                    <AnimatePresence>
                        {isAuthExpanded && (
                            <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                className="bg-app-panel/30 border border-app-border rounded-lg p-3 grid grid-cols-2 gap-3"
                            >
                                <div className="relative col-span-2 sm:col-span-1">
                                    <Lock size={12} className="absolute left-2.5 top-2.5 text-app-muted" />
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="Password"
                                        className="w-full bg-app-surface border border-app-border rounded pl-8 pr-2.5 py-2 text-sm text-app-text placeholder:text-app-muted/50 focus:border-app-accent outline-none transition-colors"
                                    />
                                </div>

                                <div className="relative col-span-2 sm:col-span-1">
                                    <Monitor size={12} className="absolute left-2.5 top-2.5 text-app-muted" />
                                    <input
                                        type="number"
                                        value={port}
                                        onChange={(e) => setPort(e.target.value)}
                                        placeholder="Port (22)"
                                        className="w-full bg-app-surface border border-app-border rounded pl-8 pr-2.5 py-2 text-sm text-app-text placeholder:text-app-muted/50 focus:border-app-accent outline-none transition-colors font-mono"
                                    />
                                </div>

                                <div className="relative col-span-2">
                                    <div className="relative flex gap-2">
                                        <div className="relative flex-1">
                                            <FileKey size={12} className="absolute left-2.5 top-2.5 text-app-muted" />
                                            <input
                                                type="text"
                                                value={privateKeyPath}
                                                onChange={(e) => setPrivateKeyPath(e.target.value)}
                                                placeholder="Private Key Path"
                                                className="w-full bg-app-surface border border-app-border rounded pl-8 pr-2.5 py-2 text-sm text-app-text placeholder:text-app-muted/50 focus:border-app-accent outline-none transition-colors font-mono"
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleBrowseKey}
                                            className="px-2.5 py-2 bg-app-surface border border-app-border rounded text-app-text hover:border-app-accent hover:text-app-accent transition-colors"
                                        >
                                            <FolderOpen size={14} />
                                        </button>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </form>
            </motion.div>

            {/* Command Palette Button */}
            <motion.div variants={itemVariants} className="mb-6">
                <button
                    onClick={handleCommandPalette}
                    className="flex items-center gap-2 px-4 py-2 bg-app-panel/50 border border-app-border/50 rounded-lg text-sm text-app-muted hover:text-app-text hover:border-app-accent/50 transition-all hover:bg-app-panel/80 hover:shadow-sm"
                >
                    <Command size={14} />
                    <span>Command Palette</span>
                    <kbd className="ml-auto px-2 py-0.5 bg-app-surface border border-app-border rounded text-[10px] font-mono">{commandKey}</kbd>
                </button>
            </motion.div>

            {/* Compact Actions */}
            <motion.div variants={itemVariants} className="flex gap-3 mb-8">
                <Card
                    onClick={() => openTab('local')}
                    className="flex-1 cursor-pointer"
                >
                    <div className="p-4 flex items-center gap-3">
                        <div className="w-9 h-9 bg-app-surface/80 rounded-lg flex items-center justify-center text-app-accent shrink-0 ring-1 ring-inset ring-app-border/20">
                            <Terminal size={16} />
                        </div>
                        <div>
                            <h3 className="text-sm font-medium text-app-text">Local Terminal</h3>
                            <p className="text-xs text-app-muted">Local machine</p>
                        </div>
                    </div>
                </Card>

                <Card
                    onClick={() => openAddConnectionModal()}
                    className="flex-1 cursor-pointer"
                >
                    <div className="p-4 flex items-center gap-3">
                        <div className="w-9 h-9 bg-app-surface/80 rounded-lg flex items-center justify-center text-green-500 shrink-0 ring-1 ring-inset ring-app-border/20">
                            <Plus size={16} />
                        </div>
                        <div>
                            <h3 className="text-sm font-medium text-app-text">New Connection</h3>
                            <p className="text-xs text-app-muted">Add SSH server</p>
                        </div>
                    </div>
                </Card>

                <Card
                    onClick={() => setIsAddTunnelModalOpen(true)}
                    className="flex-1 cursor-pointer"
                >
                    <div className="p-4 flex items-center gap-3">
                        <div className="w-9 h-9 bg-app-surface/80 rounded-lg flex items-center justify-center text-blue-500 shrink-0 ring-1 ring-inset ring-app-border/20">
                            <Network size={16} />
                        </div>
                        <div>
                            <h3 className="text-sm font-medium text-app-text">New Tunnel</h3>
                            <p className="text-xs text-app-muted">Port forwarding</p>
                        </div>
                    </div>
                </Card>
            </motion.div>

            <AddTunnelModal
                isOpen={isAddTunnelModalOpen}
                onClose={() => setIsAddTunnelModalOpen(false)}
            />

            {/* Favorite Connections */}
            {favoriteConnections.length > 0 && (
                <motion.div variants={itemVariants} className="mb-6">
                    <h2 className="text-xs font-semibold mb-3 flex items-center gap-2 text-app-muted uppercase tracking-wider">
                        <Star size={12} className="text-yellow-500 fill-yellow-500" />
                        Favorites
                    </h2>
                    <div className="grid grid-cols-5 gap-3">
                        {favoriteConnections.map(conn => (
                            <Card
                                key={conn.id}
                                className="cursor-pointer border-yellow-500/10 hover:border-yellow-500/30"
                            >
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        toggleFavorite(conn.id);
                                    }}
                                    className="absolute top-2 right-2 p-1 rounded hover:bg-app-surface/50 transition-colors z-20"
                                >
                                    <Star size={12} className="fill-yellow-500 text-yellow-500" />
                                </button>

                                <div onClick={() => openTab(conn.id)} className="p-3 relative z-10">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 transition-all
                                            ${conn.status === 'connected' ? 'bg-green-500/10 text-green-500' : 'bg-app-surface text-app-muted'}
                                        `}>
                                            <OSIcon icon={conn.icon || 'Server'} className="w-4 h-4" />
                                        </div>
                                    </div>
                                    <div className="mb-2">
                                        <div className="font-medium truncate text-app-text text-xs mb-0.5">{conn.name || conn.host}</div>
                                        <div className="text-[10px] text-app-muted truncate font-mono">{conn.username}@{conn.host}</div>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <div className={`w-1.5 h-1.5 rounded-full ${conn.status === 'connected' ? 'bg-green-500' : 'bg-app-muted/30'}`} />
                                        {conn.lastConnected && (
                                            <span className="text-[9px] text-app-muted font-mono truncate ml-2">
                                                {getRelativeTime(conn.lastConnected)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                </motion.div>
            )}

            {/* Recent Connections */}
            <motion.div variants={itemVariants}>
                <h2 className="text-xs font-semibold mb-3 flex items-center gap-2 text-app-muted uppercase tracking-wider">
                    Recent Connections
                </h2>

                {connections.length === 0 ? (
                    <div className="bg-app-panel/50 p-8 rounded-lg border border-dashed border-app-border/50 text-center">
                        <div className="w-16 h-16 bg-app-surface/50 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Terminal size={24} className="text-app-muted" />
                        </div>
                        <h3 className="text-sm font-medium text-app-text mb-2">No Connections Yet</h3>
                        <p className="text-xs text-app-muted mb-4">
                            Get started by adding your first SSH connection.
                        </p>
                        <button
                            onClick={() => openAddConnectionModal()}
                            className="px-4 py-2 bg-app-accent text-white rounded text-sm font-medium hover:brightness-110 transition-all font-mono"
                        >
                            Add Connection
                        </button>
                    </div>
                ) : recentConnections.length > 0 ? (
                    <div className="grid grid-cols-5 gap-3">
                        {recentConnections.map(conn => (
                            <Card
                                key={conn.id}
                                className="cursor-pointer"
                            >
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        toggleFavorite(conn.id);
                                    }}
                                    className="absolute top-2 right-2 p-1 rounded hover:bg-app-surface/50 transition-colors z-20"
                                >
                                    <Star size={12} className="text-app-muted" />
                                </button>

                                <div onClick={() => openTab(conn.id)} className="p-3 relative z-10">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 transition-all
                                            ${conn.status === 'connected' ? 'bg-green-500/10 text-green-500' : 'bg-app-surface text-app-muted'}
                                        `}>
                                            <OSIcon icon={conn.icon || 'Server'} className="w-4 h-4" />
                                        </div>
                                    </div>
                                    <div className="mb-2">
                                        <div className="font-medium truncate text-app-text text-xs mb-0.5">{conn.name || conn.host}</div>
                                        <div className="text-[10px] text-app-muted truncate font-mono">{conn.username}@{conn.host}</div>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <div className={`w-1.5 h-1.5 rounded-full ${conn.status === 'connected' ? 'bg-green-500' : 'bg-app-muted/30'}`} />
                                        {conn.lastConnected && (
                                            <span className="text-[9px] text-app-muted font-mono truncate ml-2">
                                                {getRelativeTime(conn.lastConnected)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                ) : (
                    <div className="text-center py-6 text-sm text-app-muted">
                        No recent connections. All connections are favorited.
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
}
