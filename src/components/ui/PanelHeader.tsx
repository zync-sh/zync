import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

export interface PanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'> {
  title: ReactNode;
  /** Supply the existing ID when a parent dialog/region uses aria-labelledby. */
  titleId?: string;
  headingLevel?: 2 | 3 | 4;
  titleClassName?: string;
  description?: ReactNode;
  /** Decorative only. Put meaningful status text in title, description or actions. */
  icon?: ReactNode;
  actions?: ReactNode;
}

/** Presentation-only panel heading. Actions wrap on narrow surfaces; titles truncate.
 * Feature owners retain drag handlers, close guards, permissions and lifecycle.
 */
export const PanelHeader = forwardRef<HTMLDivElement, PanelHeaderProps>(({
  title, titleId, headingLevel = 2, titleClassName, description, icon, actions, className, ...props
}, ref) => {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  return <div {...props} ref={ref} className={cn(
    'flex shrink-0 flex-wrap items-center gap-[var(--zync-panel-header-gap)] min-h-[var(--zync-panel-header-height)] border-b border-app-border px-4 py-2 text-app-text',
    className,
  )}>
    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
      {icon && <span aria-hidden="true" className="inline-flex shrink-0 text-app-accent">{icon}</span>}
      <div className="min-w-0 flex-1">
        <Heading id={titleId} className={cn('truncate text-sm font-medium tracking-tight', titleClassName)}>{title}</Heading>
        {description && <div className="mt-1 break-words text-xs text-app-muted">{description}</div>}
      </div>
    </div>
    {actions && <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-[var(--zync-toolbar-gap)]">{actions}</div>}
  </div>;
});
PanelHeader.displayName = 'PanelHeader';
