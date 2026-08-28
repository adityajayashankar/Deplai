export const MAX_EFFICIENT_POOL = 10;
export const MIN_CUSTOM_CREDIT_USD = 5;
export const MAX_CUSTOM_CREDIT_USD = 500;
export const CUSTOM_CREDIT_PACK_ID = 'custom';
export const DELETE_CONFIRM_PHRASE = 'DELETE';
export const AUTO_TOPUP_DEFAULT_THRESHOLD = 5;
export const AUTO_TOPUP_DEFAULT_ADD = 20;

export const ROUTING_MODES = [
  {
    id: 'default',
    label: 'Use default setting',
    description: 'Uses best accuracy per dollar.',
    primaryAlias: 'best_cost',
  },
  {
    id: 'best',
    label: 'Best overall',
    description: 'Ranks models for the strongest general result.',
    primaryAlias: 'best',
  },
  {
    id: 'best_reasoning',
    label: 'Best reasoning',
    description: 'Prefers models with the highest reasoning score.',
    primaryAlias: 'best_reasoning',
  },
  {
    id: 'best_fast',
    label: 'Best latency',
    description: 'Prefers faster models in the Efficient pool.',
    primaryAlias: 'best_fast',
  },
] as const;

export type RoutingModeId = (typeof ROUTING_MODES)[number]['id'];

export type EfficientPoolEntry = {
  modelId: string;
  variant: string;
};

export type ProfilePatch = {
  displayName?: string;
  email?: string;
  linkedinUrl?: string;
  githubUrl?: string;
};

export function routingModeById(id: string): (typeof ROUTING_MODES)[number] {
  return ROUTING_MODES.find((mode) => mode.id === id) || ROUTING_MODES[0];
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || 'DE';
}

export function referralCodeFromUserId(userId: string): string {
  const compact = userId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return `DPL${(compact.slice(0, 8) || 'ACCOUNT').padEnd(8, 'X')}`;
}

export function maskApiToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  const last4 = trimmed.slice(-4);
  const prefix = trimmed.startsWith('dpl_') ? trimmed.slice(0, 8) : trimmed.slice(0, 4);
  return `${prefix}${'•'.repeat(16)}${last4}`;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function optionalUrl(value: string, host: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'not set') return '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.hostname.toLowerCase().includes(host)) return null;
      return url.toString();
    } catch {
      return null;
    }
  }
  if (host === 'github.com' && /^[A-Za-z0-9-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }
  if (host === 'linkedin.com' && /^[A-Za-z0-9-]+$/.test(trimmed)) {
    return `https://www.linkedin.com/in/${trimmed}`;
  }
  return null;
}

export function normalizeLinkedinUrl(value: string): string | null {
  return optionalUrl(value, 'linkedin.com');
}

export function normalizeGithubUrl(value: string): string | null {
  return optionalUrl(value, 'github.com');
}

export function validateProfilePatch(input: ProfilePatch): { ok: true; value: Required<ProfilePatch> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const displayName = String(input.displayName || '').trim();
  const email = String(input.email || '').trim();
  if (!displayName) errors.displayName = 'Full name is required.';
  else if (displayName.length > 80) errors.displayName = 'Name must be 80 characters or fewer.';
  if (!email) errors.email = 'Email is required.';
  else if (!isValidEmail(email)) errors.email = 'Enter a valid email address.';
  const linkedinUrl = normalizeLinkedinUrl(String(input.linkedinUrl || ''));
  if (linkedinUrl === null) errors.linkedinUrl = 'Enter a LinkedIn profile URL or leave this blank.';
  const githubUrl = normalizeGithubUrl(String(input.githubUrl || ''));
  if (githubUrl === null) errors.githubUrl = 'Enter a GitHub profile URL or username.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      displayName,
      email,
      linkedinUrl: linkedinUrl || '',
      githubUrl: githubUrl || '',
    },
  };
}

export function validateEfficientPool(input: unknown): { ok: true; value: EfficientPoolEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Efficient model pool must be a list.' };
  if (input.length > MAX_EFFICIENT_POOL) {
    return { ok: false, error: `Efficient model pool is limited to ${MAX_EFFICIENT_POOL} models.` };
  }
  const seen = new Set<string>();
  const value: EfficientPoolEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Each pool entry needs a model and variant.' };
    const record = raw as Record<string, unknown>;
    const modelId = String(record.modelId || '').trim();
    const variant = String(record.variant || 'default').trim() || 'default';
    if (!modelId) return { ok: false, error: 'Select a model before adding it to the pool.' };
    const key = `${modelId}::${variant}`.toLowerCase();
    if (seen.has(key)) return { ok: false, error: 'That model and variant is already in the pool.' };
    seen.add(key);
    value.push({ modelId, variant: variant.slice(0, 64) });
  }
  return { ok: true, value };
}

export function validateCustomCreditUsd(value: unknown): { ok: true; amount: number } | { ok: false; error: string } {
  const amount = typeof value === 'number' ? value : Number(String(value || '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount)) return { ok: false, error: 'Enter a dollar amount.' };
  if (amount < MIN_CUSTOM_CREDIT_USD) {
    return { ok: false, error: `Minimum is $${MIN_CUSTOM_CREDIT_USD}.` };
  }
  if (amount > MAX_CUSTOM_CREDIT_USD) {
    return { ok: false, error: `Maximum is $${MAX_CUSTOM_CREDIT_USD}.` };
  }
  if (Math.round(amount) !== amount) {
    return { ok: false, error: 'Use a whole-dollar amount.' };
  }
  return { ok: true, amount };
}

export function validatePromoCode(value: string): { ok: true; code: string } | { ok: false; error: string } {
  const code = value.trim().toUpperCase();
  if (!code) return { ok: false, error: 'Enter a promotional code.' };
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    return { ok: false, error: 'Codes use 3–32 letters, numbers, hyphens, or underscores.' };
  }
  return { ok: true, code };
}

export function formatCreditUsd(totalCredits: number): string {
  const amount = Number(totalCredits);
  if (!Number.isFinite(amount)) return '$0.00';
  const formatted = amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? formatted : formatted;
}

export function creditTone(totalCredits: number): 'positive' | 'warning' | 'negative' {
  if (totalCredits < 0) return 'negative';
  if (totalCredits < 1) return 'warning';
  return 'positive';
}

export function displaySocial(value: string | null | undefined, emptyLabel = 'Not set'): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return emptyLabel;
  return trimmed.replace(/^https?:\/\//i, '');
}
