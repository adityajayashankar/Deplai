import type { CanonicalModel } from './types';
import { LOGICAL_ALIASES } from './types';
import { OPENROUTER_MODEL_SLUGS } from './openrouter-catalog';

function isLogicalAlias(value: string): boolean {
  return (LOGICAL_ALIASES as readonly string[]).includes(value.trim() as typeof LOGICAL_ALIASES[number]);
}

function openRouterSlugForModel(model: CanonicalModel): string {
  const metadataSlug = String(model.metadata?.openrouter_slug || '').trim();
  if (metadataSlug) return metadataSlug;
  try {
    return OPENROUTER_MODEL_SLUGS[model.id as keyof typeof OPENROUTER_MODEL_SLUGS] || '';
  } catch {
    return '';
  }
}

export function modelMatchesRequest(model: CanonicalModel, requested: string): boolean {
  const needle = requested.trim().toLowerCase();
  if (!needle) return false;
  if (model.id.toLowerCase() === needle) return true;
  if (model.providerModelId.toLowerCase() === needle) return true;
  if (model.aliases.some((alias) => alias.toLowerCase() === needle)) return true;
  const slug = openRouterSlugForModel(model).toLowerCase();
  if (slug && slug === needle) return true;
  if (needle.startsWith('openrouter:') && slug && needle.slice('openrouter:'.length) === slug) return true;
  return false;
}

/**
 * Map UI / agent / OpenRouter discovery ids to the catalog providerModelId used for routing.
 */
export function canonicalizeRequestedModel(requested: string, models: CanonicalModel[]): string {
  const trimmed = requested.trim();
  if (!trimmed || isLogicalAlias(trimmed)) return trimmed;

  for (const model of models) {
    if (modelMatchesRequest(model, trimmed)) {
      return model.providerModelId;
    }
  }

  const lower = trimmed.toLowerCase();
  for (const [catalogId, slug] of Object.entries(OPENROUTER_MODEL_SLUGS)) {
    if (slug.toLowerCase() === lower || catalogId.toLowerCase() === lower) {
      const hit = models.find((model) => model.id === catalogId);
      if (hit) return hit.providerModelId;
    }
  }

  if (lower.startsWith('openrouter:')) {
    const slug = lower.slice('openrouter:'.length);
    for (const [catalogId, mappedSlug] of Object.entries(OPENROUTER_MODEL_SLUGS)) {
      if (mappedSlug.toLowerCase() === slug) {
        const hit = models.find((model) => model.id === catalogId);
        if (hit) return hit.providerModelId;
      }
    }
    const discovered = models.find((model) => model.id.toLowerCase() === lower);
    if (discovered) return discovered.providerModelId;
  }

  if (lower.includes(':') && !lower.startsWith('openrouter:')) {
    const providerModelId = trimmed.split(':').slice(1).join(':');
    const hit = models.find((model) => model.providerModelId.toLowerCase() === providerModelId.toLowerCase());
    if (hit) return hit.providerModelId;
  }

  return trimmed;
}
