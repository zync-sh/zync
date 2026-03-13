import { ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';

interface ZPortalProps {
    children: ReactNode;
    /** Optional target ID, defaults to 'modal-portal-root' */
    targetId?: string;
    /** If true, the wrapper div will NOT have pointer-events-auto. Useful for tooltips. */
    passive?: boolean;
    /** Optional className for the portal wrapper div */
    className?: string;
}

/**
 * ZPortal - A centralized portal component for Zync UI.
 * Automatically targets the internal 'modal-portal-root' to ensure 
 * content is clipped by rounded window corners, while restoring 
 * interactivity via pointer-events-auto.
 */
export function ZPortal({ children, targetId = 'modal-portal-root', passive = false, className }: ZPortalProps) {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return null;

    const target = document.getElementById(targetId) || document.body;

    return createPortal(
        <div className={clsx(
            passive ? "pointer-events-none" : "pointer-events-auto",
            className
        )}>
            {children}
        </div>,
        target
    );
}
