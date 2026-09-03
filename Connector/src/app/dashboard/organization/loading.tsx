export default function OrganizationLoading() {
  return (
    <div className="flex h-full flex-col p-8 gap-6 bg-white">
      <div className="h-3 w-20 bg-neutral-200 animate-pulse" />
      <div className="h-7 w-44 bg-neutral-200 animate-pulse" />
      <div className="h-4 w-72 bg-neutral-100 animate-pulse" />
      <div className="mt-4 flex items-center gap-3">
        <div className="h-10 w-64 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse" />
        <div className="h-10 w-32 border-[3px] border-neutral-200 bg-black/5 animate-pulse" />
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-20 border-[3px] border-neutral-200 bg-white animate-pulse"
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
