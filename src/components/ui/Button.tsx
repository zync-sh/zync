import { ButtonHTMLAttributes, forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { CONTROL_BASE_CLASSES } from './controlStyles.js';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg' | 'icon';
    isLoading?: boolean;
}

const variants = {
    primary: 'bg-app-accent hover:opacity-90 text-control-on-primary',
    secondary: 'bg-app-surface hover:bg-app-border/50 text-app-text border border-app-border',
    ghost: 'hover:bg-app-surface text-app-muted hover:text-app-text',
    danger: 'bg-control-danger/10 hover:bg-control-danger/20 text-control-danger border border-control-danger/50',
};

const sizes = {
    sm: 'h-[var(--zync-control-height-sm)] px-3 text-xs',
    md: 'h-[var(--zync-control-height-md)] px-4 py-2',
    lg: 'h-[var(--zync-control-height-lg)] px-6 text-lg',
    icon: 'h-[var(--zync-control-height-icon)] w-[var(--zync-control-height-icon)] p-0',
};

/** Theme-aware action control. Native button type and caller overrides are preserved. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
    className,
    variant = 'primary',
    size = 'md',
    isLoading,
    children,
    disabled,
    'aria-busy': ariaBusy,
    ...props
}, ref) => {
    return (
        <button
            ref={ref}
            disabled={disabled || isLoading}
            aria-busy={isLoading || ariaBusy}
            className={cn(
                CONTROL_BASE_CLASSES,
                'inline-flex items-center justify-center font-medium disabled:pointer-events-none',
                variants[variant],
                sizes[size],
                className
            )}
            {...props}
        >
            {isLoading && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {children}
        </button>
    );
});
Button.displayName = 'Button';
