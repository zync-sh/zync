import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { cn } from '../../lib/utils';
import {
    PROVIDERS,
    type ModelOption,
    type ProviderOption,
    type ProviderValue,
} from './providerCatalog';

interface AiProviderModelPickerProps {
    activeProvider: ProviderOption;
    activeProviderValue: ProviderValue;
    activeModel: string;
    modelShort: string;
    currentModels: ModelOption[];
    onSelectProvider: (provider: ProviderValue) => void;
    onSelectModel: (model: string) => void;
}

export function AiProviderModelPicker({
    activeProvider,
    activeProviderValue,
    activeModel,
    modelShort,
    currentModels,
    onSelectProvider,
    onSelectModel,
}: AiProviderModelPickerProps) {
    const [providerOpen, setProviderOpen] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const providerRef = useRef<HTMLDivElement>(null);
    const modelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!providerOpen && !modelOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (providerOpen && providerRef.current && !providerRef.current.contains(event.target as Node)) {
                setProviderOpen(false);
            }
            if (modelOpen && modelRef.current && !modelRef.current.contains(event.target as Node)) {
                setModelOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [providerOpen, modelOpen]);

    return (
        <div className="flex items-center gap-1.5">
            <div ref={providerRef} className="relative">
                <button
                    onClick={() => {
                        setProviderOpen((open) => !open);
                        setModelOpen(false);
                    }}
                    className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-app-muted hover:text-app-text hover:bg-app-surface/60 transition-colors"
                >
                    {activeProvider.short}
                    <ChevronDown size={8} className="opacity-60" />
                </button>
                <AnimatePresence>
                    {providerOpen && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.96, y: 4 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96, y: 4 }}
                            transition={{ duration: 0.1 }}
                            className="absolute left-0 bottom-full mb-2 w-[160px] rounded-xl shadow-2xl border border-app-border/50 bg-app-panel/95 backdrop-blur-sm z-100 overflow-hidden"
                        >
                            <div className="px-3 pt-2.5 pb-1.5">
                                <p className="text-[9px] font-bold uppercase tracking-widest text-app-muted/50">Provider</p>
                            </div>
                            <div className="pb-1.5">
                                {PROVIDERS.map((provider) => {
                                    const isActive = provider.value === activeProviderValue;
                                    return (
                                        <button
                                            key={provider.value}
                                            onClick={() => {
                                                onSelectProvider(provider.value);
                                                setProviderOpen(false);
                                            }}
                                            className={cn(
                                                'w-full flex items-center justify-between gap-2 px-3 py-2 text-[11px] transition-colors',
                                                isActive
                                                    ? 'bg-app-accent/10 text-app-accent font-medium'
                                                    : 'text-app-text/80 hover:bg-app-surface/60 hover:text-app-text',
                                            )}
                                        >
                                            <span>{provider.label}</span>
                                            {isActive && <Check size={10} className="shrink-0 text-app-accent" />}
                                        </button>
                                    );
                                })}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <div className="w-[1px] h-3 bg-app-border/40" />

            <div ref={modelRef} className="relative">
                <button
                    onClick={() => {
                        setModelOpen((open) => !open);
                        setProviderOpen(false);
                    }}
                    className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-app-muted hover:text-app-text hover:bg-app-surface/60 transition-colors"
                >
                    <span className="truncate max-w-[110px]">{modelShort}</span>
                    <ChevronDown size={8} className="opacity-60" />
                </button>
                <AnimatePresence>
                    {modelOpen && currentModels.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.96, y: 4 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96, y: 4 }}
                            transition={{ duration: 0.1 }}
                            className="absolute right-0 bottom-full mb-2 w-[220px] max-h-[240px] rounded-xl shadow-2xl border border-app-border/50 bg-app-panel/95 backdrop-blur-sm z-100 overflow-hidden flex flex-col"
                        >
                            <div className="px-3 pt-2.5 pb-1.5 shrink-0">
                                <p className="text-[9px] font-bold uppercase tracking-widest text-app-muted/50">
                                    {activeProvider.label} models
                                </p>
                            </div>
                            <div className="overflow-y-auto pb-1.5">
                                {currentModels.map((model) => {
                                    const isActive = model.value === activeModel;
                                    return (
                                        <button
                                            key={model.value}
                                            onClick={() => {
                                                onSelectModel(model.value);
                                                setModelOpen(false);
                                            }}
                                            className={cn(
                                                'w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors',
                                                isActive
                                                    ? 'bg-app-accent/10 text-app-accent'
                                                    : 'text-app-text/80 hover:bg-app-surface/60 hover:text-app-text',
                                            )}
                                        >
                                            <span className={cn('text-[11px] truncate', isActive && 'font-medium')}>
                                                {model.label}
                                            </span>
                                            {isActive && <Check size={10} className="shrink-0 text-app-accent" />}
                                        </button>
                                    );
                                })}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
