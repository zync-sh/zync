import { AnimatePresence, motion } from 'framer-motion';
import { FileKey, FolderOpen, Lock } from 'lucide-react';

interface AuthPanelProps {
    isAuthOpen: boolean;
    password: string;
    setPassword: (value: string) => void;
    portOverride: string;
    setPortOverride: (value: string) => void;
    privateKeyPath: string;
    setPrivateKeyPath: (value: string) => void;
    onBrowseKey: () => void;
}

export function AuthPanel({
    isAuthOpen,
    password,
    setPassword,
    portOverride,
    setPortOverride,
    privateKeyPath,
    setPrivateKeyPath,
    onBrowseKey,
}: AuthPanelProps) {
    return (
        <AnimatePresence>
            {isAuthOpen && (
                <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                >
                    <div className="mt-2 bg-app-surface/30 border border-app-border/30 rounded-2xl p-3 grid grid-cols-2 gap-2">
                        <div className="relative col-span-2 sm:col-span-1">
                            <Lock size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-muted/40 pointer-events-none" aria-hidden="true" />
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Password"
                                aria-label="SSH password"
                                autoComplete="current-password"
                                className="w-full bg-app-surface/60 border border-app-border/40 rounded-xl pl-8 pr-3 py-2 text-xs text-app-text placeholder:text-app-muted/30 focus:border-app-accent/50 outline-none transition-colors"
                            />
                        </div>
                        <div className="relative col-span-2 sm:col-span-1">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-app-muted/40 font-mono pointer-events-none" aria-hidden="true">:</span>
                            <input
                                type="number"
                                value={portOverride}
                                onChange={(e) => setPortOverride(e.target.value)}
                                placeholder="Port (22)"
                                aria-label="Port override"
                                min={1}
                                max={65535}
                                className="w-full bg-app-surface/60 border border-app-border/40 rounded-xl pl-6 pr-3 py-2 text-xs text-app-text placeholder:text-app-muted/30 focus:border-app-accent/50 outline-none transition-colors font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                        </div>
                        <div className="col-span-2 flex gap-2">
                            <div className="relative flex-1">
                                <FileKey size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-muted/40 pointer-events-none" aria-hidden="true" />
                                <input
                                    type="text"
                                    value={privateKeyPath}
                                    onChange={(e) => setPrivateKeyPath(e.target.value)}
                                    placeholder="Private key path"
                                    aria-label="Private key file path"
                                    className="w-full bg-app-surface/60 border border-app-border/40 rounded-xl pl-8 pr-3 py-2 text-xs text-app-text placeholder:text-app-muted/30 focus:border-app-accent/50 outline-none transition-colors font-mono"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={onBrowseKey}
                                aria-label="Browse for private key file"
                                className="px-3 bg-app-surface/60 border border-app-border/40 rounded-xl text-app-muted/50 hover:text-app-accent hover:border-app-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
                            >
                                <FolderOpen size={13} />
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
