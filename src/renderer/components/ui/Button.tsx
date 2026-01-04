import { ButtonHTMLAttributes, forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg' | 'icon';
    isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
    className,
    variant = 'primary',
    size = 'md',
    isLoading,
    children,
    disabled,
    ...props
}, ref) => {
    const variants = {
        primary: 'bg-[var(--color-app-accent)] hover:opacity-90 text-white shadow-lg shadow-[var(--color-app-accent)]/20',
        secondary: 'bg-[var(--color-app-surface)] hover:bg-[var(--color-app-border)]/50 text-[var(--color-app-text)] border border-[var(--color-app-border)]',
        ghost: 'hover:bg-[var(--color-app-surface)] text-[var(--color-app-muted)] hover:text-[var(--color-app-text)]',
        danger: 'bg-[var(--color-app-danger)]/10 hover:bg-[var(--color-app-danger)]/20 text-[var(--color-app-danger)] border border-[var(--color-app-danger)]/50'
    };

    const sizes = {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 py-2',
        lg: 'h-12 px-6 text-lg',
        icon: 'h-9 w-9 p-0 flex items-center justify-center'
    };

    return (
        <button
            ref={ref}
            disabled={disabled || isLoading}
            className={cn(
                'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-400 disabled:pointer-events-none disabled:opacity-50',
                variants[variant],
                sizes[size],
                className
            )}
            {...props}
        >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {children}
        </button>
    );
});
Button.displayName = 'Button';
