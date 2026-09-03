function CommandHeaderSkeleton({ section }: { section: string }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-[#05060a] px-5">
      <div className="flex items-center gap-2">
        <div className="h-3 w-14 bg-white/10 animate-pulse" />
        <div className="h-3 w-3 bg-white/10 animate-pulse" />
        <div className="h-3 w-20 bg-white/10 animate-pulse" />
      </div>
    </div>
  );
}

function PageShellSkeleton({ section, fields = 3 }: { section: string; fields?: number }) {
  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <CommandHeaderSkeleton section={section} />
        <div className="flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="h-3 w-28 bg-neutral-200 animate-pulse" />
            <div className="h-7 w-40 bg-neutral-200 animate-pulse" />
            <div className="h-4 w-72 bg-neutral-100 animate-pulse" />
            <div className="mt-8 border-[3px] border-neutral-200 p-6 space-y-4">
              {Array.from({ length: fields }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="h-3 w-20 bg-neutral-200 animate-pulse" />
                  <div className="h-10 bg-neutral-100 animate-pulse border-[3px] border-neutral-200" style={{ animationDelay: `${i * 40}ms` }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export { PageShellSkeleton, CommandHeaderSkeleton };
