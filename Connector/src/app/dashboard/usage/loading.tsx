function SkeletonRow({ cols = 3, height = 'h-10' }: { cols?: number; height?: string }) {
  return (
    <div className={`grid gap-4`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className={`${height} bg-neutral-100 animate-pulse border-[3px] border-neutral-200`} style={{ animationDelay: `${i * 30}ms` }} />
      ))}
    </div>
  );
}

export default function UsageLoading() {
  return (
    <div className="flex h-full flex-col p-8 gap-6 bg-white">
      <div className="h-3 w-20 bg-neutral-200 animate-pulse" />
      <div className="h-7 w-36 bg-neutral-200 animate-pulse" />
      <div className="h-4 w-72 bg-neutral-100 animate-pulse" />
      {/* Stats row */}
      <div className="mt-4">
        <SkeletonRow cols={4} height="h-20" />
      </div>
      {/* Chart area */}
      <div className="mt-2 h-64 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
      {/* Table */}
      <div className="mt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 bg-neutral-100 animate-pulse" style={{ animationDelay: `${i * 40}ms` }} />
        ))}
      </div>
    </div>
  );
}
