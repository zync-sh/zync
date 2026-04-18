import {
    useState,
    useRef,
    useId,
    useEffect,
    useMemo,
    type KeyboardEvent,
    type FormEvent,
    type ClipboardEvent,
} from 'react';
import { Key, Sparkles, CornerDownLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../../lib/utils';
import type { Connection } from '../../../store/connectionSlice';
import { useAppStore } from '../../../store/useAppStore';
import { AuthPanel } from './quick-connect/AuthPanel';
import { SuggestionsDropdown } from './quick-connect/SuggestionsDropdown';
import { TemplatesDropdown, type ConnectionTemplate } from './quick-connect/TemplatesDropdown';
import { parseConnectionString, parsePort, parseSSHCommand } from './quick-connect/parsing';

const ipc: Window['ipcRenderer'] | undefined = typeof window !== 'undefined' ? window.ipcRenderer : undefined;

const CONNECTION_TEMPLATES: readonly ConnectionTemplate[] = [
    { id: 'aws-ec2',      name: 'AWS EC2',       username: 'ec2-user', port: 22 },
    { id: 'digitalocean', name: 'DigitalOcean',  username: 'root',     port: 22 },
    { id: 'ubuntu',       name: 'Ubuntu Server', username: 'ubuntu',   port: 22 },
    { id: 'raspberry-pi', name: 'Raspberry Pi',  username: 'pi',       port: 22 },
] as const;

interface QuickConnectBarProps {
    connections: Connection[];
    onConnect: (
        host: string,
        username: string,
        port: number,
        password?: string,
        privateKeyPath?: string,
        save?: boolean,
    ) => void;
    onSelectExisting: (id: string) => void;
}

/** Inline quick-connect control with suggestions, templates, and auth options. */
export function QuickConnectBar({ connections, onConnect, onSelectExisting }: QuickConnectBarProps) {
    const showToast = useAppStore(state => state.showToast);
    const [input,          setInput]          = useState('');
    const [password,       setPassword]       = useState('');
    const [portOverride,   setPortOverride]   = useState('');
    const [privateKeyPath, setPrivateKeyPath] = useState('');
    const [isAuthOpen,     setIsAuthOpen]     = useState(false);
    const [saveConn,       setSaveConn]       = useState(true);
    const [showTemplates,  setShowTemplates]  = useState(false);
    const [templateFocusIndex, setTemplateFocusIndex] = useState(0);
    const [activeIndex,    setActiveIndex]    = useState(-1);
    const [error,          setError]          = useState('');
    const [isFocused,      setIsFocused]      = useState(false);

    const inputRef     = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const templateItemRefs = useRef<Array<HTMLLIElement | null>>([]);
    const listboxId    = useId();

    const suggestions = useMemo(() => (
        input.trim()
            ? connections
                .filter(c =>
                    c.name?.toLowerCase().includes(input.toLowerCase()) ||
                    c.host.toLowerCase().includes(input.toLowerCase()) ||
                    c.username.toLowerCase().includes(input.toLowerCase())
                )
                .slice(0, 6)
            : []
    ), [input, connections]);

    const recentConnections = useMemo(() => (
        !input.trim()
            ? [...connections]
                .filter(c => c.lastConnected)
                .sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0))
                .slice(0, 5)
            : []
    ), [input, connections]);

    const showSuggestions = suggestions.length > 0 && !showTemplates;
    const showRecents     = isFocused && !input.trim() && recentConnections.length > 0 && !showTemplates;
    const showDropdown    = showSuggestions || showRecents;
    const dropItems       = showSuggestions ? suggestions : recentConnections;

    // Live parse preview — shown when we have a valid parse but no dropdown/error
    const parsedPreview = useMemo(
        () => (input.trim() ? parseConnectionString(input) : null),
        [input],
    );
    const previewPort = useMemo(
        () => (parsedPreview
            ? (portOverride ? (parsePort(portOverride) ?? parsedPreview.port) : parsedPreview.port)
            : null),
        [parsedPreview, portOverride],
    );
    const showPreview = Boolean(parsedPreview && !error && !showDropdown);

    // ── Ctrl/Cmd+L focuses the input ───────────────────────────────────
    useEffect(() => {
        function onKey(e: globalThis.KeyboardEvent) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
                e.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // ── Click-outside closes dropdowns ────────────────────────────────
    useEffect(() => {
        function onPointerDown(e: PointerEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setShowTemplates(false);
                setTemplateFocusIndex(0);
                setActiveIndex(-1);
                setIsFocused(false);
            }
        }
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, []);

    useEffect(() => {
        if (!showTemplates) return;
        setTemplateFocusIndex(0);
        requestAnimationFrame(() => templateItemRefs.current[0]?.focus());
    }, [showTemplates]);

    function applyTemplate(index: number) {
        const template = CONNECTION_TEMPLATES[index];
        if (!template) return;
        setInput(`${template.username}@`);
        setPortOverride(template.port === 22 ? '' : String(template.port));
        setShowTemplates(false);
        setTemplateFocusIndex(0);
        requestAnimationFrame(() => inputRef.current?.focus());
    }

    function focusTemplate(index: number) {
        const count = CONNECTION_TEMPLATES.length;
        const next = ((index % count) + count) % count;
        setTemplateFocusIndex(next);
        templateItemRefs.current[next]?.focus();
    }

    function handleTemplateKeyDown(e: KeyboardEvent<HTMLUListElement>) {
        if (!showTemplates) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusTemplate(templateFocusIndex + 1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusTemplate(templateFocusIndex - 1);
            return;
        }
        if (e.key === 'Home') {
            e.preventDefault();
            focusTemplate(0);
            return;
        }
        if (e.key === 'End') {
            e.preventDefault();
            focusTemplate(CONNECTION_TEMPLATES.length - 1);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            applyTemplate(templateFocusIndex);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            setShowTemplates(false);
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }

    function handleSubmit(e?: FormEvent) {
        e?.preventDefault();
        setError('');
        const result = parseConnectionString(input);
        if (!result) {
            setError('Enter a valid host — e.g. root@10.0.0.1 or host:2222');
            inputRef.current?.focus();
            return;
        }
        let finalPort = result.port;
        if (portOverride.trim()) {
            const parsedPort = parsePort(portOverride);
            if (parsedPort === null) {
                setError('Port must be between 1 and 65535');
                inputRef.current?.focus();
                return;
            }
            finalPort = parsedPort;
        }
        onConnect(result.host, result.username, finalPort, password || undefined, privateKeyPath || undefined, saveConn);
    }

    function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (showDropdown) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(i => Math.min(i + 1, dropItems.length - 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(i => Math.max(i - 1, -1));
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                if (activeIndex >= 0) {
                    onSelectExisting(dropItems[activeIndex].id);
                } else if (showSuggestions && suggestions.length === 1) {
                    // Only one match — select it directly
                    onSelectExisting(suggestions[0].id);
                } else {
                    handleSubmit();
                }
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setInput('');
                setActiveIndex(-1);
                setIsFocused(false);
                return;
            }
        }
        if (showTemplates && e.key === 'Escape') setShowTemplates(false);
    }

    /** Intercept paste of full `ssh …` commands and auto-fill fields. */
    function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
        const text = e.clipboardData.getData('text');
        if (!text.trim().startsWith('ssh ')) return;
        const result = parseSSHCommand(text);
        if (!result) return;
        e.preventDefault();
        setInput(`${result.username}@${result.host}`);
        if (result.port !== 22) setPortOverride(result.port.toString());
        else setPortOverride('');
        setPassword('');
        if (result.privateKeyPath) {
            setPrivateKeyPath(result.privateKeyPath);
            setIsAuthOpen(true);
        }
        setError('');
    }

    async function handleBrowseKey() {
        if (!ipc) {
            setError('File picker unavailable');
            showToast('error', 'File picker unavailable');
            return;
        }
        try {
            const res = await ipc.invoke('dialog:openFile') as { canceled?: boolean; filePaths?: string[] };
            if (!res.canceled && res.filePaths && res.filePaths.length > 0) setPrivateKeyPath(res.filePaths[0]);
        } catch (error) {
            console.error('[QuickConnectBar] Failed to browse private key path', error);
            setError('Failed to open file picker');
            showToast('error', 'Failed to open file picker');
        }
    }

    const hasAuth = Boolean(password || privateKeyPath);

    return (
        <div ref={containerRef} className="relative w-full">
            <form onSubmit={handleSubmit} noValidate aria-label="Quick connect to an SSH server">
                {/* Terminal prompt bar */}
                <div
                    className={cn(
                        'flex items-center bg-app-surface/50 border rounded-2xl transition-all',
                        error
                            ? 'border-red-500/40 focus-within:border-red-500/60'
                            : 'border-app-border/50 focus-within:border-app-accent/50 focus-within:shadow-[0_0_0_3px_rgba(121,123,206,0.08)]'
                    )}
                >
                    <span className="pl-4 pr-2 font-mono text-base text-app-accent/80 select-none shrink-0" aria-hidden="true">$</span>

                    <input
                        ref={inputRef}
                        type="text"
                        role="combobox"
                        aria-label="SSH connection string"
                        aria-expanded={showDropdown}
                        aria-haspopup="listbox"
                        aria-controls={listboxId}
                        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
                        aria-autocomplete="list"
                        autoComplete="off"
                        spellCheck={false}
                        value={input}
                        onChange={(e) => { setInput(e.target.value); setActiveIndex(-1); setError(''); }}
                        onKeyDown={handleKeyDown}
                        onFocus={() => setIsFocused(true)}
                        onPaste={handlePaste}
                        placeholder="user@host:port"
                        className="flex-1 min-w-0 bg-transparent border-none outline-none font-mono text-sm text-app-text placeholder:text-app-muted/25 py-3.5"
                    />

                    <div className="flex items-center gap-0.5 pr-2 shrink-0">
                        <button
                            type="button"
                            aria-label="Connection templates"
                            aria-expanded={showTemplates}
                            onClick={() => setShowTemplates(v => !v)}
                            onKeyDown={(e) => {
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setShowTemplates(true);
                                    requestAnimationFrame(() => templateItemRefs.current[0]?.focus());
                                }
                            }}
                            className={cn(
                                'p-2 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40',
                                showTemplates ? 'bg-app-panel text-app-text' : 'text-app-muted/50 hover:text-app-muted hover:bg-app-panel/60'
                            )}
                        >
                            <Sparkles size={13} />
                        </button>

                        <button
                            type="button"
                            aria-label="Authentication options"
                            aria-expanded={isAuthOpen}
                            onClick={() => setIsAuthOpen(v => !v)}
                            className={cn(
                                'p-2 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40',
                                isAuthOpen || hasAuth ? 'bg-app-accent/15 text-app-accent' : 'text-app-muted/50 hover:text-app-muted hover:bg-app-panel/60'
                            )}
                        >
                            <Key size={13} />
                        </button>

                        <label className="flex items-center gap-1 text-[11px] text-app-muted/50 hover:text-app-muted cursor-pointer transition-colors select-none px-2 py-1.5 rounded-xl hover:bg-app-panel/60">
                            <input
                                type="checkbox"
                                checked={saveConn}
                                onChange={(e) => setSaveConn(e.target.checked)}
                                className="accent-app-accent w-3 h-3"
                                aria-label="Save this connection"
                            />
                            Save
                        </label>

                        <button
                            type="submit"
                            disabled={!input.trim()}
                            aria-label="Connect"
                            className="flex items-center gap-1.5 bg-app-accent text-white px-3.5 py-2 rounded-xl text-xs font-medium hover:brightness-110 disabled:opacity-35 disabled:cursor-not-allowed transition-all ml-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/50"
                        >
                            <span>Connect</span>
                            <CornerDownLeft size={11} aria-hidden="true" />
                        </button>
                    </div>
                </div>

                {/* Live parse preview */}
                <AnimatePresence>
                    {showPreview && (
                        <motion.div
                            initial={{ opacity: 0, y: -2 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.1 }}
                            className="flex items-center gap-1.5 mt-1.5 ml-4"
                            aria-live="polite"
                        >
                            <span className="text-[10px] font-mono text-app-accent/60">{parsedPreview!.username}</span>
                            <span className="text-[10px] text-app-muted/20">·</span>
                            <span className="text-[10px] font-mono text-app-muted/50">{parsedPreview!.host}</span>
                            <span className="text-[10px] text-app-muted/20">·</span>
                            <span className="text-[10px] font-mono text-app-muted/40">:{previewPort}</span>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Inline error */}
                <AnimatePresence>
                    {error && (
                        <motion.p
                            role="alert"
                            aria-live="assertive"
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="text-[11px] text-red-400/80 mt-1.5 ml-2 font-mono"
                        >
                            {error}
                        </motion.p>
                    )}
                </AnimatePresence>

                <AuthPanel
                    isAuthOpen={isAuthOpen}
                    password={password}
                    setPassword={setPassword}
                    portOverride={portOverride}
                    setPortOverride={setPortOverride}
                    privateKeyPath={privateKeyPath}
                    setPrivateKeyPath={setPrivateKeyPath}
                    onBrowseKey={handleBrowseKey}
                />
            </form>

            <SuggestionsDropdown
                showDropdown={showDropdown}
                showRecents={showRecents}
                listboxId={listboxId}
                dropItems={dropItems}
                activeIndex={activeIndex}
                setActiveIndex={setActiveIndex}
                onSelectExisting={onSelectExisting}
            />

            <TemplatesDropdown
                showTemplates={showTemplates}
                templateFocusIndex={templateFocusIndex}
                templateItemRefs={templateItemRefs}
                templates={CONNECTION_TEMPLATES}
                onTemplateKeyDown={handleTemplateKeyDown}
                onTemplateFocus={setTemplateFocusIndex}
                onTemplateApply={applyTemplate}
            />
        </div>
    );
}
