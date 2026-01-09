import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, label, error, ...props }, ref) => {
  return (
    <div className="space-y-1 w-full">
      {label && <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</label>}
      <input
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-md border border-app-border bg-app-surface/50 px-3 py-1 text-sm text-app-text shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-app-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50 drag-none',
          error && 'border-red-500 focus-visible:ring-red-500',
          className,
        )}
        {...props}
      />
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
});
Input.displayName = 'Input';
