export default function DeployLoading() {
  return (
    <div className="flex h-full flex-col bg-white">
      {/* Fake stage rail */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-100 px-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-5 w-20 bg-neutral-100 animate-pulse" style={{ animationDelay: `${i * 40}ms` }} />
        ))}
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="h-7 w-40 bg-neutral-200 animate-pulse" />
          <div className="h-4 w-80 bg-neutral-100 animate-pulse" />
          <div className="mt-4 h-48 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="h-32 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
            <div className="h-32 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" style={{ animationDelay: '60ms' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
