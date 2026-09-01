import { FREE_PLAN_ID } from '@/lib/billing/credits-policy';
import { LOGICAL_ALIASES } from './types';
import type { AccessMode } from './types';
import { DEFAULT_REMEDIATION_PLATFORM_MODEL } from './remediation-platform-models';

export { DEFAULT_REMEDIATION_PLATFORM_MODEL };

export const FREE_PLATFORM_ALIASES = ['best_fast', 'best_cost'] as const;

/** Concrete platform catalog models available on the free plan when billing is enforced. */
export const FREE_PLATFORM_MODEL_IDS = [
  'claude-haiku-4-5',
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'gemini-3.5-flash-lite',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'glm-5.2-free',
  'MiniMax-M3-free',
  'nemotron-3.5-content-safety-free',
] as const;

export const DEFAULT_PAID_PLATFORM_MODEL = 'grok-4.6';
export const DEFAULT_FREE_PLATFORM_MODEL = 'claude-haiku-4-5';

const PAID_PLAN_PREFIXES = ['starter', 'pro', 'enterprise'] as const;

function envFlag(name: string): string {
  return String(process.env[name] || '').trim().toLowerCase();
}

/**
 * Plan and credit gates stay in the code for a later Razorpay launch.
 * Until BILLING_ENFORCEMENT / NEXT_PUBLIC_BILLING_ENFORCEMENT is true,
 * every signed-in user gets the full platform catalog.
 */
export function isBillingEnforced(): boolean {
  const raw = envFlag('NEXT_PUBLIC_BILLING_ENFORCEMENT') || envFlag('BILLING_ENFORCEMENT');
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function normalizePlanId(planId: string | null | undefined): string {
  const id = (planId || FREE_PLAN_ID).trim().toLowerCase();
  return id || FREE_PLAN_ID;
}

export function isPaidPlanId(planId: string | null | undefined): boolean {
  const id = normalizePlanId(planId);
  if (id === FREE_PLAN_ID) return false;
  return PAID_PLAN_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}_`));
}

function hasOpenPlatformAccess(planId: string | null | undefined): boolean {
  return !isBillingEnforced() || isPaidPlanId(planId);
}

export function platformAliasesForPlan(planId: string | null | undefined): string[] {
  if (hasOpenPlatformAccess(planId)) return [...LOGICAL_ALIASES];
  return [...FREE_PLATFORM_ALIASES];
}

export function planAllowsCatalogModels(planId: string | null | undefined): boolean {
  return hasOpenPlatformAccess(planId);
}

export function isLogicalAliasName(model: string): boolean {
  return (LOGICAL_ALIASES as readonly string[]).includes(model.trim());
}

export function isPlatformModelAllowedForPlan(
  planId: string | null | undefined,
  providerModelId: string,
): boolean {
  const requested = providerModelId.trim();
  if (!requested) return false;
  if (hasOpenPlatformAccess(planId)) return true;
  return (FREE_PLATFORM_MODEL_IDS as readonly string[]).includes(requested);
}

export function assertPlatformModelAllowed(
  planId: string | null | undefined,
  model: string,
): { ok: true } | { ok: false; message: string } {
  const requested = model.trim();
  if (!requested) {
    return { ok: false, message: 'Select a platform model to continue.' };
  }
  if (isLogicalAliasName(requested)) {
    return { ok: false, message: 'Select a specific platform model from the catalog.' };
  }
  if (!isPlatformModelAllowedForPlan(planId, requested)) {
    return {
      ok: false,
      message:
        'Your current plan includes a limited set of platform models. Upgrade to Starter for the full catalog, or connect a BYOK key.',
    };
  }
  return { ok: true };
}

export function defaultRemediationAccessMode(input: {
  planId: string | null | undefined;
  hasByok: boolean;
}): AccessMode {
  if (hasOpenPlatformAccess(input.planId)) return 'platform';
  if (input.hasByok) return 'byok';
  return 'platform';
}

export function defaultRemediationModel(planId: string | null | undefined): string {
  if (!hasOpenPlatformAccess(planId) && isBillingEnforced()) {
    return DEFAULT_FREE_PLATFORM_MODEL;
  }
  return DEFAULT_REMEDIATION_PLATFORM_MODEL;
}

export function parseAccessMode(value: unknown): AccessMode | null {
  if (value === 'platform' || value === 'byok' || value === 'auto') return value;
  return null;
}
