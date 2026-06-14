import { Skeleton } from '../../../ui/Skeleton';

export function VaultStatusCardSkeleton() {
  return (
    <div
      className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4"
      role="status"
      aria-busy="true"
      aria-label="Loading vault status"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
        <Skeleton className="h-8 w-24 shrink-0 rounded-md" />
      </div>
    </div>
  );
}