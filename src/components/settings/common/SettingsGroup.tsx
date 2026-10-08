import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils.js';

/** Groups full-width settings rows without adding a second horizontal gutter.
 * Rows own their padding; inset decoration keeps plain and boxed controls aligned.
 * Non-row content should supply its own matching px-4 gutter.
 */
export function SettingsGroup({ children, plain = false }: { children: ReactNode; plain?: boolean }) {
    return <div className={cn('space-y-1 rounded-xl', !plain &&
        'bg-app-surface/40 ring-1 ring-inset ring-app-border/60')}>
        {children}
    </div>;
}
