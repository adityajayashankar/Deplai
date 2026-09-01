/**
 * Platform models exposed for security remediation (OpenRouter upstream).
 * Curated free and paid minimax, GLM, and OpenRouter-hosted models.
 */
export const REMEDIATION_PLATFORM_MODEL_IDS = [
  'minimax:MiniMax-M3-free',
  'minimax:MiniMax-M3',
  'glm:glm-5',
  'glm:glm-5.2-free',
  'openrouter:nemotron-3.5-content-safety-free',
] as const;

export type RemediationPlatformModelId = (typeof REMEDIATION_PLATFORM_MODEL_IDS)[number];

/** Default remediation model — OpenRouter slug z-ai/glm-5.2:free */
export const DEFAULT_REMEDIATION_PLATFORM_MODEL = 'glm-5.2-free';

const REMEDIATION_MODEL_SET = new Set<string>(REMEDIATION_PLATFORM_MODEL_IDS);

export function isRemediationPlatformModelId(modelId: string): boolean {
  return REMEDIATION_MODEL_SET.has(modelId.trim());
}

export function filterRemediationPlatformModels<T extends { id: string }>(models: T[]): T[] {
  return models.filter((model) => isRemediationPlatformModelId(model.id));
}
