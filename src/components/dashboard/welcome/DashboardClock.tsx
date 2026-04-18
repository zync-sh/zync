import { useState, useEffect } from 'react';

function getGreeting(hour: number): string {
    if (hour < 5) return 'Good Night';
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
}

/**
 * Isolated clock component. Syncs to the next minute boundary, then ticks
 * every 60 s — no per-second renders in the parent tree.
 */
export function DashboardClock() {
    const [mounted, setMounted] = useState(false);
    const [now, setNow] = useState<Date | null>(null);

    useEffect(() => {
        setMounted(true);
        setNow(new Date());

        let intervalId: ReturnType<typeof setInterval> | undefined;

        // Sync to the next whole minute so the display stays accurate.
        const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
        const timeoutId = setTimeout(() => {
            setNow(new Date());
            intervalId = setInterval(() => setNow(new Date()), 60_000);
        }, msUntilNextMinute);

        return () => {
            clearTimeout(timeoutId);
            if (intervalId !== undefined) clearInterval(intervalId);
        };
    }, []);

    const displayNow = now ?? new Date(0);
    const hour = displayNow.getHours();
    const timeStr = displayNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = displayNow.toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
    });

    return (
        <div>
            <p suppressHydrationWarning className="text-[10px] font-medium uppercase tracking-widest text-app-muted/40 mb-1 select-none">
                {getGreeting(hour)}
            </p>
            <time
                suppressHydrationWarning
                dateTime={mounted && now ? now.toISOString() : undefined}
                aria-label={`Current time: ${timeStr}`}
                className="block text-3xl font-light font-mono text-app-text tracking-tighter tabular-nums leading-none"
            >
                {mounted && now ? timeStr : '--:--'}
            </time>
            <p className="text-[11px] text-app-muted/35 mt-1 select-none" suppressHydrationWarning>
                {mounted && now ? dateStr : 'Loading…'}
            </p>
        </div>
    );
}
