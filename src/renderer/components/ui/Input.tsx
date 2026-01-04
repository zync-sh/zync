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
          'flex h-9 w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-gray-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50',
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
