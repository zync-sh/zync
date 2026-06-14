import { Skeleton } from '../../../ui/Skeleton';

interface VaultSectionSkeletonProps {
  title: string;
}

export function VaultSectionSkeleton({ title }: VaultSectionSkeletonProps) {
  return (
    <div className="space-y-2" aria-hidden="true">
      <p className="px-1 text-xs font-semibold uppercase tracking-wider text-app-muted">{title}</p>
      <div className="rounded-xl border border-dashed border-app-border/50 bg-app-surface/10 px-4 py-8">
        <Skeleton className="mx-auto h-10 w-10 rounded-lg" />
        <Skeleton className="mx-auto mt-4 h-4 w-64 max-w-full" />
        <Skeleton className="mx-auto mt-3 h-8 w-28 rounded-md" />
      </div>
    </div>
  );
}