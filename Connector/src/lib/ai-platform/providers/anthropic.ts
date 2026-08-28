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

export class AnthropicAdapter implements AIProviderAdapter {
  constructor(readonly definition: ProviderDefinition) {}

  private headers(secret: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': secret,
      'anthropic-version': '2023-06-01',
    };
  }

  normalizeError(error: unknown): AiPlatformError {
    return new OpenAICompatibleAdapter(this.definition).normalizeError(error);
  }

  private async requestJson(secret: string, path: string, init?: RequestInit) {
    const response = await fetch(`${this.definition.apiBaseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(secret), ...(init?.headers as Record<string, string> | undefined) },
      signal: init?.signal ?? AbortSignal.timeout(platformTimeoutMs()),
    });
    const raw = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      data = { raw };
    }
    if (!response.ok) {
      const code = classifyProviderMessage(response.status, raw);
      throw new AiPlatformError(
        code,
        code === 'AUTHENTICATION_ERROR' ? 'Authentication failed' : `${this.definition.displayName} rejected the request`,
        { status: response.status, providerId: this.definition.id, sanitizedProviderDetail: sanitizeProviderBody(raw) },
      );
    }
    return data;
  }

  async listModels(secret: string): Promise<DiscoveredModel[]> {
    const data = await this.requestJson(secret, '/v1/models');
    const items = Array.isArray(data.data) ? data.data : [];
    return items.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        providerModelId: String(row.id || ''),
        displayName: String(row.display_name || row.id || ''),
        metadata: row,
      };
    }).filter((model) => model.providerModelId);
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

  async chat(input: AdapterChatRequest): Promise<AdapterChatResponse> {
    const system = input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const messages = input.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, content: [{ type: 'text', text: message.content }] }));
    const payload: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens || 4096,
      temperature: input.temperature ?? 0.2,
      messages,
    };
    if (system) payload.system = system;
    if (input.tools?.length) {
      payload.tools = input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters || { type: 'object', properties: {} },
      }));
    }
    const data = await this.requestJson(input.secret, '/v1/messages', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: input.signal,
    });
    const content = Array.isArray(data.content) ? data.content : [];
    const text = content
      .filter((part) => (part as { type?: string }).type === 'text')
      .map((part) => String((part as { text?: string }).text || ''))
      .join('');
    const toolCalls = content
      .filter((part) => (part as { type?: string }).type === 'tool_use')
      .map((part) => ({
        name: String((part as { name?: string }).name || 'unknown'),
        arguments: JSON.stringify((part as { input?: unknown }).input ?? {}),
      }));
    const usageRaw = (data.usage || {}) as { input_tokens?: number; output_tokens?: number };
    return {
      text,
      toolCalls,
      finishReason: typeof data.stop_reason === 'string' ? data.stop_reason : null,
      usage: {
        inputTokens: Number(usageRaw.input_tokens || 0),
        outputTokens: Number(usageRaw.output_tokens || 0),
        totalTokens: Number(usageRaw.input_tokens || 0) + Number(usageRaw.output_tokens || 0),
        cachedTokens: 0,
        reasoningTokens: 0,
        toolCalls: toolCalls.length,
        estimated: false,
      },
      providerRequestId: typeof data.id === 'string' ? data.id : null,
    };
  }

  async *stream(input: AdapterChatRequest): AsyncGenerator<CanonicalStreamEvent> {
    const system = input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const messages = input.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, content: [{ type: 'text', text: message.content }] }));
    const response = await fetch(`${this.definition.apiBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(input.secret),
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens || 4096,
        temperature: input.temperature ?? 0.2,
        system: system || undefined,
        messages,
        stream: true,
      }),
      signal: input.signal ?? AbortSignal.timeout(platformTimeoutMs()),
    });
    if (!response.ok || !response.body) {
      const raw = await response.text();
      const code = classifyProviderMessage(response.status, raw);
      yield { type: 'stream.error', code, message: code === 'AUTHENTICATION_ERROR' ? 'Authentication failed' : 'Provider unavailable' };
      return;
    }
    yield { type: 'stream.started', requestId: '', provider: this.definition.id, model: input.model };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n');
      buffer = chunks.pop() || '';
      for (const line of chunks) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        try {
          const json = JSON.parse(payload) as { type?: string; delta?: { text?: string } };
          if (json.type === 'content_block_delta' && json.delta?.text) {
            fullText += json.delta.text;
            yield { type: 'output.delta', text: json.delta.text };
          }
        } catch {
          /* ignore */
        }
      }
    }
    yield {
      type: 'stream.completed',
      response: {
        requestId: '',
        traceId: '',
        providerRequestId: null,
        model: input.model,
        provider: this.definition.id,
        credentialSource: 'platform',
        output: fullText,
        toolCalls: [],
        finishReason: 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          toolCalls: 0,
          estimated: true,
        },
        cost: {
          providerCostUsd: 0,
          platformCostUsd: 0,
          customerChargeUsd: 0,
          billingSource: 'platform',
          estimated: true,
        },
        latencyMs: 0,
        timeToFirstTokenMs: null,
        routingExplanation: [],
        skipped: [],
        fallback: { count: 0, primaryProvider: null, primaryModel: null, failureReason: null },
      },
    };
  }
}
