import { GUIDE_PAGES } from './guide-pages';

const SLUGS = new Set(GUIDE_PAGES.map((page) => page.slug));

export function headingId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function resolveGuideHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return trimmed;
  if (/^(https?:|mailto:|#)/i.test(trimmed)) return trimmed;
  const [pathPart, hash] = trimmed.replace(/\\/g, '/').split('#');
  const slugRaw = (pathPart.split('/').pop() || '').replace(/\.md$/i, '');
  const slug = slugRaw === 'architecture' ? 'how-it-works' : slugRaw;
  if (SLUGS.has(slug)) {
    return hash ? `/dashboard/documentation/${slug}#${hash}` : `/dashboard/documentation/${slug}`;
  }
  return trimmed;
}

export function extractGuideHeadings(markdown: string): Array<{ id: string; title: string; depth: 2 | 3 }> {
  const headings: Array<{ id: string; title: string; depth: 2 | 3 }> = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!match) continue;
    const depth = match[1].length === 2 ? 2 : 3;
    headings.push({ id: headingId(match[2]), title: match[2].trim(), depth });
  }
  return headings;
}

export function pageMatchesQuery(markdown: string, label: string, title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${label}\n${title}\n${markdown}`.toLowerCase().includes(needle);
}
