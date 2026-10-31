import { CheckCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { isActiveTransferStatus } from '../../store/transferSlice';
import { Transfer, useAppStore } from '../../store/useAppStore';
import { ZPortal } from '../ui/ZPortal';
import { TransferPanel } from './TransferPanel';

/** Build an SVG arc path for a filled pie slice (0-100%). Starts from 12 o'clock. */
function describeArc(cx: number, cy: number, r: number, percent: number): string {
    if (percent >= 100) {
        // Full circle — use two arcs to avoid SVG zero-length arc bug
        return `M${cx},${cy - r} A${r},${r} 0 1,1 ${cx - 0.001},${cy - r} Z`;
    }
    const angle = (percent / 100) * 360;
    const rad = (angle - 90) * (Math.PI / 180); // -90 to start from top
    const x = cx + r * Math.cos(rad);
    const y = cy + r * Math.sin(rad);
    const largeArc = angle > 180 ? 1 : 0;
    return `M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${largeArc},1 ${x},${y} Z`;
}

/** Summarizes active transfers, keeping unknown archive totals indeterminate. */
export function StatusBarTransferIndicator() {
    const transfers = useAppStore((state) => state.transfers);
    const [isOpen, setIsOpen] = useState(false);
    const [hasCompleted, setHasCompleted] = useState(false);
    const [tooltip, setTooltip] = useState<string | null>(null);
    const indicatorRef = useRef<HTMLButtonElement>(null);
    const completedIdsRef = useRef<Set<string>>(new Set());
    const prevActiveIdsRef = useRef<Set<string>>(new Set());

    const activeTransfers = transfers.filter((t: Transfer) => isActiveTransferStatus(t.status));

    // Track completion — stay green until circle disappears
    const completedIds = transfers
        .filter((t: Transfer) => t.status === 'completed')
        .map((transfer) => transfer.id);
    useEffect(() => {
        const hasNewCompletion = completedIds.some((id) => !completedIdsRef.current.has(id));
        completedIdsRef.current = new Set(completedIds);
        if (hasNewCompletion) {
            setHasCompleted(true);
            setTooltip('Transfer complete');
        }
        if (completedIds.length === 0) {
            setHasCompleted(false);
        }
    }, [completedIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

    // Show tooltip when a new transfer starts (track by IDs, not just count)
    const activeIds = activeTransfers.map((t: Transfer) => t.id);
    useEffect(() => {
        const currentIds = new Set(activeIds);
        const newIds = activeIds.filter((id) => !prevActiveIdsRef.current.has(id));
        prevActiveIdsRef.current = currentIds;

        if (newIds.length === 0) {
            return;
        }

        const newest = activeTransfers.find((t: Transfer) => t.id === newIds[newIds.length - 1]);
        if (!newest) {
            return;
        }

        const isUpload = newest.destinationConnectionId !== 'local';
        const label = newest.label
            ? `${newest.label}...`
            : isUpload
              ? 'Upload in progress'
              : 'Download in progress';
        setTooltip(label);
    }, [activeIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!tooltip) {
            return;
        }
        const timer = setTimeout(() => setTooltip(null), 2000);
        return () => clearTimeout(timer);
    }, [tooltip]);

    // Auto-open panel when a new transfer starts
    useEffect(() => {
        if (activeTransfers.length > 0) {
            setIsOpen(true);
        }
    }, [activeTransfers.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

    // Nothing to show
    if (transfers.length === 0 && !hasCompleted) {
        return null;
    }

    // Compute aggregate progress for the circle
    /** Pending work and unknown byte totals cannot supply a percentage. */
    const isIndeterminate = (t: Transfer) => t.status === 'pending' || t.progress.total <= 0;
    const allIndeterminate = activeTransfers.length > 0 && activeTransfers.every(isIndeterminate);
    let aggregatePercent = 0;
    if (activeTransfers.length > 0) {
        const sum = activeTransfers.reduce((acc: number, t: Transfer) => {
            if (t.label) {
                return acc + Math.min(99, Math.sqrt(t.progress.percentage) * 10);
            }
            return acc + t.progress.percentage;
        }, 0);
        aggregatePercent = sum / activeTransfers.length;
    }

    // SVG circle math
    const size = 16;
    const cx = size / 2;
    const cy = size / 2;
    const r = 5.5;

    const isIdle = activeTransfers.length === 0;
    const badgeCount = activeTransfers.length > 9 ? '9+' : `${activeTransfers.length}`;

    // Get button position for fixed-positioned tooltip/panel (escapes overflow-hidden)
    const rect = indicatorRef.current?.getBoundingClientRect();

    return (
        <>
            <button
                ref={indicatorRef}
                onClick={() => setIsOpen((prev) => !prev)}
                aria-label="Transfers"
                aria-expanded={isOpen}
                className="relative flex items-center justify-center w-5 h-5 rounded-sm hover:bg-app-surface transition-colors"
            >
                {/* Idle completed state — checkmark icon */}
                {isIdle && hasCompleted ? (
                    <CheckCircle
                        size={14}
                        className="text-app-success"
                    />
                ) : (
                    <svg
                        width={size}
                        height={size}
                        viewBox={`0 0 ${size} ${size}`}
                        className={allIndeterminate ? 'animate-spin' : ''}
                    >
                        {/* Background filled circle */}
                        <circle
                            cx={cx}
                            cy={cy}
                            r={r}
                            className="fill-app-border/50"
                        />
                        {/* Progress pie — filled arc */}
                        {!isIdle && (allIndeterminate || aggregatePercent > 0) && (
                            <path
                                d={describeArc(cx, cy, r, allIndeterminate ? 25 : aggregatePercent)}
                                className={`transition-all duration-300 ${hasCompleted ? 'fill-app-success' : 'fill-app-accent'}`}
                            />
                        )}
                    </svg>
                )}

                {/* Count badge for multiple active transfers */}
                {activeTransfers.length > 1 && (
                    <span className="absolute -top-1 -right-1 bg-app-accent text-white text-[7px] font-bold rounded-full min-w-3 h-3 px-0.5 flex items-center justify-center leading-none">
                        {badgeCount}
                    </span>
                )}
            </button>

            {/* Tooltip — portaled to body to escape overflow-hidden */}
            {tooltip && !isOpen && rect && (
                <ZPortal passive>
                    <div
                        className="absolute px-2 py-1 bg-app-panel border border-app-border rounded text-[10px] text-app-text whitespace-nowrap shadow-lg animate-in fade-in slide-in-from-bottom-1 duration-200 z-50"
                        style={{
                            bottom: window.innerHeight - rect.top + 6,
                            right: window.innerWidth - rect.right,
                        }}
                    >
                        {tooltip}
                        <div className="absolute top-full right-2 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[4px] border-t-app-border" />
                    </div>
                </ZPortal>
            )}

            {/* Transfer Panel Dropdown — portaled to body */}
            {isOpen && (
                <TransferPanel
                    onClose={() => setIsOpen(false)}
                    indicatorRef={indicatorRef}
                />
            )}
        </>
    );
}
