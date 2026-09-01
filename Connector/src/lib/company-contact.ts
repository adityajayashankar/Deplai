export type CompanyContact = {
  id: string;
  email: string;
  label: string;
  description: string;
  badge?: string;
};

/** Public Deplai inboxes. Same list as the marketing footer. */
export const COMPANY_CONTACTS: CompanyContact[] = [
  {
    id: 'support',
    email: 'support@deplai.tech',
    label: 'Support',
    description: 'Bugs, outages, billing problems, and account issues.',
  },
  {
    id: 'feature',
    email: 'feature@deplai.tech',
    label: 'Feature requests',
    description: 'Product ideas and feature requests.',
  },
  {
    id: 'demo',
    email: 'demo@deplai.tech',
    label: 'Demo',
    description: 'Product walkthroughs and onboarding.',
  },
  {
    id: 'founders',
    email: 'founders@deplai.tech',
    label: 'Founders',
    description: 'Partnerships and sales.',
  },
  {
    id: 'direct',
    email: 'adityajayashankar@deplai.tech',
    label: 'Direct',
    description: 'Reach Aditya Jayashankar directly.',
  },
];

export const COMPANY_LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy policy' },
  { href: '/terms', label: 'Terms of service' },
] as const;
