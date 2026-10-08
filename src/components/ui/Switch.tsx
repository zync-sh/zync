import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { CONTROL_BASE_CLASSES } from './controlStyles.js';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type' | 'role' | 'aria-checked' | 'aria-label' | 'onChange' | 'onClick'> {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Show a clickable label/description row instead of the compact indicator. */
  showLabel?: boolean;
  description?: ReactNode;
}

/** Controlled on/off switch with native Space/Enter activation and no persistence.
 * Compact and labeled-row variants share indicator geometry and focus/disabled states.
 * The caller owns asynchronous saves; use disabled while a write is pending.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(({
  label, checked, onCheckedChange, showLabel = false, description,
  disabled = false, className, 'aria-describedby': describedBy, ...props
}, ref) => {
  const descriptionId = useId();
  const hasDescription = showLabel && description != null;
  const descriptionIds = [describedBy, hasDescription ? descriptionId : undefined].filter(Boolean).join(' ') || undefined;
  return <button {...props} ref={ref} type="button" role="switch" aria-label={label}
    aria-checked={checked} aria-describedby={descriptionIds} disabled={disabled}
    onClick={() => { if (!disabled) onCheckedChange(!checked); }}
    className={cn(CONTROL_BASE_CLASSES, 'inline-flex shrink-0 items-center gap-4 text-left',
      showLabel ? 'w-full justify-between px-4 py-3 hover:bg-app-surface/30' : 'h-8 p-0', className)}>
    {showLabel && <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium text-app-text">{label}</span>
      {hasDescription && <span id={descriptionId} className="mt-0.5 block text-xs text-app-muted">{description}</span>}
    </span>}
    <span aria-hidden="true" className={cn(
      'relative block h-[var(--zync-switch-height)] w-[var(--zync-switch-width)] shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none',
      checked ? 'bg-app-accent' : 'bg-app-border shadow-[inset_0_0_0_1px_var(--color-app-muted)]',
    )}>
      {/* Derive the circle from the rendered track, not an independent size/travel token.
          An inset outline avoids changing the content box between on and off states. */}
      <span className={cn(
        'absolute top-[var(--zync-switch-inset)] bottom-[var(--zync-switch-inset)] aspect-square rounded-full bg-[var(--zync-switch-thumb-color)] shadow-sm transition-[left,translate] duration-150 motion-reduce:transition-none',
        checked ? 'left-[calc(100%-var(--zync-switch-inset))] -translate-x-full' : 'left-[var(--zync-switch-inset)] translate-x-0',
      )} />
    </span>
  </button>;
});
Switch.displayName = 'Switch';
