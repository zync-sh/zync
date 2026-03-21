import { Copy, SkipForward, FileText, AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useState } from 'react';

export type ConflictAction = 'overwrite' | 'skip' | 'rename' | 'cancel';

interface ConflictModalProps {
    isOpen: boolean;
    onClose: () => void;
    onResolve: (action: ConflictAction, applyToAll: boolean) => void;
    fileName: string;
    destinationPath: string;
    isBatch?: boolean;
}

export function ConflictModal({
    isOpen,
    onClose,
    onResolve,
    fileName,
    destinationPath,
    isBatch = false
}: ConflictModalProps) {
    const [applyToAll, setApplyToAll] = useState(false);

    const handleClose = () => {
        setApplyToAll(false);
        onClose();
    };

    const handleResolve = (action: ConflictAction) => {
        onResolve(action, applyToAll);
        setApplyToAll(false); // Reset for next time (though usually closed)
    };
    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            title="File Name Collision"
            width="max-w-md"
        >
            <div className="flex flex-col py-2">
                <div className="flex items-start gap-4 mb-6 px-1">
                    <div className="w-12 h-12 shrink-0 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 shadow-lg shadow-amber-500/5">
                        <AlertTriangle size={24} />
                    </div>
                    <div className="flex-1 pt-0.5">
                        <p className="text-app-text/90 text-[13px] leading-relaxed font-semibold mb-1">
                            An item named "{fileName}" already exists.
                        </p>
                        <p className="text-app-text/50 text-[11px] leading-relaxed">
                            A file or folder with the same name already exists in <span className="text-app-text/70 break-all">{destinationPath}</span>. 
                            How would you like to proceed?
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-2 mb-6">
                    <button 
                        onClick={() => handleResolve('overwrite')}
                        className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all text-left group"
                    >
                        <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center text-red-500 group-hover:scale-110 transition-transform">
                            <Copy size={16} />
                        </div>
                        <div>
                            <div className="text-[11px] font-bold text-app-text/90 uppercase tracking-wider">Overwrite</div>
                            <div className="text-[10px] text-app-text/40">Replace the existing file with the new one</div>
                        </div>
                    </button>

                    <button 
                        onClick={() => handleResolve('rename')}
                        className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all text-left group"
                    >
                        <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-500 group-hover:scale-110 transition-transform">
                            <FileText size={16} />
                        </div>
                        <div>
                            <div className="text-[11px] font-bold text-app-text/90 uppercase tracking-wider">Keep Both</div>
                            <div className="text-[10px] text-app-text/40">Auto-rename the new file to "{fileName} (1)"</div>
                        </div>
                    </button>

                    <button 
                        onClick={() => handleResolve('skip')}
                        className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all text-left group"
                    >
                        <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-app-text/60 group-hover:scale-110 transition-transform">
                            <SkipForward size={16} />
                        </div>
                        <div>
                            <div className="text-[11px] font-bold text-app-text/90 uppercase tracking-wider">Skip</div>
                            <div className="text-[10px] text-app-text/40">Don't move this file and keep the original</div>
                        </div>
                    </button>
                </div>

                <div className="flex items-center justify-between mt-2">
                    {isBatch ? (
                        <label className="flex items-center gap-2 cursor-pointer group select-none">
                            <div className="relative flex items-center justify-center">
                                <input 
                                    type="checkbox" 
                                    className="peer h-4 w-4 appearance-none rounded border border-app-border bg-app-surface/50 checked:bg-app-accent checked:border-app-accent transition-all cursor-pointer"
                                    checked={applyToAll}
                                    onChange={(e) => setApplyToAll(e.target.checked)}
                                />
                                <div className="absolute opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none text-white">
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                    </svg>
                                </div>
                            </div>
                            <span className="text-[11px] text-app-text/60 group-hover:text-app-text/80 transition-colors">Do this for all remaining conflicts</span>
                        </label>
                    ) : (
                        <div />
                    )}
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            onClick={handleClose}
                            className="px-4 h-8 font-bold text-[10px] uppercase tracking-widest hover:bg-white/[0.05]"
                        >
                            {isBatch ? 'Cancel All' : 'Cancel'}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
