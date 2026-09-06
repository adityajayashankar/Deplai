import type { CanonicalModel } from './types';
import {
  PLATFORM_MODEL_ALLOWLIST,
  type PlatformAllowlistedModelId,
} from './platform-allowlist';

/**
 * Maps DeplAI catalog model IDs to OpenRouter upstream slugs.
 * Catalog IDs remain the user-facing / metering identity.
 */
export const OPENROUTER_MODEL_SLUGS: Record<PlatformAllowlistedModelId, string> = {
  'openai:gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'openai:gpt-5.3-codex': 'openai/gpt-5.3-codex',
  'openai:gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'openai:gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'openai:gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'anthropic:claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'anthropic:claude-opus-5': 'anthropic/claude-opus-5',
  'anthropic:claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
  'gemini:gemini-3.1-pro': 'google/gemini-3.1-pro',
  'gemini:gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
  'xai:grok-4.6': 'x-ai/grok-4.6',
  'minimax:MiniMax-M3-free': 'minimax/minimax-m3:free',
  'minimax:MiniMax-M3': 'minimax/minimax-m3',
  'glm:glm-5': 'z-ai/glm-5',
  'glm:glm-5.2-free': 'z-ai/glm-5.2:free',
  'openrouter:nemotron-3.5-content-safety-free': 'nvidia/nemotron-3.5-content-safety:free',
  'kimi:kimi-k2.5': 'moonshotai/kimi-k2.5',
  'groq:llama-3.1-8b-instant': 'meta-llama/llama-3.1-8b-instruct',
};

export function resolveOpenRouterSlug(catalogModelId: string): string {
  const mapped = OPENROUTER_MODEL_SLUGS[catalogModelId as PlatformAllowlistedModelId];
  if (mapped) return mapped;
  const [provider, ...rest] = catalogModelId.split(':');
  const model = rest.join(':');
  if (!provider || !model) {
    throw new Error(`Invalid catalog model id: ${catalogModelId}`);
  }
  if (provider === 'openrouter') return model;
  if (provider === 'gemini') return `google/${model}`;
  if (provider === 'xai') return `x-ai/${model}`;
  if (provider === 'kimi') return `moonshotai/${model}`;
  if (provider === 'glm') return `z-ai/${model}`;
  if (provider === 'minimax') return `minimax/${model.toLowerCase()}`;
  return `${provider}/${model}`;
}

export function assertAllowlistOpenRouterCoverage(): void {
  for (const id of PLATFORM_MODEL_ALLOWLIST) {
    if (!OPENROUTER_MODEL_SLUGS[id]) {
      throw new Error(`Missing OpenRouter slug for allowlisted model ${id}`);
    }
  }
}

export type PlatformDispatch = {
  adapterProviderId: 'openrouter' | CanonicalModel['providerId'];
  upstreamModelId: string;
  billingProviderId: CanonicalModel['providerId'];
  billingModelId: string;
};

export function resolvePlatformDispatch(
  model: CanonicalModel,
  platformUpstreamOpenRouter: boolean,
): PlatformDispatch {
  if (!platformUpstreamOpenRouter) {
    return {
      adapterProviderId: model.providerId,
      upstreamModelId: model.providerModelId,
      billingProviderId: model.providerId,
      billingModelId: model.id,
    };
  }
  return {
    adapterProviderId: 'openrouter',
    upstreamModelId: resolveOpenRouterSlug(model.id),
    billingProviderId: model.providerId,
    billingModelId: model.id,
  };
}
