import { useEffect, useRef, useState, type MouseEvent } from 'react';

type Tilt = { x: number; y: number };
const ZERO_TILT: Tilt = { x: 0, y: 0 };

export function TiltLogo() {
    const [tilt, setTilt] = useState(ZERO_TILT);
    const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    const rafIdRef = useRef<number | null>(null);
    const pendingTiltRef = useRef<Tilt | null>(null);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        const handleChange = () => {
            const reduceMotion = mediaQuery.matches;
            setPrefersReducedMotion(reduceMotion);
            if (reduceMotion) {
                pendingTiltRef.current = null;
                if (rafIdRef.current !== null) {
                    cancelAnimationFrame(rafIdRef.current);
                    rafIdRef.current = null;
                }
                setTilt(ZERO_TILT);
            }
        };
        handleChange();
        mediaQuery.addEventListener('change', handleChange);
        return () => {
            mediaQuery.removeEventListener('change', handleChange);
        };
    }, []);

    useEffect(() => () => {
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
    }, []);

    const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
        if (prefersReducedMotion) {
            setTilt((prev) => (prev === ZERO_TILT ? prev : ZERO_TILT));
            return;
        }
        const { left, top, width, height } = e.currentTarget.getBoundingClientRect();
        const centerX = left + width / 2;
        const centerY = top + height / 2;
        const sensitivity = 6;
        const normalizedX = (e.clientX - centerX) / (width / 2);
        const normalizedY = (e.clientY - centerY) / (height / 2);
        pendingTiltRef.current = {
            x: -normalizedY * sensitivity,
            y: normalizedX * sensitivity,
        };
        if (rafIdRef.current !== null) return;
        rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            if (pendingTiltRef.current) {
                setTilt(pendingTiltRef.current);
            }
        });
    };

    const handleMouseLeave = () => {
        pendingTiltRef.current = null;
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        setTilt(ZERO_TILT);
    };

    return (
        <div
            className="flex flex-col items-center gap-4 cursor-default"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{ perspective: 1000 }}
        >
            <div
                className={`w-28 h-28 rounded-2xl flex items-center justify-center border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 shadow-lg shadow-black/5 will-change-transform ${prefersReducedMotion ? '' : 'transition-[transform,box-shadow] duration-150 ease-out'}`}
                style={{
                    transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)${tilt.x || tilt.y ? ' scale3d(1.03, 1.03, 1.03)' : ''}`,
                    boxShadow: tilt.x || tilt.y
                        ? `${-tilt.y * 3}px ${tilt.x * 3}px 24px rgba(0,0,0,0.12)`
                        : undefined
                }}
            >
                <svg width="56" height="56" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className="select-none pointer-events-none shrink-0" aria-hidden="true" focusable="false" role="presentation">
                    <rect width="512" height="512" rx="128" className="fill-[var(--color-app-accent)]/10" />
                    <path d="M128 170.667L213.333 256L128 341.333" className="stroke-[var(--color-app-accent)]" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M256 341.333H384" className="stroke-[var(--color-app-text)]" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </div>
            <div className="text-center select-none">
                <h2 className="text-2xl font-bold text-[var(--color-app-text)] tracking-tight">Zync</h2>
                <p className="text-sm text-[var(--color-app-muted)] mt-0.5">A modern, native SSH client</p>
            </div>
        </div>
    );
}
