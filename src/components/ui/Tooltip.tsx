import { isValidElement, type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils';

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  dismissOnClick?: boolean;
  asChild?: boolean;
}

function shouldDismissTooltip(open: boolean, dismissOnClick: boolean): boolean {
  return open && dismissOnClick;
}

export function Tooltip({
  content,
  children,
  position = 'top',
  className,
  contentClassName,
  disabled = false,
  dismissOnClick = true,
  asChild = true,
}: TooltipProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const handleDismissCapture = (_event: MouseEvent<HTMLElement>) => {
    if (!shouldDismissTooltip(open, dismissOnClick)) return;
    setOpen(false);
  };
  const shouldUseAsChild = asChild && isValidElement(children);

  return (
    <RadixTooltip.Root
      open={disabled ? false : open}
      onOpenChange={(next) => {
        if (!disabled) setOpen(next);
      }}
    >
      <RadixTooltip.Trigger
        asChild={shouldUseAsChild}
        className={cn("relative inline-flex items-center justify-center", className)}
        onClickCapture={handleDismissCapture}
      >
        {children}
      </RadixTooltip.Trigger>

      {!disabled && (
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={position}
            sideOffset={8}
            collisionPadding={8}
            avoidCollisions
            align="center"
            className={cn(
              "z-[99999] px-2.5 py-1.5 bg-app-panel/95 backdrop-blur-md text-app-text text-xs font-medium rounded-md whitespace-nowrap shadow-xl border border-app-border animate-in fade-in duration-150 pointer-events-none",
              "data-[side=top]:slide-in-from-bottom-1",
              "data-[side=bottom]:slide-in-from-top-1",
              "data-[side=left]:slide-in-from-right-1",
              "data-[side=right]:slide-in-from-left-1",
              contentClassName
            )}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      )}
    </RadixTooltip.Root>
  );
}
