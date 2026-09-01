const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../docs/guide');
const outFile = path.resolve(__dirname, '../src/features/docs/guide-pages.ts');

const pages = [
  { slug: 'introduction', file: 'introduction.md', group: 'start', label: 'Introduction', eyebrow: 'Start here' },
  { slug: 'concepts', file: 'concepts.md', group: 'start', label: 'Core concepts', eyebrow: 'Start here' },
  { slug: 'byok-models', file: 'byok-models.md', group: 'start', label: 'BYOK models', eyebrow: 'Start here' },
  { slug: 'how-it-works', file: 'how-it-works.md', group: 'start', label: 'How it works', eyebrow: 'Start here' },
  { slug: 'getting-started', file: 'getting-started.md', group: 'start', label: 'Getting started', eyebrow: 'Start here' },
  { slug: 'security-agent', file: 'agents/security-agent.md', group: 'services', label: 'Security Agent', eyebrow: 'Services' },
  { slug: 'dast', file: 'dast.md', group: 'services', label: 'DAST', eyebrow: 'Services' },
  { slug: 'deploy', file: 'agents/deploy.md', group: 'services', label: 'Deploy', eyebrow: 'Services' },
  { slug: 'instance-management', file: 'instance-management.md', group: 'services', label: 'Instance management', eyebrow: 'Services' },
  { slug: 'uiux-customizer', file: 'agents/uiux-customizer.md', group: 'services', label: 'UI/UX customizer', eyebrow: 'Services' },
  { slug: 'code-reviewer', file: 'agents/code-reviewer.md', group: 'services', label: 'Code Reviewer', eyebrow: 'Services' },
  { slug: 'sessions', file: 'sessions.md', group: 'services', label: 'Sessions', eyebrow: 'Services' },
  { slug: 'organizations', file: 'organizations.md', group: 'account', label: 'Organizations', eyebrow: 'Account' },
  { slug: 'billing', file: 'billing.md', group: 'account', label: 'Plans and credits', eyebrow: 'Account' },
  { slug: 'profile-usage-and-invoices', file: 'profile-usage-and-invoices.md', group: 'account', label: 'Profile and usage', eyebrow: 'Account' },
  { slug: 'security-and-data', file: 'security-and-data.md', group: 'account', label: 'Security and data', eyebrow: 'Account' },
  { slug: 'glossary', file: 'glossary.md', group: 'help', label: 'Glossary and FAQ', eyebrow: 'Help' },
];

const entries = pages.map((page) => {
  const { file: _file, ...meta } = page;
  const markdown = fs.readFileSync(path.join(root, page.file), 'utf8').replace(/\r\n/g, '\n');
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const summaryLine = markdown
    .split('\n')
    .find((line) => line.trim() && !line.startsWith('#') && !line.startsWith('```'));
  return { ...meta, title: titleMatch ? titleMatch[1].trim() : page.label, summary: (summaryLine || '').trim(), markdown };
});

const body = `/* Generated from docs/guide. Re-run: node scripts/embed-guide-docs.cjs */

export type GuideGroupId = 'start' | 'services' | 'account' | 'help';

export type GuidePage = {
  slug: string;
  group: GuideGroupId;
  label: string;
  eyebrow: string;
  title: string;
  summary: string;
  markdown: string;
};

export const GUIDE_PAGES: GuidePage[] = ${JSON.stringify(entries, null, 2)};

export const GUIDE_GROUPS: Array<{ id: GuideGroupId; label: string; slugs: string[] }> = [
  { id: 'start', label: 'Start here', slugs: ['introduction', 'concepts', 'byok-models', 'how-it-works', 'getting-started'] },
  { id: 'services', label: 'Services', slugs: ['security-agent', 'dast', 'deploy', 'instance-management', 'uiux-customizer', 'code-reviewer', 'sessions'] },
  { id: 'account', label: 'Account', slugs: ['organizations', 'billing', 'profile-usage-and-invoices', 'security-and-data'] },
  { id: 'help', label: 'Help', slugs: ['glossary'] },
];

export const DEFAULT_GUIDE_SLUG = 'introduction';

export function getGuidePage(slug: string | undefined | null): GuidePage {
  return GUIDE_PAGES.find((page) => page.slug === slug) || GUIDE_PAGES[0];
}
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, body);
console.log(`Wrote ${outFile} (${entries.length} pages)`);
