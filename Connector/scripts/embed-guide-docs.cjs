const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../docs/guide');
const outFile = path.resolve(__dirname, '../src/features/docs/guide-pages.ts');

// Only customer-facing pages belong here. README and _internal-review are deliberately excluded.
const groups = [
  {
    id: 'start',
    label: 'Start here',
    pages: [
      ['introduction', 'introduction.md', 'Introduction'],
      ['concepts', 'concepts.md', 'Core concepts'],
      ['how-it-works', 'how-it-works.md', 'Repository to production'],
      ['getting-started', 'getting-started.md', 'Getting started'],
      ['why-deplai', 'why-deplai.md', 'Why DeplAI'],
    ],
  },
  {
    id: 'services',
    label: 'Services',
    pages: [
      ['security-agent', 'agents/security-agent.md', 'Security Agent'],
      ['dast', 'dast.md', 'DAST'],
      ['deploy', 'agents/deploy.md', 'Deploy'],
      ['instance-management', 'instance-management.md', 'Instance management'],
      ['uiux-customizer', 'agents/uiux-customizer.md', 'UI/UX customizer'],
      ['code-reviewer', 'agents/code-reviewer.md', 'Code Reviewer'],
      ['sessions', 'sessions.md', 'Sessions'],
      ['agents-and-workflows', 'agents-and-workflows.md', 'Agents and workflows'],
      ['repository-intelligence', 'repository-intelligence.md', 'Repository intelligence'],
      ['artifacts-and-state', 'artifacts-and-state.md', 'Artifacts and state'],
    ],
  },
  {
    id: 'account',
    label: 'Account and models',
    pages: [
      ['organizations', 'organizations.md', 'Organizations'],
      ['billing', 'billing.md', 'Plans and credits'],
      ['profile-usage-and-invoices', 'profile-usage-and-invoices.md', 'Profile and usage'],
      ['security-and-data', 'security-and-data.md', 'Security and data'],
      ['byok-models', 'byok-models.md', 'BYOK models'],
      ['model-providers', 'model-providers.md', 'Models and providers'],
    ],
  },
  {
    id: 'help',
    label: 'Help and reference',
    pages: [
      ['api-and-automation', 'api-and-automation.md', 'API and automation'],
      ['troubleshooting', 'troubleshooting.md', 'Troubleshooting'],
      ['glossary', 'glossary.md', 'Glossary and FAQ'],
      ['design-principles', 'design-principles.md', 'Design principles'],
      ['platform-architecture', 'platform-architecture.md', 'Platform architecture'],
      ['production-operations', 'production-operations.md', 'Production operations'],
      ['future-direction', 'future-direction.md', 'Future direction'],
    ],
  },
];

const pages = groups.flatMap((group) => group.pages.map(([slug, file, label]) => ({
  slug,
  file,
  label,
  group: group.id,
  eyebrow: group.label,
})));

const entries = pages.map((page) => {
  const { file, ...meta } = page;
  const markdown = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const summaryLine = markdown
    .split('\n')
    .find((line) => line.trim() && !line.startsWith('#') && !line.startsWith('```'));
  return { ...meta, title: titleMatch ? titleMatch[1].trim() : page.label, summary: (summaryLine || '').trim(), markdown };
});

const groupMetadata = groups.map(({ id, label, pages: groupPages }) => ({
  id,
  label,
  slugs: groupPages.map(([slug]) => slug),
}));

const body = `/* Generated from docs/guide. Re-run: node scripts/embed-guide-docs.cjs */

export type GuideGroupId = ${groups.map(({ id }) => `'${id}'`).join(' | ')};

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

export const GUIDE_GROUPS: Array<{ id: GuideGroupId; label: string; slugs: string[] }> = ${JSON.stringify(groupMetadata, null, 2)};

export const DEFAULT_GUIDE_SLUG = 'introduction';

export function getGuidePage(slug: string | undefined | null): GuidePage {
  return GUIDE_PAGES.find((page) => page.slug === slug) || GUIDE_PAGES[0];
}
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, body);
console.log(`Wrote ${outFile} (${entries.length} pages)`);
