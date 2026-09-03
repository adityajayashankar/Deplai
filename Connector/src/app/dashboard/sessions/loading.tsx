export default function SessionsLoading() {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent font-sans">
      {/* Header bar skeleton */}
      <div className="flex h-12 shrink-0 items-center border-b border-white/10 bg-[#05060a] px-6 gap-3">
        <div className="h-3 w-16 bg-white/10 animate-pulse" />
        <div className="h-3 w-3 bg-white/10 animate-pulse" />
        <div className="h-3 w-20 bg-white/10 animate-pulse" />
      </div>
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-5xl space-y-6">
          <div className="h-3 w-20 bg-neutral-200 animate-pulse" />
          <div className="h-7 w-32 bg-neutral-200 animate-pulse" />
          <div className="h-4 w-64 bg-neutral-100 animate-pulse" />
          {/* Filter row */}
          <div className="mt-8 grid gap-3 md:grid-cols-[1fr_180px_160px]">
            <div className="h-10 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
            <div className="h-10 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
            <div className="h-10 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
          </div>
          {/* Session cards */}
          <div className="mt-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-24 border-[3px] border-neutral-200 bg-white animate-pulse"
                style={{ animationDelay: `${i * 50}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
