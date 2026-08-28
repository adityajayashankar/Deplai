'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appInput } from '@/features/workspace/theme';
import { DEFAULT_GUIDE_SLUG, GUIDE_GROUPS, GUIDE_PAGES, getGuidePage } from '@/features/docs/guide-pages';
import { extractGuideHeadings, pageMatchesQuery } from '@/features/docs/guide-links';
import { GuideMarkdown } from '@/features/docs/GuideMarkdown';

function slugFromPath(pathname: string): string {
  const part = pathname.replace('/dashboard/documentation', '').replace(/^\//, '').split('/')[0];
  if (part === 'architecture') return 'how-it-works';
  if (GUIDE_PAGES.some((page) => page.slug === part)) return part;
  return DEFAULT_GUIDE_SLUG;
}

export default function DocumentationApp() {
  const router = useRouter();
  const pathname = usePathname() || '/dashboard/documentation';
  const slug = slugFromPath(pathname);
  const page = getGuidePage(slug);
  const [query, setQuery] = useState('');

  const matchingGroups = useMemo(() => {
    return GUIDE_GROUPS.map((group) => ({
      ...group,
      pages: group.slugs
        .map((item) => GUIDE_PAGES.find((entry) => entry.slug === item))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry) => pageMatchesQuery(entry.markdown, entry.label, entry.title, query)),
    })).filter((group) => group.pages.length > 0);
  }, [query]);

  const headings = useMemo(() => extractGuideHeadings(page.markdown), [page.markdown]);

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    document.getElementById(hash)?.scrollIntoView();
  }, [page.slug]);

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Documentation" onExit={() => router.push('/')} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="hidden w-[280px] shrink-0 flex-col border-r-[3px] border-black bg-white lg:flex">
            <div className="border-b-[3px] border-black p-4">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search the guide"
                  className={`${appInput} pl-9`}
                />
              </label>
            </div>
            <nav className="custom-scrollbar flex-1 overflow-y-auto p-3" aria-label="Guide pages">
              {matchingGroups.map((group) => (
                <div key={group.id} className="mb-4">
                  <p className="px-2 pb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-neutral-500">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {group.pages.map((entry) => {
                      const active = entry.slug === page.slug;
                      return (
                        <button
                          key={entry.slug}
                          type="button"
                          onClick={() => router.push(`/dashboard/documentation/${entry.slug}`)}
                          className={`flex w-full items-center px-3 py-2 text-left text-[13px] font-medium ${
                            active ? 'bg-black text-white' : 'text-black hover:bg-neutral-100'
                          }`}
                        >
                          {entry.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {matchingGroups.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-neutral-500">No pages matched “{query}”.</p>
              ) : null}
            </nav>
          </aside>

          <div className="custom-scrollbar min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto grid max-w-6xl gap-10 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_200px] lg:px-10">
              <article className="min-w-0">
                <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">{page.eyebrow}</p>
                <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-black">{page.title}</h1>
                <p className="mt-3 max-w-3xl text-[15px] leading-7 text-neutral-600">{page.summary}</p>
                <div className="mt-4 lg:hidden">
                  <label className="block text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">Page</label>
                  <select
                    value={page.slug}
                    onChange={(event) => router.push(`/dashboard/documentation/${event.target.value}`)}
                    className={`${appInput} mt-2`}
                  >
                    {GUIDE_PAGES.map((entry) => (
                      <option key={entry.slug} value={entry.slug}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-8">
                  <GuideMarkdown markdown={page.markdown} />
                </div>
              </article>

              <aside className="hidden xl:block">
                <div className="sticky top-6">
                  <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-neutral-500">On this page</p>
                  <div className="space-y-1 border-l-[3px] border-black">
                    {headings.map((heading) => (
                      <a
                        key={`${heading.depth}-${heading.id}`}
                        href={`#${heading.id}`}
                        className={`block py-1 text-[13px] text-neutral-600 hover:text-black ${heading.depth === 3 ? 'pl-5' : 'pl-3'}`}
                      >
                        {heading.title}
                      </a>
                    ))}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
