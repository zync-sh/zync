import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { CONTROL_BASE_CLASSES, CONTROL_LABEL_CLASSES } from './controlStyles.js';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  rightElement?: ReactNode;
}

/** Native input with shared control styling and associated label/error descriptions. */
export const Input = forwardRef<HTMLInputElement, InputProps>(({
  className,
  label,
  error,
  rightElement,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ...props
}, ref) => {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const isNumber = props.type === 'number';
  const errorId = `${inputId}-error`;
  const descriptionIds = [...new Set([
    ...(describedBy?.split(/\s+/).filter(Boolean) ?? []),
    ...(error ? [errorId] : []),
  ])].join(' ') || undefined;

  return (
    <div className="space-y-1 w-full">
      {label && (
        <label
          htmlFor={inputId}
          className={CONTROL_LABEL_CLASSES}
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : ariaInvalid}
          aria-describedby={descriptionIds}
          className={cn(
            CONTROL_BASE_CLASSES,
            'flex h-[var(--zync-control-height-md)] w-full border border-app-border bg-app-surface/50 px-3.5 py-2 text-app-text placeholder:text-app-muted focus-visible:border-control-focus drag-none hover:border-app-muted',
            '[&::-ms-reveal]:hidden [&::-ms-clear]:hidden',
            isNumber && '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
            error && 'border-control-danger focus-visible:ring-control-danger focus-visible:border-control-danger',
            rightElement && 'pr-9',
            className,
          )}
          {...props}
        />
        {rightElement && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-2.5">
            {rightElement}
          </div>
        )}
      </div>
      {error && <span id={errorId} className="text-xs text-control-danger">{error}</span>}
    </div>
  );
});
Input.displayName = 'Input';
