export default function CreditsLoading() {
  return (
    <div className="flex h-full flex-col p-8 gap-6 bg-white">
      <div className="h-3 w-16 bg-neutral-200 animate-pulse" />
      <div className="h-7 w-32 bg-neutral-200 animate-pulse" />
      <div className="h-4 w-80 bg-neutral-100 animate-pulse" />
      {/* Balance card */}
      <div className="mt-4 h-32 w-full max-w-sm border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
      {/* Transaction list */}
      <div className="mt-4 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-12 bg-neutral-100 animate-pulse border-[3px] border-neutral-200"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
