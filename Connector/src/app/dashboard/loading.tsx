/**
 * Dashboard-level loading skeleton.
 * Next.js App Router shows this file automatically during any navigation
 * into /dashboard/* while the page JS is loading, eliminating blank flashes.
 */
export default function DashboardLoading() {
  return (
    <div className="flex h-full flex-col p-8 gap-6 bg-white">
      {/* Breadcrumb shimmer */}
      <div className="h-3 w-24 rounded-none bg-neutral-200 animate-pulse" />
      {/* Page title shimmer */}
      <div className="h-7 w-48 rounded-none bg-neutral-200 animate-pulse" />
      {/* Sub-text shimmer */}
      <div className="h-4 w-80 rounded-none bg-neutral-100 animate-pulse" />
      {/* Card grid shimmer */}
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-28 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
