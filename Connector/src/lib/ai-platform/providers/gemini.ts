import { platformTimeoutMs } from '../config';
import { AiPlatformError, classifyProviderMessage, sanitizeProviderBody } from '../errors';
import type {
  AdapterChatRequest,
  AdapterChatResponse,
  CanonicalStreamEvent,
  DiscoveredModel,
  ProviderDefinition,
  ProviderHealthSnapshot,
} from '../types';
import type { AIProviderAdapter, CredentialValidation } from './adapter';
import { OpenAICompatibleAdapter } from './openai-compatible';

export class GeminiAdapter implements AIProviderAdapter {
  constructor(readonly definition: ProviderDefinition) {}

  private openaiCompat = new OpenAICompatibleAdapter({
    ...this.definition,
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });

  normalizeError(error: unknown): AiPlatformError {
    return this.openaiCompat.normalizeError(error);
  }

  private nativeUrl(path: string, secret: string): string {
    const join = path.includes('?') ? '&' : '?';
    return `${this.definition.apiBaseUrl}${path}${join}key=${encodeURIComponent(secret)}`;
  }

  async listModels(secret: string): Promise<DiscoveredModel[]> {
    const response = await fetch(this.nativeUrl('/models', secret), {
      signal: AbortSignal.timeout(platformTimeoutMs()),
    });
    const raw = await response.text();
    if (!response.ok) {
      const code = classifyProviderMessage(response.status, raw);
      throw new AiPlatformError(code, code === 'AUTHENTICATION_ERROR' ? 'Authentication failed' : 'Provider unavailable', {
        providerId: this.definition.id,
        sanitizedProviderDetail: sanitizeProviderBody(raw),
      });
    }
    const data = JSON.parse(raw) as { models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number }> };
    return (data.models || [])
      .map((model) => ({
        providerModelId: String(model.name || '').replace(/^models\//, ''),
        displayName: model.displayName,
        contextWindow: model.inputTokenLimit,
        metadata: model as unknown as Record<string, unknown>,
      }))
      .filter((model) => model.providerModelId);
  }

  async validateCredentials(secret: string): Promise<CredentialValidation> {
    try {
      const models = await this.listModels(secret);
      return { ok: true, code: 'valid', message: 'Credential valid', modelsDiscovered: models.length };
    } catch (error) {
      const normalized = this.normalizeError(error);
      if (normalized.code === 'AUTHENTICATION_ERROR') {
        return { ok: false, code: 'authentication_failed', message: 'Authentication failed', modelsDiscovered: 0 };
      }
      return { ok: false, code: 'provider_unavailable', message: 'Provider unavailable', modelsDiscovered: 0 };
    }
  }

  async healthCheck(secret: string): Promise<ProviderHealthSnapshot> {
    const started = Date.now();
    try {
      await this.listModels(secret);
      return {
        providerId: this.definition.id,
        status: 'Healthy',
        availability: 1,
        latencyMs: Date.now() - started,
        errorRate: 0,
        rateLimitRate: 0,
        timeoutRate: 0,
        checkedAt: new Date().toISOString(),
        detail: null,
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return {
        providerId: this.definition.id,
        status: 'Unavailable',
        availability: 0,
        latencyMs: Date.now() - started,
        errorRate: 1,
        rateLimitRate: 0,
        timeoutRate: normalized.code === 'TIMEOUT' ? 1 : 0,
        checkedAt: new Date().toISOString(),
        detail: normalized.message,
      };
    }
  }

  chat(input: AdapterChatRequest): Promise<AdapterChatResponse> {
    return this.openaiCompat.chat(input);
  }

  stream(input: AdapterChatRequest): AsyncGenerator<CanonicalStreamEvent> {
    return this.openaiCompat.stream(input);
  }

  embeddings(input: { secret: string; model: string; input: string[] }) {
    return this.openaiCompat.embeddings!(input);
  }
}
