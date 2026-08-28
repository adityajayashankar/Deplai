import { FREE_PLAN_ID } from '@/lib/billing/credits-policy';
import { LOGICAL_ALIASES } from './types';
import type { AccessMode } from './types';

export const FREE_PLATFORM_ALIASES = ['best_fast', 'best_cost'] as const;

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

export function assertPlatformModelAllowed(
  planId: string | null | undefined,
  model: string,
): { ok: true } | { ok: false; message: string } {
  const requested = model.trim();
  if (!requested) {
    return { ok: false, message: 'Select a platform model to continue.' };
  }
  const aliases = platformAliasesForPlan(planId);
  if (aliases.includes(requested)) return { ok: true };
  if (isLogicalAliasName(requested) && !aliases.includes(requested)) {
    return {
      ok: false,
      message:
        'Your current plan includes DeplAI Fast and Cost-optimized models. Upgrade to Starter to use flagship platform models, or connect a BYOK key.',
    };
  }
  if (planAllowsCatalogModels(planId)) return { ok: true };
  return {
    ok: false,
    message:
      'Specific vendor models on the platform require a Starter plan or higher. Connect a BYOK key to use your own models, or upgrade your subscription.',
  };
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
  return hasOpenPlatformAccess(planId) ? 'best_coding' : 'best_fast';
}

export function parseAccessMode(value: unknown): AccessMode | null {
  if (value === 'platform' || value === 'byok' || value === 'auto') return value;
  return null;
}
