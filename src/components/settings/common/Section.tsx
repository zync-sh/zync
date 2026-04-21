import type { ReactNode } from 'react';

export function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <h3 className="text-xs font-semibold text-[var(--color-app-muted)] uppercase tracking-wider opacity-70">{title}</h3>
            {children}
        </div>
    );
}
