export default function InstancesLoading() {
  return (
    <div className="flex h-full flex-col p-8 gap-6 bg-white">
      <div className="h-3 w-24 bg-neutral-200 animate-pulse" />
      <div className="h-7 w-48 bg-neutral-200 animate-pulse" />
      <div className="h-4 w-72 bg-neutral-100 animate-pulse" />
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-36 border-[3px] border-neutral-200 bg-neutral-50 animate-pulse"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
