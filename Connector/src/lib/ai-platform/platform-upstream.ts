import { firstEnv } from './config';
import { isPlatformModelAllowed, PLATFORM_ALLOWLIST_PROVIDER_IDS } from './platform-allowlist';
import type { AccessMode } from './types';

export function platformOpenRouterMasterKey(): string {
  return firstEnv(['OPENROUTER_API_KEY']);
}

export function isPlatformOpenRouterUpstream(): boolean {
  const raw = String(process.env.AI_PLATFORM_UPSTREAM_OPENROUTER || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') {
    return Boolean(platformOpenRouterMasterKey() || openRouterManagementKey());
  }
  return Boolean(platformOpenRouterMasterKey());
}

export function openRouterManagementKey(): string {
  return firstEnv(['OPENROUTER_MANAGEMENT_KEY', 'OPENROUTER_PROVISIONING_KEY']);
}

export function openRouterProvisioningEnabled(): boolean {
  return Boolean(openRouterManagementKey());
}

/** Route managed platform traffic through OpenRouter when the model is allowlisted. */
export function shouldUsePlatformOpenRouterUpstream(input: {
  accessMode: AccessMode;
  modelId: string;
  hasEphemeralApiKey?: boolean;
}): boolean {
  if (!isPlatformOpenRouterUpstream()) return false;
  if (input.hasEphemeralApiKey || input.accessMode === 'byok') return false;
  return isPlatformModelAllowed(input.modelId);
}

export function expandProvidersForPlatformOpenRouter(
  accessMode: AccessMode,
  available: Set<string>,
  hasOrgOrMasterOpenRouter: boolean,
): Set<string> {
  if (!isPlatformOpenRouterUpstream() || !hasOrgOrMasterOpenRouter) return available;
  if (accessMode === 'byok') return available;
  const next = new Set(available);
  next.add('openrouter');
  for (const providerId of PLATFORM_ALLOWLIST_PROVIDER_IDS) {
    next.add(providerId);
  }
  return next;
}

export function providerBudgetPaiseToUsdLimit(paise: number, fxInrPerUsd = 95): number {
  if (!Number.isFinite(paise) || paise <= 0) return 0;
  const inr = paise / 100;
  const usd = inr / Math.max(1, fxInrPerUsd);
  return Math.max(0.5, Math.round(usd * 100) / 100);
}
