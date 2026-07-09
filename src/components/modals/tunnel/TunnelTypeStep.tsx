import { ArrowRight } from 'lucide-react';
import type { TunnelType } from '../../../features/tunnels/domain/tunnelTypes';
import { cn } from '../../../lib/utils';

const TYPES: { id: TunnelType; label: string }[] = [
    { id: 'local', label: 'Local' },
    { id: 'remote', label: 'Remote' },
    { id: 'dynamic', label: 'Dynamic' },
];

const DESCRIPTIONS: Record<TunnelType, string> = {
    local: 'Reach a service behind the remote firewall as if it were running on your machine.',
    remote: 'Expose a port on the remote host that tunnels incoming connections back to you.',
    dynamic: 'Turn a local port into a SOCKS proxy that routes anywhere through the remote host.',
};

interface TunnelTypeStepProps {
    type: TunnelType;
    onTypeChange: (type: TunnelType) => void;
    onContinue: () => void;
    disabled?: boolean;
}

export function TunnelTypeStep({
    type,
    onTypeChange,
    onContinue,
    disabled,
}: TunnelTypeStepProps) {
    const activeIndex = TYPES.findIndex((t) => t.id === type);

    return (
        <div className="tunnel-wizard">
            <div className="px-5 pt-2">
                <div
                    className="relative grid grid-cols-3 rounded-lg border border-app-border bg-app-surface/60 p-1"
                    role="tablist"
                    aria-label="Tunnel type"
                >
                    <div
                        className="absolute top-1 bottom-1 rounded-md bg-app-accent shadow-sm transition-all duration-300 ease-out"
                        style={{
                            width: 'calc((100% - 0.5rem) / 3)',
                            transform: `translateX(${activeIndex * 100}%)`,
                            left: '0.25rem',
                        }}
                    />
                    {TYPES.map((t) => {
                        const active = t.id === type;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                disabled={disabled}
                                onClick={() => onTypeChange(t.id)}
                                className={cn(
                                    'relative z-10 py-1.5 text-[13px] font-medium transition-colors',
                                    disabled && 'cursor-not-allowed opacity-50',
                                    active
                                        ? 'text-white'
                                        : 'text-app-muted hover:text-app-text',
                                )}
                            >
                                {t.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="px-5 pt-5">
                <div
                    className="relative overflow-hidden rounded-xl border border-app-border"
                    style={{
                        background:
                            'radial-gradient(120% 100% at 50% 0%, color-mix(in oklab, var(--color-tunnel) 10%, var(--color-surface)) 0%, var(--color-surface) 55%)',
                    }}
                >
                    <div
                        className="pointer-events-none absolute inset-0 opacity-40"
                        style={{
                            backgroundImage:
                                'linear-gradient(oklch(0.6 0.02 260 / 0.12) 1px, transparent 1px), linear-gradient(90deg, oklch(0.6 0.02 260 / 0.12) 1px, transparent 1px)',
                            backgroundSize: '20px 20px',
                        }}
                    />
                    <div className="relative animate-fade-in" key={type}>
                        <TunnelDiagram type={type} />
                    </div>
                </div>

                <p className="mt-3 min-h-[2.5rem] text-[13px] leading-relaxed text-app-muted">
                    {DESCRIPTIONS[type]}
                </p>
            </div>

            <div className="mt-1 px-5 pb-5 pt-2">
                <button
                    type="button"
                    onClick={onContinue}
                    disabled={disabled}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-app-accent px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                    Continue
                    <ArrowRight className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}

/* ---------------- Diagram ---------------- */

const W = 360;
const H = 220;

function TunnelDiagram({ type }: { type: TunnelType }) {
    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block h-[220px] w-full"
            role="img"
            aria-label={`${type} port forwarding diagram`}
        >
            <defs>
                <linearGradient id="tunnel-grad" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="var(--color-tunnel)" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="var(--color-tunnel)" stopOpacity="0.4" />
                </linearGradient>
                <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>

            {type === 'local' && <LocalScene />}
            {type === 'remote' && <RemoteScene />}
            {type === 'dynamic' && <DynamicScene />}
        </svg>
    );
}

const CLIENT = { x: 60, y: 110 };
const HUB = { x: 180, y: 110 };
const SERVER = { x: 300, y: 110 };

function LocalScene() {
    return (
        <g>
            <TunnelPath from={CLIENT} to={HUB} direction="forward" />
            <WirePath from={HUB} to={SERVER} direction="forward" />
            <Firewall pos={HUB} />
            <Node pos={CLIENT} kind="client" label="Your machine" port="127.0.0.1:8080" />
            <Node pos={SERVER} kind="server" label="Remote host" port="db:5432" />
        </g>
    );
}

function RemoteScene() {
    return (
        <g>
            <WirePath from={SERVER} to={HUB} direction="forward" />
            <TunnelPath from={HUB} to={CLIENT} direction="forward" />
            <Firewall pos={HUB} />
            <Node pos={CLIENT} kind="client" label="Your machine" port="127.0.0.1:3000" />
            <Node pos={SERVER} kind="server" label="Remote host" port=":9000 exposed" />
        </g>
    );
}

function DynamicScene() {
    const clouds = [
        { x: 320, y: 45, label: 'api.a.com' },
        { x: 335, y: 110, label: 'db.b.io' },
        { x: 320, y: 175, label: 'cdn.c.net' },
    ];
    return (
        <g>
            <TunnelPath from={CLIENT} to={HUB} direction="forward" />
            {clouds.map((c, i) => (
                <WirePath key={i} from={HUB} to={c} direction="forward" dashed />
            ))}
            <Node pos={CLIENT} kind="client" label="SOCKS :1080" port="127.0.0.1:1080" />
            <SocksHub pos={HUB} />
            {clouds.map((c, i) => (
                <Cloud key={i} pos={c} label={c.label} delay={i * 0.4} />
            ))}
        </g>
    );
}

function TunnelPath({
    from,
    to,
    direction,
}: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    direction: 'forward' | 'reverse';
}) {
    const pathId = `tp-${from.x}-${from.y}-${to.x}-${to.y}`;
    const d = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    return (
        <g>
            <path
                d={d}
                stroke="var(--color-tunnel)"
                strokeOpacity="0.15"
                strokeWidth={14}
                strokeLinecap="round"
                fill="none"
            />
            <path
                d={d}
                stroke="var(--color-tunnel)"
                strokeOpacity="0.35"
                strokeWidth={6}
                strokeLinecap="round"
                fill="none"
            />
            <path
                id={pathId}
                d={d}
                stroke="url(#tunnel-grad)"
                strokeWidth={2}
                strokeLinecap="round"
                fill="none"
            />
            {[0, 0.33, 0.66].map((delay) => (
                <circle key={delay} r={3} fill="var(--color-tunnel)" filter="url(#node-glow)">
                    <animateMotion
                        dur="1.6s"
                        repeatCount="indefinite"
                        begin={`${delay}s`}
                        keyPoints={direction === 'forward' ? '0;1' : '1;0'}
                        keyTimes="0;1"
                    >
                        <mpath href={`#${pathId}`} />
                    </animateMotion>
                </circle>
            ))}
        </g>
    );
}

function WirePath({
    from,
    to,
    direction,
    dashed = false,
}: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    direction: 'forward' | 'reverse';
    dashed?: boolean;
}) {
    const pathId = `wp-${from.x}-${from.y}-${to.x}-${to.y}`;
    const d = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    return (
        <g>
            <path
                id={pathId}
                d={d}
                stroke="oklch(0.6 0.03 260 / 0.55)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray={dashed ? '4 5' : '0'}
                fill="none"
            />
            <circle r={2} fill="oklch(0.6 0.03 260)" opacity="0.85">
                <animateMotion
                    dur="1.6s"
                    repeatCount="indefinite"
                    keyPoints={direction === 'forward' ? '0;1' : '1;0'}
                    keyTimes="0;1"
                >
                    <mpath href={`#${pathId}`} />
                </animateMotion>
            </circle>
        </g>
    );
}

function Node({
    pos,
    kind,
    label,
    port,
}: {
    pos: { x: number; y: number };
    kind: 'client' | 'server';
    label: string;
    port: string;
}) {
    const color = kind === 'client' ? 'var(--color-client)' : 'var(--color-server)';
    const size = 52;
    return (
        <g transform={`translate(${pos.x - size / 2}, ${pos.y - size / 2})`}>
            <ellipse cx={size / 2} cy={size + 6} rx={size / 2.5} ry={3} fill="oklch(0 0 0 / 0.15)" />
            <rect x={-4} y={-4} width={size + 8} height={size + 8} rx={14} fill={color} opacity="0.08" />
            <rect
                x={0}
                y={0}
                width={size}
                height={size}
                rx={12}
                fill="var(--color-surface-elevated)"
                stroke={color}
                strokeOpacity="0.6"
                strokeWidth={1.25}
            />
            <g
                transform={`translate(${size / 2}, ${size / 2})`}
                stroke={color}
                strokeWidth={1.6}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                {kind === 'client' ? <LaptopGlyph /> : <ServerGlyph />}
            </g>
            <text
                x={size / 2}
                y={size + 20}
                textAnchor="middle"
                fill="var(--color-app-text)"
                style={{ font: '600 10.5px ui-sans-serif, system-ui' }}
            >
                {label}
            </text>
            <text
                x={size / 2}
                y={size + 33}
                textAnchor="middle"
                fill="var(--color-app-muted)"
                style={{ font: '500 9px ui-monospace, SFMono-Regular, Menlo, monospace' }}
            >
                {port}
            </text>
        </g>
    );
}

function Firewall({ pos }: { pos: { x: number; y: number } }) {
    const size = 44;
    return (
        <g transform={`translate(${pos.x - size / 2}, ${pos.y - size / 2})`}>
            <rect
                x={-3}
                y={-3}
                width={size + 6}
                height={size + 6}
                rx={12}
                fill="var(--color-tunnel)"
                opacity="0.1"
            />
            <rect
                x={0}
                y={0}
                width={size}
                height={size}
                rx={10}
                fill="var(--color-surface-elevated)"
                stroke="var(--color-tunnel)"
                strokeOpacity="0.7"
                strokeWidth={1.25}
            />
            <g stroke="var(--color-tunnel)" strokeOpacity="0.4" strokeWidth={0.8}>
                <line x1={0} y1={14} x2={size} y2={14} />
                <line x1={0} y1={28} x2={size} y2={28} />
                <line x1={14} y1={0} x2={14} y2={14} />
                <line x1={30} y1={0} x2={30} y2={14} />
                <line x1={7} y1={14} x2={7} y2={28} />
                <line x1={22} y1={14} x2={22} y2={28} />
                <line x1={37} y1={14} x2={37} y2={28} />
                <line x1={14} y1={28} x2={14} y2={size} />
                <line x1={30} y1={28} x2={30} y2={size} />
            </g>
            <g transform={`translate(${size / 2 - 6}, ${size / 2 - 7})`} fill="var(--color-tunnel)">
                <rect x={0} y={5} width={12} height={9} rx={1.5} />
                <path
                    d="M2.5 5 V3 a3.5 3.5 0 0 1 7 0 V5"
                    fill="none"
                    stroke="var(--color-tunnel)"
                    strokeWidth={1.4}
                />
            </g>
            <text
                x={size / 2}
                y={size + 16}
                textAnchor="middle"
                style={{
                    font: '600 9px ui-monospace, SFMono-Regular, Menlo, monospace',
                    fill: 'var(--color-tunnel)',
                }}
            >
                SSH
            </text>
        </g>
    );
}

function SocksHub({ pos }: { pos: { x: number; y: number } }) {
    const size = 44;
    return (
        <g transform={`translate(${pos.x - size / 2}, ${pos.y - size / 2})`}>
            <rect
                x={-3}
                y={-3}
                width={size + 6}
                height={size + 6}
                rx={12}
                fill="var(--color-tunnel)"
                opacity="0.1"
            />
            <rect
                x={0}
                y={0}
                width={size}
                height={size}
                rx={10}
                fill="var(--color-surface-elevated)"
                stroke="var(--color-tunnel)"
                strokeOpacity="0.7"
                strokeWidth={1.25}
            />
            <g
                transform={`translate(${size / 2}, ${size / 2})`}
                stroke="var(--color-tunnel)"
                strokeWidth={1.4}
                fill="none"
            >
                <circle r={10} />
                <path d="M-10 0 L10 0 M0 -10 L0 10" />
                <ellipse rx={5} ry={10} />
            </g>
            <text
                x={size / 2}
                y={size + 16}
                textAnchor="middle"
                style={{
                    font: '600 9px ui-monospace, SFMono-Regular, Menlo, monospace',
                    fill: 'var(--color-tunnel)',
                }}
            >
                PROXY
            </text>
        </g>
    );
}

function Cloud({
    pos,
    label,
    delay = 0,
}: {
    pos: { x: number; y: number };
    label: string;
    delay?: number;
}) {
    const color = 'var(--color-destination)';
    return (
        <g
            transform={`translate(${pos.x - 20}, ${pos.y - 14})`}
            style={{ animation: `fade-in 0.5s ease-out ${delay}s both` }}
        >
            <path
                d="M8 18 Q0 18 0 12 Q0 6 6 6 Q7 0 15 0 Q22 0 24 5 Q32 5 32 12 Q32 18 26 18 Z"
                fill="var(--color-surface-elevated)"
                stroke={color}
                strokeOpacity="0.7"
                strokeWidth={1.25}
            />
            <text
                x={16}
                y={30}
                textAnchor="middle"
                fill="var(--color-app-muted)"
                style={{ font: '500 8.5px ui-monospace, SFMono-Regular, Menlo, monospace' }}
            >
                {label}
            </text>
        </g>
    );
}

function LaptopGlyph() {
    return (
        <g>
            <rect x={-10} y={-8} width={20} height={13} rx={1.5} />
            <path d="M-13 7 H13" />
            <path d="M-3 5 H3" />
        </g>
    );
}

function ServerGlyph() {
    return (
        <g>
            <rect x={-10} y={-9} width={20} height={7} rx={1.5} />
            <rect x={-10} y={2} width={20} height={7} rx={1.5} />
            <circle cx={-6} cy={-5.5} r={0.8} fill="currentColor" />
            <circle cx={-6} cy={5.5} r={0.8} fill="currentColor" />
        </g>
    );
}