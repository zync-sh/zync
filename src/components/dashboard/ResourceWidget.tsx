import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useId, useState } from 'react';

import { cn } from '../../lib/utils';
import {
    DASHBOARD_HISTORY_GAP_MS,
    DASHBOARD_HISTORY_LIMIT,
    type DashboardHistoryPoint,
} from './dashboardMetrics';

interface ResourceWidgetProps {
    title: string;
    value: string;
    subtext: string;
    icon: LucideIcon;
    data: readonly DashboardHistoryPoint[];
    className?: string;
    children?: ReactNode;
}

const TREND_WIDTH = 240;
const TREND_HEIGHT = 64;
const TREND_PADDING = 3;
const MAX_DATE_TIMESTAMP = 8.64e15;

/** Retain the latest bounded observations, with one finite reading per valid acquisition time. */
function historySamples(data: readonly DashboardHistoryPoint[]): DashboardHistoryPoint[] {
    const samples = new Map<number, DashboardHistoryPoint>();
    for (const sample of data) {
        if (
            Number.isFinite(sample.value) &&
            sample.value >= 0 &&
            sample.value <= 100 &&
            Number.isFinite(sample.sampledAt) &&
            sample.sampledAt >= 0 &&
            sample.sampledAt <= MAX_DATE_TIMESTAMP
        ) {
            samples.set(sample.sampledAt, sample);
        }
    }
    return [...samples.values()]
        .sort((left, right) => left.sampledAt - right.sampledAt)
        .slice(-DASHBOARD_HISTORY_LIMIT);
}

