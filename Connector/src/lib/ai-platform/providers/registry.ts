import { isProviderEnabled } from '../config';
import type { ProviderId } from '../types';
import type { AIProviderAdapter } from './adapter';
import { AnthropicAdapter } from './anthropic';
import { PROVIDER_DEFINITIONS } from './definitions';
import { GeminiAdapter } from './gemini';
import { OpenAICompatibleAdapter } from './openai-compatible';

const adapters = new Map<string, AIProviderAdapter>();

for (const definition of PROVIDER_DEFINITIONS) {
  if (definition.id === 'anthropic') {
    adapters.set(definition.id, new AnthropicAdapter(definition));
  } else if (definition.id === 'gemini') {
    adapters.set(definition.id, new GeminiAdapter(definition));
  } else {
    adapters.set(definition.id, new OpenAICompatibleAdapter(definition));
  }
}

export function getAdapter(providerId: ProviderId | string): AIProviderAdapter | null {
  return adapters.get(providerId) ?? null;
}

export function listAdapters(): AIProviderAdapter[] {
  return [...adapters.values()].filter((adapter) => isProviderEnabled(adapter.definition.id));
}

export function listRegisteredProviderIds(): string[] {
  return [...adapters.keys()];
}

export { PROVIDER_DEFINITIONS, canonicalizeProviderId, getProviderDefinition } from './definitions';
export type { AIProviderAdapter, CredentialValidation } from './adapter';
