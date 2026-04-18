import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../../../lib/utils';
import type { KeyboardEvent, MutableRefObject } from 'react';

export interface ConnectionTemplate {
    id: string;
    name: string;
    username: string;
    port: number;
}

interface TemplatesDropdownProps {
    showTemplates: boolean;
    templateFocusIndex: number;
    templateItemRefs: MutableRefObject<Array<HTMLLIElement | null>>;
    templates: readonly ConnectionTemplate[];
    onTemplateKeyDown: (e: KeyboardEvent<HTMLUListElement>) => void;
    onTemplateFocus: (index: number) => void;
    onTemplateApply: (index: number) => void;
}

export function TemplatesDropdown({
    showTemplates,
    templateFocusIndex,
    templateItemRefs,
    templates,
    onTemplateKeyDown,
    onTemplateFocus,
    onTemplateApply,
}: TemplatesDropdownProps) {
    return (
        <AnimatePresence>
            {showTemplates && (
                <motion.ul
                    role="listbox"
                    aria-label="Connection templates"
                    onKeyDown={onTemplateKeyDown}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute top-full mt-1.5 left-0 w-60 bg-app-panel/98 backdrop-blur-xl border border-app-border/60 rounded-2xl shadow-2xl overflow-hidden z-50 py-1"
                >
                    <li role="presentation" className="px-3 pt-2.5 pb-1">
                        <span className="text-[10px] uppercase tracking-widest text-app-muted/40 font-medium">Templates</span>
                    </li>
                    {templates.map((template, index) => (
                        <li
                            key={template.id}
                            ref={el => { templateItemRefs.current[index] = el; }}
                            role="option"
                            aria-selected={templateFocusIndex === index}
                            tabIndex={templateFocusIndex === index ? 0 : -1}
                            className={cn(
                                'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40',
                                templateFocusIndex === index ? 'bg-app-surface/70' : 'hover:bg-app-surface/40'
                            )}
                            onFocus={() => onTemplateFocus(index)}
                            onMouseEnter={() => onTemplateFocus(index)}
                            onClick={() => onTemplateApply(index)}
                        >
                            <div className="w-6 h-6 rounded-lg bg-app-surface/60 flex items-center justify-center shrink-0">
                                <span className="text-app-accent font-mono text-[10px]">$</span>
                            </div>
                            <div>
                                <div className="text-xs font-medium text-app-text">{template.name}</div>
                                <div className="text-[10px] text-app-muted/50 font-mono">{template.username}@…:{template.port}</div>
                            </div>
                        </li>
                    ))}
                </motion.ul>
            )}
        </AnimatePresence>
    );
}
