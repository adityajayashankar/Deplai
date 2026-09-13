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

export const PAID_REMEDIATION_MODEL = 'z-ai/glm-5.3-flash';
export function configuredRemediationModel(): string {
  return process.env.SECURITY_REMEDIATION_MODEL === PAID_REMEDIATION_MODEL
    ? PAID_REMEDIATION_MODEL : DEFAULT_REMEDIATION_PLATFORM_MODEL;
}
export function paidRemediationModel(template: CanonicalModel): CanonicalModel {
  const base = openRouterFreeRemediationModel(template);
  return { ...base, id: `openrouter:${PAID_REMEDIATION_MODEL}`, providerModelId: PAID_REMEDIATION_MODEL,
    displayName: 'GLM 5.3 Flash', family: 'glm', aliases: [PAID_REMEDIATION_MODEL],
    contextWindow: 200_000, maxOutputTokens: 4096,
    pricing: { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.50, currency: 'USD', source: 'provider_declared' },
    metadata: { ...base.metadata, openrouter_slug: PAID_REMEDIATION_MODEL, security_free_router: false, security_paid_remediation: true },
  };
}
