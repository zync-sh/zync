import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Folder, Settings, CheckCircle2, FileText } from 'lucide-react';
// @ts-ignore
const ipc = window.ipcRenderer;

interface SetupWizardProps {
    onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
    const [step, setStep] = useState(1);
    const [dataPath, setDataPath] = useState('');
    const [isDefaultPath, setIsDefaultPath] = useState(true);

    const [logPath, setLogPath] = useState('');
    const [isDefaultLogPath, setIsDefaultLogPath] = useState(true);

    const handleSelectFolder = async () => {
        const path = await ipc.invoke('config:select-folder');
        if (path) {
            setDataPath(path);
            setIsDefaultPath(false);
        }
    };

    const handleSelectLogFolder = async () => {
        const path = await ipc.invoke('config:select-folder');
        if (path) {
            setLogPath(path);
            setIsDefaultLogPath(false);
        }
    };

    const handleUseDefault = () => {
        setIsDefaultPath(true);
        setDataPath(''); // Default
    };

    const handleUseDefaultLog = () => {
        setIsDefaultLogPath(true);
        setLogPath(''); // Default
    };

    const handleFinish = async () => {
        // Save config
        await ipc.invoke('config:set', {
            dataPath: isDefaultPath ? undefined : dataPath,
            logPath: isDefaultLogPath ? undefined : logPath,
            isConfigured: true,
            theme: 'dark'
        });

        // Slight delay for effect
        setTimeout(() => {
            onComplete();
        }, 500);
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/90 backdrop-blur-md"
            >
                <motion.div
                    layout
                    initial={{ scale: 0.95, opacity: 0, y: 10 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: -10 }}
                    transition={{ type: "spring", damping: 25, stiffness: 300 }}
                    className="bg-[#09090b] w-[420px] rounded-2xl border border-white/10 shadow-2xl overflow-hidden relative"
                >
                    {/* Background Gradient Blob */}
                    <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />

                    <div className="p-8 relative z-10">
                        {step === 1 && (
                            <motion.div
                                key="welcome"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                className="text-center space-y-6"
                            >
                                <div className="w-20 h-20 flex items-center justify-center mx-auto mb-4">
                                    <img src="icon.png" alt="Zync" className="w-full h-full object-contain drop-shadow-2xl" />
                                </div>
                                <div className="space-y-2">
                                    <h2 className="text-xl font-bold text-white tracking-tight">Welcome to Zync</h2>
                                    <p className="text-sm text-zinc-400 leading-relaxed">
                                        The modern, beautiful SSH client you've been waiting for.
                                    </p>
                                </div>
                                <button
                                    onClick={() => setStep(2)}
                                    className="w-full py-2.5 bg-white text-black text-sm font-semibold rounded-lg hover:bg-zinc-200 transition-colors shadow-lg shadow-white/5 active:scale-95 duration-200"
                                >
                                    Get Started
                                </button>
                            </motion.div>
                        )}

                        {step === 2 && (
                            <motion.div
                                key="storage"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                className="space-y-6"
                            >
                                <div className="text-center space-y-1">
                                    <h2 className="text-lg font-semibold text-white">Setup Storage</h2>
                                    <p className="text-xs text-zinc-500">Where should Zync keep your data?</p>
                                </div>

                                <div className="space-y-3">
                                    <button
                                        onClick={handleUseDefault}
                                        className={`w-full text-left p-3 rounded-xl border transition-all duration-200 group relative overflow-hidden ${isDefaultPath
                                            ? 'bg-white/5 border-indigo-500/50 ring-1 ring-indigo-500/50'
                                            : 'bg-transparent border-white/10 hover:bg-white/5 hover:border-white/20'
                                            }`}
                                    >
                                        <div className="flex items-start gap-3 relative z-10">
                                            <div className={`mt-0.5 p-1.5 rounded-lg transition-colors ${isDefaultPath ? 'bg-indigo-500 text-white' : 'bg-zinc-800 text-zinc-400 group-hover:text-zinc-300'}`}>
                                                <Folder size={14} />
                                            </div>
                                            <div>
                                                <div className={`text-sm font-medium ${isDefaultPath ? 'text-white' : 'text-zinc-300'}`}>Default Location</div>
                                                <div className="text-[10px] text-zinc-500 mt-0.5 font-mono">~/.config/zync</div>
                                            </div>
                                            {isDefaultPath && (
                                                <div className="absolute top-3 right-3 text-indigo-500">
                                                    <CheckCircle2 size={16} />
                                                </div>
                                            )}
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => {
                                            setIsDefaultPath(false);
                                            handleSelectFolder();
                                        }}
                                        className={`w-full text-left p-3 rounded-xl border transition-all duration-200 group relative overflow-hidden ${!isDefaultPath
                                            ? 'bg-white/5 border-indigo-500/50 ring-1 ring-indigo-500/50'
                                            : 'bg-transparent border-white/10 hover:bg-white/5 hover:border-white/20'
                                            }`}
                                    >
                                        <div className="flex items-start gap-3 relative z-10">
                                            <div className={`mt-0.5 p-1.5 rounded-lg transition-colors ${!isDefaultPath ? 'bg-indigo-500 text-white' : 'bg-zinc-800 text-zinc-400 group-hover:text-zinc-300'}`}>
                                                <Settings size={14} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`text-sm font-medium ${!isDefaultPath ? 'text-white' : 'text-zinc-300'}`}>Custom Location</div>
                                                <div className="text-[10px] text-zinc-500 mt-0.5 font-mono truncate">
                                                    {!isDefaultPath && dataPath ? dataPath : 'Select a folder...'}
                                                </div>
                                            </div>
                                            {!isDefaultPath && (
                                                <div className="absolute top-3 right-3 text-indigo-500">
                                                    <CheckCircle2 size={16} />
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                </div>

                                <button
                                    onClick={() => setStep(3)}
                                    className="w-full py-2.5 bg-white text-black text-sm font-semibold rounded-lg hover:bg-zinc-200 transition-colors shadow-lg shadow-white/5 active:scale-95 duration-200"
                                >
                                    Next
                                </button>
                            </motion.div>
                        )}

                        {step === 3 && (
                            <motion.div
                                key="logs"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                className="space-y-6"
                            >
                                <div className="text-center space-y-1">
                                    <h2 className="text-lg font-semibold text-white">Log Storage</h2>
                                    <p className="text-xs text-zinc-500">Where should Zync system logs?</p>
                                </div>

                                <div className="space-y-3">
                                    <button
                                        onClick={handleUseDefaultLog}
                                        className={`w-full text-left p-3 rounded-xl border transition-all duration-200 group relative overflow-hidden ${isDefaultLogPath
                                            ? 'bg-white/5 border-indigo-500/50 ring-1 ring-indigo-500/50'
                                            : 'bg-transparent border-white/10 hover:bg-white/5 hover:border-white/20'
                                            }`}
                                    >
                                        <div className="flex items-start gap-3 relative z-10">
                                            <div className={`mt-0.5 p-1.5 rounded-lg transition-colors ${isDefaultLogPath ? 'bg-indigo-500 text-white' : 'bg-zinc-800 text-zinc-400 group-hover:text-zinc-300'}`}>
                                                <FileText size={14} />
                                            </div>
                                            <div>
                                                <div className={`text-sm font-medium ${isDefaultLogPath ? 'text-white' : 'text-zinc-300'}`}>Default Location</div>
                                                <div className="text-[10px] text-zinc-500 mt-0.5 font-mono">
                                                    {isDefaultPath ? '~/.config/zync/logs' : 'zync/logs inside Data Path'}
                                                </div>
                                            </div>
                                            {isDefaultLogPath && (
                                                <div className="absolute top-3 right-3 text-indigo-500">
                                                    <CheckCircle2 size={16} />
                                                </div>
                                            )}
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => {
                                            setIsDefaultLogPath(false);
                                            handleSelectLogFolder();
                                        }}
                                        className={`w-full text-left p-3 rounded-xl border transition-all duration-200 group relative overflow-hidden ${!isDefaultLogPath
                                            ? 'bg-white/5 border-indigo-500/50 ring-1 ring-indigo-500/50'
                                            : 'bg-transparent border-white/10 hover:bg-white/5 hover:border-white/20'
                                            }`}
                                    >
                                        <div className="flex items-start gap-3 relative z-10">
                                            <div className={`mt-0.5 p-1.5 rounded-lg transition-colors ${!isDefaultLogPath ? 'bg-indigo-500 text-white' : 'bg-zinc-800 text-zinc-400 group-hover:text-zinc-300'}`}>
                                                <Settings size={14} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`text-sm font-medium ${!isDefaultLogPath ? 'text-white' : 'text-zinc-300'}`}>Custom Location</div>
                                                <div className="text-[10px] text-zinc-500 mt-0.5 font-mono truncate">
                                                    {!isDefaultLogPath && logPath ? logPath : 'Select a folder...'}
                                                </div>
                                            </div>
                                            {!isDefaultLogPath && (
                                                <div className="absolute top-3 right-3 text-indigo-500">
                                                    <CheckCircle2 size={16} />
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setStep(2)}
                                        className="w-1/3 py-2.5 bg-transparent border border-white/10 text-zinc-400 text-sm font-semibold rounded-lg hover:bg-white/5 transition-colors"
                                    >
                                        Back
                                    </button>
                                    <button
                                        onClick={handleFinish}
                                        className="flex-1 py-2.5 bg-white text-black text-sm font-semibold rounded-lg hover:bg-zinc-200 transition-colors shadow-lg shadow-white/5 active:scale-95 duration-200"
                                    >
                                        Finish Setup
                                    </button>
                                </div>
                            </motion.div>
                        )}
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
