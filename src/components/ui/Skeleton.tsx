import { cn } from '../../lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        'rounded-md bg-app-surface/50 motion-safe:animate-pulse motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}
