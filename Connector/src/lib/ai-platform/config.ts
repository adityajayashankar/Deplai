import type { AccessMode, ProviderId } from './types';

function envFlag(name: string, fallback = true): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isAiPlatformEnabled(): boolean {
  return envFlag('AI_PLATFORM_ENABLED', true);
}

export function isFeatureEnabled(
  flag:
    | 'ai_byok'
    | 'ai_dynamic_models'
    | 'ai_routing'
    | 'ai_fallback'
    | 'ai_playground'
    | 'ai_benchmarking'
    | 'ai_self_hosted',
): boolean {
  const envName = {
    ai_byok: 'AI_BYOK_ENABLED',
    ai_dynamic_models: 'AI_MODEL_SYNC_ENABLED',
    ai_routing: 'AI_ROUTING_ENABLED',
    ai_fallback: 'AI_FALLBACK_ENABLED',
    ai_playground: 'AI_PLAYGROUND_ENABLED',
    ai_benchmarking: 'AI_BENCHMARKING_ENABLED',
    ai_self_hosted: 'AI_SELF_HOSTED_ENABLED',
  }[flag];
  const fallback = flag !== 'ai_benchmarking' && flag !== 'ai_self_hosted';
  return isAiPlatformEnabled() && envFlag(envName, fallback);
}

export function isProviderEnabled(providerId: ProviderId): boolean {
  const envName = `AI_PROVIDER_${String(providerId).toUpperCase()}_ENABLED`;
  return envFlag(envName, true);
}

export function defaultAccessMode(): AccessMode {
  const raw = (process.env.AI_DEFAULT_ACCESS_MODE || 'auto').trim().toLowerCase();
  if (raw === 'platform' || raw === 'byok' || raw === 'auto') return raw;
  return 'auto';
}

export function defaultRoutingPolicyName(): string {
  return (process.env.AI_DEFAULT_ROUTING_POLICY || 'default').trim() || 'default';
}

export function modelSyncIntervalMs(): number {
  return Math.max(60_000, envNumber('AI_MODEL_SYNC_INTERVAL', 6 * 60 * 60 * 1000));
}

export function maxRequestCostUsd(): number | null {
  const value = envNumber('AI_MAX_REQUEST_COST', NaN);
  return Number.isFinite(value) ? value : null;
}

export function maxContextTokens(): number {
  return envNumber('AI_MAX_CONTEXT', 1_000_000);
}

export function crossProviderFallbackEnabled(): boolean {
  return envFlag('AI_ENABLE_CROSS_PROVIDER_FALLBACK', true);
}

export function platformTimeoutMs(): number {
  return envNumber('AI_PROVIDER_TIMEOUT_MS', 90_000);
}

export function firstEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}
