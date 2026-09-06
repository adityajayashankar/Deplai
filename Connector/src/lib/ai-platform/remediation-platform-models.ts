import type { CanonicalModel } from './types';

/** Security remediation is always delegated to OpenRouter's free router. */
export const DEFAULT_REMEDIATION_PLATFORM_MODEL = 'openrouter/free';

/**
 * The `/free` router selects a current free upstream itself. This catalog entry
 * preserves gateway policy, quota, usage, and auditing without exposing an
 * individual upstream-model choice to the user.
 */
export function openRouterFreeRemediationModel(template: CanonicalModel): CanonicalModel {
  return {
    ...template,
    id: 'openrouter:openrouter/free',
    providerId: 'openrouter',
    providerModelId: DEFAULT_REMEDIATION_PLATFORM_MODEL,
    displayName: 'OpenRouter Free',
    family: 'openrouter-free',
    version: 'router',
    aliases: [DEFAULT_REMEDIATION_PLATFORM_MODEL],
    status: 'active',
    lifecycle: 'ACTIVE',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: {
      ...template.capabilities,
      coding: true,
      agents: true,
      structured_output: false,
    },
    pricing: {
      inputPerMillionUsd: 0,
      outputPerMillionUsd: 0,
      currency: 'USD',
      source: 'provider_declared',
    },
    metadata: {
      ...template.metadata,
      openrouter_slug: DEFAULT_REMEDIATION_PLATFORM_MODEL,
      security_free_router: true,
    },
    updatedAt: new Date().toISOString(),
  };
}
