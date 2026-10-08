import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Button } from './Button.js';
import { cn } from '../../lib/utils.js';

export interface IconButtonProps extends Omit<ComponentPropsWithoutRef<typeof Button>, 'children' | 'size' | 'aria-label'> {
  /** Required accessible action name. Supply title separately for supplementary text. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md';
}

/** Named icon-only action with native button semantics and a forwarded focus ref.
 * Defaults to type=button so toolbar actions cannot accidentally submit a form.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(({
  label, icon, size = 'sm', variant = 'ghost', type = 'button', title,
  isLoading, className, ...props
}, ref) => (
  <Button
    {...props}
    ref={ref}
    type={type}
    variant={variant}
    size="icon"
    aria-label={label}
    title={title}
    isLoading={isLoading}
    className={cn(
      'shrink-0 [&>svg]:mr-0',
      size === 'sm' && 'h-[var(--zync-control-height-sm)] w-[var(--zync-control-height-sm)]',
      className,
    )}
  >
    {!isLoading && <span aria-hidden="true" className="pointer-events-none inline-flex items-center justify-center">{icon}</span>}
  </Button>
));
IconButton.displayName = 'IconButton';
