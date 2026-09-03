export default function BillingLoading() {
  return (
    <div className="flex h-full flex-col bg-white">
      {/* Tab bar */}
      <div className="border-b-[3px] border-black px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="h-3 w-16 bg-neutral-200 animate-pulse" />
          <div className="flex border-[3px] border-neutral-200">
            <div className="h-8 w-20 bg-neutral-100 animate-pulse" />
            <div className="h-8 w-24 bg-neutral-50 animate-pulse" />
          </div>
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="h-7 w-32 bg-neutral-200 animate-pulse" />
          <div className="h-4 w-80 bg-neutral-100 animate-pulse" />
          {/* Plan cards */}
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-64 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse"
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
