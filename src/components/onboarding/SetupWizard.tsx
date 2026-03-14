import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Folder, CheckCircle2, FileText, Moon, Sun, Monitor, Terminal, ArrowRight, Sparkles, Shield } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
// @ts-ignore
const ipc = window.ipcRenderer;

interface SetupWizardProps {
    onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
    const [step, setStep] = useState(1);
    const [isAdvanced, setIsAdvanced] = useState(false);

    // Theme State
    const updateSettings = useAppStore(state => state.updateSettings);
    const currentTheme = useAppStore(state => state.settings.theme);

    // Integrations State
    const [foundSshHosts, setFoundSshHosts] = useState<number>(0);
    const [importSsh, setImportSsh] = useState(false);
    const [installShell, setInstallShell] = useState(false);

    // Storage State
    const [dataPath, setDataPath] = useState('');
    const [isDefaultPath, setIsDefaultPath] = useState(true);
    const [logPath, setLogPath] = useState('');
    const [isDefaultLogPath, setIsDefaultLogPath] = useState(true);

    // Step 1: Check for SSH Config on mount
    useEffect(() => {
        const checkSsh = async () => {
            try {
                // Peek at config to count hosts
                // The current command returns the vector.
                const connections = await ipc.invoke('ssh:importConfig');
                if (Array.isArray(connections)) {
                    setFoundSshHosts(connections.length);
                }
            } catch (e) {
                console.log("No SSH config found or error", e);
            }
        };
        checkSsh();
    }, []);

    const handleNext = () => setStep(s => s + 1);
    const handleBack = () => setStep(s => s - 1);

    const handleQuickStart = () => {
        setIsAdvanced(false);
        setImportSsh(false);
        setStep(5); // Jump to Finish
    };

    const handleAdvancedSetup = () => {
        setIsAdvanced(true);
        setStep(2); // Go to Theme
    };

    const handleThemeSelect = (themeId: string) => {
        updateSettings({ theme: themeId });
    };

    const handleSelectFolder = async () => {
        const path = await ipc.invoke('config_select_folder');
        if (path) {
            setDataPath(path);
            setIsDefaultPath(false);
        }
    };

    const handleSelectLogFolder = async () => {
        const path = await ipc.invoke('config_select_folder');
        if (path) {
            setLogPath(path);
            setIsDefaultLogPath(false);
        }
    };

    const settings = useAppStore(state => state.settings);

    const handleFinish = async () => {
        try {
            // 1. Save Settings
            // We must spread the current settings (theme, etc.) because settings_set overwrites the file
            await ipc.invoke('settings_set', {
                settings: {
                    ...settings,
                    dataPath: isDefaultPath ? null : dataPath,
                    logPath: isDefaultLogPath ? null : logPath,
                    isConfigured: true,
                }
            });

            // 2. Import SSH if selected
            if (foundSshHosts > 0 && importSsh) {
                try {
                    const connections = await ipc.invoke('ssh:importConfig');
                    if (connections && Array.isArray(connections)) {
                        // Save imported connections
                        await ipc.invoke('connections_save', {
                            connections: connections,
                            folders: []
                        });
                    }
                } catch (err) {
                    console.error("Failed to import SSH config", err);
                }
            }

            // 3. Shell Integration
            if (installShell) {
                try {
                    await ipc.invoke('system_install_cli');
                } catch (err) {
                    console.error("Failed to install CLI", err);
                }
            }

            onComplete();
        } catch (error) {
            console.error("Failed to finish setup:", error);
            alert("Failed to save settings: " + error);
        }
    };

    const steps = [
        { id: 1, title: 'Welcome' },
        { id: 2, title: 'Theme' },
        { id: 3, title: 'Integrations' },
        { id: 4, title: 'Storage' }, // Skipped in Quick Start
        { id: 5, title: 'Finish' }
    ];

