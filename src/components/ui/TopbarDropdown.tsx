import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function TopbarDropdown({
  children,
  align = 'left',
  widthClass = 'w-48',
  className,
  ...props
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  widthClass?: string;
  className?: string;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(
        "absolute top-full mt-2 bg-app-panel border border-app-border rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 p-1",
        widthClass,
        align === 'right' ? 'right-0' : 'left-0',
        className,
      )}
    >
      {children}
    </div>
  );
}
