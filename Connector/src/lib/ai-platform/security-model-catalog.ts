import type { CanonicalModel } from './types';
import { AiPlatformError } from './errors';

type CatalogRow = {
  id: string; name?: string; context_length?: number;
  pricing?: Record<string, unknown>;
  top_provider?: { max_completion_tokens?: number };
  supported_parameters?: string[];
  benchmarks?: { artificial_analysis?: { coding_index?: number } };
};

let cache: { expires: number; rows: CatalogRow[] } | undefined;
let pending: Promise<CatalogRow[]> | undefined;

async function catalog(): Promise<CatalogRow[]> {
  if (cache && cache.expires > Date.now()) return cache.rows;
  pending ??= (async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    if (!response.ok) throw new AiPlatformError('PROVIDER_UNAVAILABLE', 'Cannot verify remediation model availability and pricing');
    const data = await response.json() as { data?: CatalogRow[] };
    if (!Array.isArray(data.data)) throw new AiPlatformError('PROVIDER_UNAVAILABLE', 'Invalid OpenRouter catalog');
    cache = { rows: data.data, expires: Date.now() + 5 * 60_000 };
    return data.data;
  })().finally(() => { pending = undefined; });
  return pending;
}

/** Deployment uses GLM only, with current provider metadata and normal wallet metering. */
export async function deploymentGlmModel(template: CanonicalModel): Promise<CanonicalModel> {
  const row = (await catalog()).find((item) => item.id === 'z-ai/glm-5.3-flash');
  const input = row?.pricing?.prompt == null ? NaN : Number(row.pricing.prompt);
  const output = row?.pricing?.completion == null ? NaN : Number(row.pricing.completion);
  if (!row || ![input, output].every((value) => Number.isFinite(value) && value >= 0)
    || !row.context_length || !row.top_provider?.max_completion_tokens) {
    throw new AiPlatformError('MODEL_NOT_FOUND', 'GLM deployment model availability or pricing could not be verified');
  }
  return {
    ...template, id: `openrouter:${row.id}`, providerId: 'openrouter', providerModelId: row.id,
    displayName: row.name || row.id, aliases: [row.id], family: 'glm', status: 'active', lifecycle: 'ACTIVE',
    contextWindow: row.context_length, maxOutputTokens: Math.min(4000, row.top_provider.max_completion_tokens),
    capabilities: { ...template.capabilities, coding: true, agents: true },
    pricing: { inputPerMillionUsd: input * 1e6, outputPerMillionUsd: output * 1e6, currency: 'USD', source: 'provider_declared' },
    metadata: { openrouter_slug: row.id }, updatedAt: new Date().toISOString(),
  };
}

/**
 * Remediation uses only current OpenRouter ``:free`` coding variants. Native
 * structured output is deliberately not a prerequisite: the workflow applies
 * its strict JSON contracts locally because providers inconsistently reject
 * json_schema requests even when normal JSON generation succeeds.
 */
export function eligibleSecurityRow(row: CatalogRow): boolean {
  const pricing = row.pricing;
  if (!pricing || pricing.prompt == null || pricing.completion == null) return false;
  const input = Number(pricing.prompt), output = Number(pricing.completion);
  if (![input, output].every((n) => Number.isFinite(n) && n >= 0)) return false;
  if (input !== 0 || output !== 0 || !row.id.endsWith(':free')) return false;
  // Unknown surcharges or tiered prices cannot support a hard cost guarantee.
  if (Object.entries(pricing).some(([key, value]) =>
    !['prompt', 'completion', 'input_cache_read', 'input_cache_write'].includes(key)
      && value != null && value !== '0' && value !== 0)) return false;
  return (row.benchmarks?.artificial_analysis?.coding_index ?? 0) >= 30
    && (row.context_length ?? 0) >= 16_384
    && (row.top_provider?.max_completion_tokens ?? 0) >= 4096
    && !/safety|guard|moderation|embed|:batch/i.test(row.id);
}

export async function securityModels(template: CanonicalModel): Promise<CanonicalModel[]> {
  return (await catalog()).filter(eligibleSecurityRow).map((row) => ({
    ...template,
    id: `openrouter:${row.id}`, providerId: 'openrouter' as const, providerModelId: row.id,
    displayName: row.name || row.id, aliases: [], status: 'active' as const, lifecycle: 'ACTIVE' as const,
    // Pricing and availability came from the live OpenRouter catalog above,
    // rather than the arbitrary seed model used as a type template.
    updatedAt: new Date().toISOString(),
    contextWindow: row.context_length!, maxOutputTokens: row.top_provider!.max_completion_tokens!,
    capabilities: { ...template.capabilities, coding: true, structured_output: Boolean(row.supported_parameters?.includes('structured_outputs')),
      scores: { coding: { value: row.benchmarks!.artificial_analysis!.coding_index! / 100, source: 'benchmark_verified' as const } } },
    pricing: { inputPerMillionUsd: Number(row.pricing!.prompt) * 1e6,
      outputPerMillionUsd: Number(row.pricing!.completion) * 1e6, currency: 'USD' as const, source: 'provider_declared' as const },
    metadata: { securityCatalogVerifiedAt: new Date().toISOString(), codingIndex: row.benchmarks!.artificial_analysis!.coding_index },
  }));
}
