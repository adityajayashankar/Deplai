function SkeletonLine({ w = 'w-32', h = 'h-4' }: { w?: string; h?: string }) {
  return <div className={`${h} ${w} rounded bg-surface-alt animate-pulse`} />;
}

function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className="h-24 rounded-xl border border-border bg-surface animate-pulse" style={{ animationDelay: `${i * 40}ms` }} />
      ))}
    </div>
  );
}

export default function ConsoleLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <SkeletonLine w="w-48" h="h-7" />
        <SkeletonLine w="w-72" h="h-4" />
      </div>
      <SkeletonRow cols={4} />
      {/* Table skeleton */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="h-10 bg-surface-alt border-b border-border animate-pulse" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-12 border-b border-border animate-pulse"
            style={{ background: 'var(--surface)', animationDelay: `${i * 35}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