    return (
        <AnimatePresence mode="wait">
            <motion.div
                key="wizard-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-[99999] flex items-center justify-center bg-black/80 backdrop-blur-xl pointer-events-auto"
            >
                <motion.div
                    layout
                    initial={{ scale: 0.95, opacity: 0, y: 10 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: -10 }}
                    transition={{ type: "spring", damping: 25, stiffness: 300 }}
                    className="bg-app-bg w-[500px] rounded-2xl border border-white/10 shadow-2xl overflow-hidden relative flex flex-col max-h-[90vh]"
                >
                    {/* Background Efx */}
                    <div className="absolute top-0 right-0 w-64 h-64 bg-app-accent/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-48 h-48 bg-blue-500/5 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2 pointer-events-none" />

                    {/* Step Indicator */}
                    <div className="px-8 pt-8 pb-4">
                        <div className="flex items-center gap-2 mb-2">
                            {steps.filter(s => isAdvanced || (s.id === 1 || s.id === 5)).map((s) => (
                                <div
                                    key={s.id}
                                    className={cn(
                                        "h-1 rounded-full transition-all duration-300",
                                        s.id <= step ? "bg-app-accent flex-1" : "bg-white/10 flex-1"
                                    )}
                                />
                            ))}
                        </div>
                        <div className="text-xs text-app-muted uppercase font-bold tracking-wider text-right">
                            {step === 1 ? 'Welcome' : step === 5 ? 'Ready' : `Step ${step}${isAdvanced ? '/4' : ''}`}
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto px-8 pb-8 relative z-10 min-h-[300px]">
                        <AnimatePresence mode="wait">
                            {step === 1 && (
                                <motion.div
                                    key="step1"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    className="space-y-6 text-center pt-4"
                                >
                                    <div className="w-24 h-24 mx-auto bg-gradient-to-tr from-app-accent to-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-app-accent/20 rotate-3">
                                        <Sparkles className="text-white w-12 h-12" />
                                    </div>

                                    <div className="space-y-2">
                                        <h2 className="text-2xl font-bold text-app-text tracking-tight">Welcome to Zync</h2>
                                        <p className="text-app-muted text-sm leading-relaxed max-w-xs mx-auto">
                                            The next-generation terminal and SSH client designed for performance.
                                        </p>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3 pt-4">
                                        <button
                                            onClick={handleQuickStart}
                                            className="group flex items-center justify-between p-4 rounded-xl border border-app-border bg-app-surface/50 hover:bg-app-surface hover:border-app-accent/50 transition-all text-left"
                                        >
                                            <div>
                                                <div className="font-semibold text-app-text flex items-center gap-2">
                                                    <Sparkles size={16} className="text-app-accent" />
                                                    Quick Start
                                                </div>
                                                <div className="text-xs text-app-muted mt-0.5">Use recommended defaults</div>
                                            </div>
                                            <ArrowRight size={16} className="text-app-muted group-hover:text-app-accent transition-colors" />
                                        </button>

                                        <button
                                            onClick={handleAdvancedSetup}
                                            className="group flex items-center justify-between p-4 rounded-xl border border-app-border bg-transparent hover:bg-app-surface/30 transition-all text-left"
                                        >
                                            <div>
                                                <div className="font-semibold text-app-text">Custom Setup</div>
                                                <div className="text-xs text-app-muted mt-0.5">Configure storage & theme manually</div>
                                            </div>
                                            <ArrowRight size={16} className="text-app-muted group-hover:text-app-text transition-colors" />
                                        </button>
                                    </div>
                                </motion.div>
                            )}

                            {step === 2 && (
                                <motion.div
                                    key="step2"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    className="space-y-6 pt-2"
                                >
                                    <div className="space-y-1">
                                        <h2 className="text-xl font-bold text-app-text">Choose your Look</h2>
                                        <p className="text-app-muted text-sm">Select a theme that fits your vibe.</p>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3">
                                        {[
                                            { id: 'dark', label: 'Dark', icon: Moon },
                                            { id: 'light', label: 'Light', icon: Sun },
                                            { id: 'system', label: 'System', icon: Monitor },
                                        ].map((t) => (
                                            <button
                                                key={t.id}
                                                onClick={() => handleThemeSelect(t.id)}
                                                className={cn(
                                                    "flex items-center gap-4 p-4 rounded-xl border transition-all",
                                                    currentTheme === t.id
                                                        ? "bg-app-accent/10 border-app-accent ring-1 ring-app-accent text-app-text"
                                                        : "bg-app-surface/30 border-app-border hover:bg-app-surface/60 text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <div className={cn(
                                                    "p-2 rounded-lg",
                                                    currentTheme === t.id ? "bg-app-accent text-white" : "bg-app-bg border border-app-border"
                                                )}>
                                                    <t.icon size={18} />
                                                </div>
                                                <div className="font-medium">{t.label}</div>
                                                {currentTheme === t.id && (
                                                    <CheckCircle2 className="ml-auto text-app-accent" size={18} />
                                                )}
                                            </button>
                                        ))}
                                    </div>

                                    <div className="flex justify-between pt-4">
                                        <button onClick={handleBack} className="px-4 py-2 text-sm font-medium text-app-muted hover:text-app-text">Back</button>
                                        <button
                                            onClick={handleNext}
                                            className="px-6 py-2 bg-app-text text-app-bg text-sm font-bold rounded-lg hover:opacity-90 transition-opacity"
                                        >
                                            Next
                                        </button>
                                    </div>
                                </motion.div>
                            )}

                            {step === 3 && (
                                <motion.div
                                    key="step3"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    className="space-y-6 pt-2"
                                >
                                    <div className="space-y-1">
                                        <h2 className="text-xl font-bold text-app-text">Integrations</h2>
                                        <p className="text-app-muted text-sm">Supercharge your workflow.</p>
                                    </div>

                                    <div className="space-y-4">
                                        {/* SSH Import */}
                                        <div className={cn(
                                            "p-4 rounded-xl border border-app-border bg-app-surface/30 transition-all",
                                            foundSshHosts > 0 ? "opacity-100" : "opacity-60 grayscale"
                                        )}>
                                            <div className="flex items-start gap-3">
                                                <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
                                                    <Terminal size={18} />
                                                </div>
                                                <div className="flex-1">
                                                    <div className="flex items-center justify-between">
                                                        <h3 className="font-medium text-app-text">Import SSH Config</h3>
                                                        <input
                                                            type="checkbox"
                                                            checked={importSsh && foundSshHosts > 0}
                                                            onChange={(e) => setImportSsh(e.target.checked)}
                                                            disabled={foundSshHosts === 0}
                                                            className="accent-app-accent w-4 h-4"
                                                        />
                                                    </div>
                                                    <p className="text-xs text-app-muted mt-1">
                                                        {foundSshHosts > 0
                                                            ? `Found ${foundSshHosts} hosts in ~/.ssh/config`
                                                            : "No custom SSH config found."
                                                        }
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        {/* CLI Tool */}
                                        <div className="p-4 rounded-xl border border-app-border bg-app-surface/30">
                                            <div className="flex items-start gap-3">
                                                <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg">
                                                    <Shield size={18} />
                                                </div>
                                                <div className="flex-1">
                                                    <div className="flex items-center justify-between">
                                                        <h3 className="font-medium text-app-text">Install CLI Tool</h3>
                                                        <input
                                                            type="checkbox"
                                                            checked={installShell}
                                                            onChange={(e) => setInstallShell(e.target.checked)}
                                                            className="accent-app-accent w-4 h-4"
                                                        />
                                                    </div>
                                                    <p className="text-xs text-app-muted mt-1">
                                                        Run <code className="bg-app-bg px-1 rounded border border-app-border text-app-text">zync</code> from your terminal.
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex justify-between pt-4">
                                        <button onClick={handleBack} className="px-4 py-2 text-sm font-medium text-app-muted hover:text-app-text">Back</button>
                                        <button
                                            onClick={handleNext}
                                            className="px-6 py-2 bg-app-text text-app-bg text-sm font-bold rounded-lg hover:opacity-90 transition-opacity"
                                        >
                                            Next
                                        </button>
                                    </div>
                                </motion.div>
                            )}

                            {step === 4 && (
                                <motion.div
                                    key="step4"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    className="space-y-6 pt-2"
                                >
                                    <div className="space-y-1">
                                        <h2 className="text-xl font-bold text-app-text">Storage</h2>
                                        <p className="text-app-muted text-sm">Where should Zync keep its data?</p>
                                    </div>

                                    <div className="space-y-4">
                                        {/* Data Path */}
                                        <div className="space-y-2">
                                            <label className="text-xs font-semibold text-app-muted uppercase">Data Directory</label>
                                            <div onClick={() => !isDefaultPath && handleSelectFolder()} className={cn(
                                                "flex items-center gap-3 p-3 rounded-xl border border-app-border bg-app-surface/30",
                                                !isDefaultPath && "cursor-pointer hover:bg-app-surface/50"
                                            )}>
                                                <Folder size={16} className="text-app-muted" />
                                                <div className="flex-1 font-mono text-xs text-app-text truncate">
                                                    {isDefaultPath ? 'Default Location' : (dataPath || 'Select folder...')}
                                                </div>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setIsDefaultPath(!isDefaultPath); if (isDefaultPath) setDataPath(''); }}
                                                    className="text-xs text-app-accent hover:underline"
                                                >
                                                    {isDefaultPath ? 'Change' : 'Reset'}
                                                </button>
                                            </div>
                                        </div>

                                        {/* Log Path */}
                                        <div className="space-y-2">
                                            <label className="text-xs font-semibold text-app-muted uppercase">Logs Directory</label>
                                            <div onClick={() => !isDefaultLogPath && handleSelectLogFolder()} className={cn(
                                                "flex items-center gap-3 p-3 rounded-xl border border-app-border bg-app-surface/30",
                                                !isDefaultLogPath && "cursor-pointer hover:bg-app-surface/50"
                                            )}>
                                                <FileText size={16} className="text-app-muted" />
                                                <div className="flex-1 font-mono text-xs text-app-text truncate">
                                                    {isDefaultLogPath ? 'Default Location' : (logPath || 'Select folder...')}
                                                </div>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setIsDefaultLogPath(!isDefaultLogPath); if (isDefaultLogPath) setLogPath(''); }}
                                                    className="text-xs text-app-accent hover:underline"
                                                >
                                                    {isDefaultLogPath ? 'Change' : 'Reset'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex justify-between pt-4">
                                        <button onClick={handleBack} className="px-4 py-2 text-sm font-medium text-app-muted hover:text-app-text">Back</button>
                                        <button
                                            onClick={handleNext}
                                            className="px-6 py-2 bg-app-text text-app-bg text-sm font-bold rounded-lg hover:opacity-90 transition-opacity"
                                        >
                                            Next
                                        </button>
                                    </div>
                                </motion.div>
                            )}

                            {step === 5 && (
                                <motion.div
                                    key="step5"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    className="text-center space-y-8 pt-8"
                                >
                                    <div className="w-20 h-20 mx-auto bg-green-500/10 text-green-500 rounded-full flex items-center justify-center border border-green-500/20">
                                        <CheckCircle2 size={40} />
                                    </div>

                                    <div className="space-y-2">
                                        <h2 className="text-2xl font-bold text-app-text">You're All Set!</h2>
                                        <p className="text-app-muted text-sm">
                                            Zync is configured and ready to go.
                                        </p>
                                    </div>

                                    <button
                                        onClick={handleFinish}
                                        className="w-full py-3 bg-app-accent text-white font-bold rounded-xl shadow-lg shadow-app-accent/20 hover:brightness-110 active:scale-95 transition-all text-sm"
                                    >
                                        Launch Zync
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