/** Label observed times explicitly instead of implying a fixed or continuous monitoring window. */
function sampleTime(sample: DashboardHistoryPoint): string {
    return new Date(sample.sampledAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

/** Plot measured history against a visible scale, with inspectable values and honest sampling gaps. */
export function ResourceWidget({
    title,
    value,
    subtext,
    icon: Icon,
    data,
    className,
    children,
}: ResourceWidgetProps) {
    const readoutId = useId();
    const [inspectedAt, setInspectedAt] = useState<number | null>(null);
    const [announcement, setAnnouncement] = useState('');
    const samples = historySamples(data);
    const first = samples[0];
    const last = samples[samples.length - 1];
    const selected = samples.find((sample) => sample.sampledAt === inspectedAt) ?? last;
    const span = first && last ? last.sampledAt - first.sampledAt : 0;
    const points = samples.map((sample) => ({
        ...sample,
        x:
            span > 0
                ? TREND_PADDING +
                  ((sample.sampledAt - first.sampledAt) / span) * (TREND_WIDTH - TREND_PADDING * 2)
                : TREND_WIDTH / 2,
        y: TREND_HEIGHT - TREND_PADDING - (sample.value / 100) * (TREND_HEIGHT - TREND_PADDING * 2),
    }));
    const segments: (typeof points)[] = [];
    for (const point of points) {
        const segment = segments[segments.length - 1];
        const previous = segment?.[segment.length - 1];
        if (!previous || point.sampledAt - previous.sampledAt > DASHBOARD_HISTORY_GAP_MS) {
            segments.push([point]);
        } else {
            segment.push(point);
        }
    }
    const current = points[points.length - 1];
    const inspected = points.find((point) => point.sampledAt === selected?.sampledAt);
    const minimum = samples.length ? Math.min(...samples.map((sample) => sample.value)) : 0;
    const maximum = samples.length ? Math.max(...samples.map((sample) => sample.value)) : 0;
    const steady = samples.length >= 2 && minimum.toFixed(1) === maximum.toFixed(1);

    /** Inspect the nearest actual observation rather than interpolating an unmeasured value. */
    const inspectPointer = (event: PointerEvent<SVGSVGElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (!bounds.width || !points.length) {
            return;
        }
        const x = ((event.clientX - bounds.left) / bounds.width) * TREND_WIDTH;
        const nearest = points.reduce((previous, point) =>
            Math.abs(point.x - x) < Math.abs(previous.x - x) ? point : previous,
        );
        setInspectedAt(nearest.sampledAt);
    };

    /** Give keyboard users one chart stop and access to every measured observation. */
    const inspectKey = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!last) {
            return;
        }
        const index = samples.findIndex((sample) => sample.sampledAt === selected.sampledAt);
        let next: number;
        switch (event.key) {
            case 'ArrowLeft':
                next = Math.max(0, index - 1);
                break;
            case 'ArrowRight':
                next = Math.min(samples.length - 1, index + 1);
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = samples.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        const sample = samples[next];
        setInspectedAt(sample.sampledAt);
        setAnnouncement(`${sample.value.toFixed(1)} percent at ${sampleTime(sample)}`);
    };

    return (
        <section
            aria-label={title}
            className={cn(
                'min-w-0 rounded-lg border border-app-border bg-app-panel p-4',
                className,
            )}
        >
            <h3 className="flex items-center gap-2 text-xs font-medium text-app-muted">
                <Icon
                    size={14}
                    className="shrink-0"
                    aria-hidden
                />
                {title}
            </h3>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-2xl font-semibold tracking-tight text-app-text tabular-nums">
                    {value}
                </span>
                <span className="text-xs text-app-muted">{subtext}</span>
            </div>
            <div className="mt-4 text-[11px]">
                <div className="mb-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-app-muted">
                    <span>Usage history</span>
                    <span>
                        {steady
                            ? `Steady at ${last.value.toFixed(1)}%`
                            : samples.length >= 2
                              ? `Range: ${minimum.toFixed(1)}–${maximum.toFixed(1)}%`
                              : samples.length
                                ? 'Collecting history'
                                : 'No samples yet'}
                    </span>
                </div>
                {first && last && current && selected ? (
                    <>
                        <button
                            type="button"
                            aria-label={`Inspect ${title} history`}
                            aria-describedby={readoutId}
                            className="grid w-full grid-cols-[2rem_minmax(0,1fr)] gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
                            onKeyDown={inspectKey}
                            onClick={() => setInspectedAt((previous) => previous ?? last.sampledAt)}
                            onFocus={() => setInspectedAt((previous) => previous ?? last.sampledAt)}
                            onBlur={() => {
                                setInspectedAt(null);
                                setAnnouncement('');
                            }}
                            onPointerLeave={(event) => {
                                if (document.activeElement !== event.currentTarget) {
                                    setInspectedAt(null);
                                }
                            }}
                        >
                            <span
                                aria-hidden
                                className="flex h-16 flex-col justify-between text-[10px] leading-none text-app-muted"
                            >
                                <span>100%</span>
                                <span>50%</span>
                                <span>0%</span>
                            </span>
                            <svg
                                role="img"
                                aria-label={`${title} recent samples, on a 0 to 100 percent scale`}
                                viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
                                preserveAspectRatio="none"
                                onPointerMove={inspectPointer}
                                className="h-16 w-full overflow-visible text-app-accent"
                            >
                                {[
                                    TREND_PADDING,
                                    TREND_HEIGHT / 2,
                                    TREND_HEIGHT - TREND_PADDING,
                                ].map((y) => (
                                    <line
                                        key={y}
                                        x1={TREND_PADDING}
                                        y1={y}
                                        x2={TREND_WIDTH - TREND_PADDING}
                                        y2={y}
                                        stroke="currentColor"
                                        strokeWidth={1}
                                        className="text-app-border"
                                        vectorEffect="non-scaling-stroke"
                                    />
                                ))}
                                {segments.map((segment) => (
                                    <g key={segment[0].sampledAt}>
                                        {segment.length >= 2 && (
                                            <>
                                                <polygon
                                                    points={`${segment[0].x},${TREND_HEIGHT - TREND_PADDING} ${segment.map(({ x, y }) => `${x},${y}`).join(' ')} ${segment[segment.length - 1].x},${TREND_HEIGHT - TREND_PADDING}`}
                                                    fill="currentColor"
                                                    fillOpacity={0.15}
                                                />
                                                <polyline
                                                    points={segment
                                                        .map(({ x, y }) => `${x},${y}`)
                                                        .join(' ')}
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth={1.5}
                                                    strokeLinejoin="round"
                                                    strokeLinecap="round"
                                                    vectorEffect="non-scaling-stroke"
                                                />
                                            </>
                                        )}
                                        {segment.length === 1 && segment[0] !== current && (
                                            <circle
                                                cx={segment[0].x}
                                                cy={segment[0].y}
                                                r={2}
                                                fill="currentColor"
                                            />
                                        )}
                                    </g>
                                ))}
                                {inspected && inspected !== current && (
                                    <circle
                                        cx={inspected.x}
                                        cy={inspected.y}
                                        r={3}
                                        fill="currentColor"
                                    />
                                )}
                                <circle
                                    data-current
                                    data-sampled-at={current.sampledAt}
                                    cx={current.x}
                                    cy={current.y}
                                    r={3}
                                    fill="currentColor"
                                />
                            </svg>
                        </button>
                        <div
                            className={`mt-1 flex gap-2 pl-10 text-[10px] text-app-muted tabular-nums ${samples.length > 1 ? 'justify-between' : 'justify-center'}`}
                        >
                            <time dateTime={new Date(first.sampledAt).toISOString()}>
                                {sampleTime(first)}
                            </time>
                            {samples.length > 1 && (
                                <time dateTime={new Date(last.sampledAt).toISOString()}>
                                    {sampleTime(last)}
                                </time>
                            )}
                        </div>
                        <output
                            id={readoutId}
                            aria-label={`${title} inspected sample`}
                            aria-live="off"
                            className="mt-2 block text-app-muted tabular-nums"
                        >
                            {inspectedAt === null ? 'Latest' : 'Sample'}:{' '}
                            <span className="font-medium text-app-text">
                                {selected.value.toFixed(1)}%
                            </span>{' '}
                            at{' '}
                            <time dateTime={new Date(selected.sampledAt).toISOString()}>
                                {sampleTime(selected)}
                            </time>
                            <span className="sr-only">
                                . Use Left and Right arrow keys to inspect samples.
                            </span>
                        </output>
                        {segments.length > 1 && (
                            <p className="mt-1 text-app-muted">
                                Gaps indicate missing observations.
                            </p>
                        )}
                    </>
                ) : (
                    <p className="flex h-16 items-center text-app-muted">
                        History appears after a valid sample.
                    </p>
                )}
                <span
                    role="status"
                    aria-live="polite"
                    className="sr-only"
                >
                    {announcement}
                </span>
            </div>
            {children && <div className="mt-3 border-t border-app-border pt-3">{children}</div>}
        </section>
    );
}
