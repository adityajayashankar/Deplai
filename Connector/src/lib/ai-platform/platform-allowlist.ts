import type { AccessMode, CanonicalModel, ProviderId } from './types';
import { isSelectableLifecycle } from './catalog/seed';

/**
 * Curated ACTIVE catalog models exposed for DeplAI-managed (platform) LLM calls.
 * Source of truth: catalog/seed.ts — do not add DEPRECATED entries.
 */
export const PLATFORM_MODEL_ALLOWLIST = [
  'openai:gpt-5.6-sol',
  'openai:gpt-5.3-codex',
  'openai:gpt-5.6-terra',
  'openai:gpt-5.6-luna',
  'openai:gpt-5.4-mini',
  'anthropic:claude-sonnet-5',
  'anthropic:claude-opus-5',
  'anthropic:claude-haiku-4-5',
  'gemini:gemini-3.1-pro',
  'gemini:gemini-3.5-flash-lite',
  'xai:grok-4.6',
  'minimax:MiniMax-M3-free',
  'minimax:MiniMax-M3',
  'glm:glm-5',
  'glm:glm-5.2-free',
  'openrouter:nemotron-3.5-content-safety-free',
  'kimi:kimi-k2.5',
  'groq:llama-3.1-8b-instant',
] as const;

export type PlatformAllowlistedModelId = (typeof PLATFORM_MODEL_ALLOWLIST)[number];

const ALLOWLIST_SET = new Set<string>(PLATFORM_MODEL_ALLOWLIST);

export const PLATFORM_ALLOWLIST_PROVIDER_IDS = new Set<ProviderId>(
  PLATFORM_MODEL_ALLOWLIST.map((id) => id.split(':')[0] as ProviderId),
);

export function isPlatformModelAllowed(modelId: string): boolean {
  return ALLOWLIST_SET.has(modelId.trim());
}

export function filterPlatformAllowlistedModels(models: CanonicalModel[]): CanonicalModel[] {
  return models.filter(
    (model) => isSelectableLifecycle(model.lifecycle) && isPlatformModelAllowed(model.id),
  );
}

export function shouldApplyPlatformAllowlist(accessMode: AccessMode): boolean {
  return accessMode === 'platform' || accessMode === 'auto';
}

export function filterModelsForPlatformAccess(
  models: CanonicalModel[],
  accessMode: AccessMode,
  platformUpstreamOpenRouter: boolean,
): CanonicalModel[] {
  if (!platformUpstreamOpenRouter || !shouldApplyPlatformAllowlist(accessMode)) {
    return models;
  }
  return filterPlatformAllowlistedModels(models);
}
