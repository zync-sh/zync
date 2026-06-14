import { Skeleton } from '../ui/Skeleton';
import { VaultSectionSkeleton } from '../settings/tabs/vault/VaultSectionSkeleton';
import { VaultStatusCardSkeleton } from '../settings/tabs/vault/VaultStatusCardSkeleton';

/** Suspense fallback while the vault workspace chunk loads. Mirrors the real layout. */
export function VaultWorkspaceLoading() {
  return (
    <div
      className="absolute inset-0 overflow-auto bg-app-bg"
      role="status"
      aria-busy="true"
      aria-label="Loading vault workspace"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
        <section className="rounded-2xl border border-app-border/60 bg-app-surface/30 p-5">
          <Skeleton className="h-5 w-36 rounded-full" />
          <Skeleton className="mt-4 h-8 w-72 max-w-full" />
          <Skeleton className="mt-3 h-4 w-full max-w-xl" />
          <Skeleton className="mt-2 h-4 w-5/6 max-w-lg" />
        </section>

        <VaultStatusCardSkeleton />
        <VaultSectionSkeleton title="Security" />
        <VaultSectionSkeleton title="Stored Items" />
      </div>
    </div>
  );
}