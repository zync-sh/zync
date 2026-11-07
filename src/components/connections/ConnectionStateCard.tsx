import type { ReactNode } from 'react';

import { cn } from '../../lib/utils.js';

const TONES = {
    neutral: {
        badge: 'bg-app-surface text-app-muted border-app-border',
        icon: 'bg-app-surface border-app-border text-app-muted',
    },
    accent: {
        badge: 'bg-app-accent/10 text-app-accent border-app-accent/25',
        icon: 'bg-app-accent/10 border-app-accent/20 text-app-accent',
    },
    error: {
        badge: 'bg-app-danger/10 text-app-danger border-app-danger/30',
        icon: 'bg-app-danger/10 border-app-danger/25 text-app-danger',
    },
};

export type ConnectionStateCardTone = keyof typeof TONES;

interface ConnectionStateCardProps {
    title: string;
    icon: ReactNode;
    badge?: string;
    tone?: ConnectionStateCardTone;
    identity?: ReactNode;
    statusLabel?: string;
    children: ReactNode;
}

/** Share the disconnected-session presentation while each transport owns its controls. */
export function ConnectionStateCard({
    title,
    icon,
    badge,
    tone = 'neutral',
    identity,
    statusLabel,
    children,
}: ConnectionStateCardProps) {
    return (
        <div
            className={cn(
                'relative z-10 flex h-full min-h-0 flex-col items-center justify-center overflow-auto bg-app-bg',
                'p-4 sm:p-8',
                '[@media(max-height:560px)]:p-3 [@media(max-height:560px)]:justify-start [@media(max-height:560px)]:py-4',
            )}
            role={statusLabel ? 'status' : undefined}
            aria-live={statusLabel ? 'polite' : undefined}
            aria-label={statusLabel}
        >
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-0 bg-app-bg bg-[radial-gradient(circle_at_center,var(--color-app-border)_1px,transparent_1px)] opacity-40 [background-size:18px_18px]"
                style={{
                    maskImage:
                        'radial-gradient(ellipse 70% 60% at 50% 50%, black 30%, transparent 100%)',
                    WebkitMaskImage:
                        'radial-gradient(ellipse 70% 60% at 50% 50%, black 30%, transparent 100%)',
                }}
            />
            <div
                className={cn(
                    'relative w-full max-w-md rounded-2xl border border-app-border/60 bg-app-panel/90 shadow-2xl shadow-black/20 backdrop-blur-sm',
                    'p-5 sm:p-7',
                    '[@media(max-height:560px)]:p-4 [@media(max-height:560px)]:rounded-xl',
                )}
            >
                <div className="flex items-start gap-3 sm:gap-3.5 [@media(max-height:560px)]:gap-2.5">
                    <div
                        aria-hidden
                        className={cn(
                            'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border',
                            '[@media(max-height:560px)]:h-9 [@media(max-height:560px)]:w-9 [@media(max-height:560px)]:rounded-lg',
                            TONES[tone].icon,
                        )}
                    >
                        {icon}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2 sm:mb-1.5">
                            <h2 className="truncate text-sm font-semibold tracking-tight text-app-text">
                                {title}
                            </h2>
                            {badge && (
                                <span
                                    className={cn(
                                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                        TONES[tone].badge,
                                    )}
                                >
                                    {badge}
                                </span>
                            )}
                        </div>
                        {identity}
                    </div>
                </div>
                {children}
            </div>
        </div>
    );
}
