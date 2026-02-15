import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, label, error, ...props }, ref) => {
  return (
    <div className="space-y-1 w-full">
      {label && <label className="text-[10px] font-bold text-app-muted uppercase tracking-[0.15em] opacity-40 mb-2 block px-1">{label}</label>}
      <input
        ref={ref}
        className={cn(
          'flex h-10 w-full rounded-xl border border-white/[0.05] bg-app-surface/20 px-3.5 py-2 text-[13px] text-app-text shadow-[inset_0_0_10px_rgba(255,255,255,0.01)] transition-all duration-300 placeholder:text-app-muted/30 focus-visible:outline-none focus-visible:border-app-accent/40 focus-visible:bg-app-surface/40 focus-visible:shadow-[0_0_15px_rgba(121,123,206,0.1)] focus-visible:ring-1 focus-visible:ring-app-accent/20 disabled:cursor-not-allowed disabled:opacity-40 drag-none hover:border-white/10',
          error && 'border-red-500/50 focus-visible:ring-red-500/20 focus-visible:border-red-500/50',
          className,
        )}
        {...props}
      />
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
});
Input.displayName = 'Input';
