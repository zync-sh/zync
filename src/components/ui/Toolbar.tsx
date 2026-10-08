import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

export interface ToolbarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-label'> {
  /** Accessible group name, specific to the surrounding feature. */
  label: string;
}

/** Wrapping action-row layout, not an ARIA composite toolbar.
 * Uses a named group and native Tab order; does not intercept keys, clone children,
 * hide actions or own command execution. Callers can override layout classes.
 */
export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps>(({ label, className, ...props }, ref) => (
  <div {...props} ref={ref} role="group" aria-label={label}
    className={cn('flex min-w-0 max-w-full flex-wrap items-center gap-[var(--zync-toolbar-gap)]', className)} />
));
Toolbar.displayName = 'Toolbar';
