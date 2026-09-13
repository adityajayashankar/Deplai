import { platformTimeoutMs, appOrigin } from '../config';
import { providerRetryHint } from '../retry-delay';
import {
  AiPlatformError,
  CapabilityError,
  classifyProviderMessage,
  sanitizeProviderBody,
} from '../errors';
import type {
  AdapterChatRequest,
  AdapterChatResponse,
  CanonicalStreamEvent,
  DiscoveredModel,
  ProviderDefinition,
  ProviderHealthSnapshot,
  UsageBreakdown,
} from '../types';
import type { AIProviderAdapter, CredentialValidation } from './adapter';

function emptyUsage(estimated = true): UsageBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    estimated,
  };
}

function usageFromOpenAi(data: Record<string, unknown> | undefined): UsageBreakdown {
  const usage = (data?.usage || {}) as Record<string, unknown>;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cached = Number((usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0) || 0;
  const reasoning = Number((usage.completion_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens ?? 0) || 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: Number(usage.total_tokens ?? input + output) || input + output,
    cachedTokens: cached,
    reasoningTokens: reasoning,
    toolCalls: 0,
    estimated: !(input || output),
  };
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  constructor(readonly definition: ProviderDefinition) {}

  protected headers(secret: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    };
    if (this.definition.id === 'openrouter') {
      headers['HTTP-Referer'] = appOrigin();
      headers['X-Title'] = 'DeplAI';
    }
    return headers;
  }

  protected modelsUrl(): string {
    return `${this.definition.apiBaseUrl.replace(/\/$/, '')}/models`;
  }

  protected chatUrl(): string {
    return `${this.definition.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  protected embeddingsUrl(): string {
    return `${this.definition.apiBaseUrl.replace(/\/$/, '')}/embeddings`;
  }

  normalizeError(error: unknown): AiPlatformError {
    if (error instanceof AiPlatformError) return error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new AiPlatformError('TIMEOUT', `${this.definition.displayName} timed out`, {
        providerId: this.definition.id,
        retryable: true,
      });
    }
    return new AiPlatformError(
      'UNKNOWN_PROVIDER_ERROR',
      `${this.definition.displayName} request failed`,
      { providerId: this.definition.id, retryable: true },
    );
  }

  protected async requestJson(
    secret: string,
    url: string,
    init?: RequestInit,
  ): Promise<{ status: number; data: Record<string, unknown>; raw: string }> {
    const response = await fetch(url, {
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
      throw new AiPlatformError(code, this.userFacingError(code), {
        status: response.status,
        providerId: this.definition.id,
        sanitizedProviderDetail: sanitizeProviderBody(raw),
        detail: { ...providerRetryHint(response.headers),
          quotaScope: response.headers.has('x-ratelimit-limit') ? 'account' : 'model',
          resetAt: response.headers.get('x-ratelimit-reset') },
      });
    }
    return { status: response.status, data, raw };
  }

  protected userFacingError(code: ReturnType<typeof classifyProviderMessage>): string {
    switch (code) {
      case 'AUTHENTICATION_ERROR':
        return 'Authentication failed';
      case 'RATE_LIMIT':
        return `${this.definition.displayName} rate limited the request`;
      case 'QUOTA_EXCEEDED':
        return `${this.definition.displayName} quota was exceeded`;
      case 'MODEL_NOT_FOUND':
        return 'Requested model is not available';
      case 'TIMEOUT':
        return `${this.definition.displayName} timed out`;
      case 'PROVIDER_UNAVAILABLE':
        return `${this.definition.displayName} is unavailable`;
      default:
        return `${this.definition.displayName} rejected the request`;
    }
  }

  async listModels(secret: string): Promise<DiscoveredModel[]> {
    const { data } = await this.requestJson(secret, this.modelsUrl());
    const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const discovered: DiscoveredModel[] = [];
    for (const item of items) {
      const row = item as Record<string, unknown>;
      const id = String(row.id || row.name || '');
      if (!id) continue;
      discovered.push({
        providerModelId: id.replace(/^models\//, ''),
        displayName: String(row.display_name || row.id || id),
        ownedBy: typeof row.owned_by === 'string' ? row.owned_by : undefined,
        metadata: row,
      });
    }
    return discovered;
  }

  async validateCredentials(secret: string): Promise<CredentialValidation> {
    try {
      const models = await this.listModels(secret);
      return {
        ok: true,
        code: 'valid',
        message: 'Credential valid',
        modelsDiscovered: models.length,
      };
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
        status: normalized.code === 'RATE_LIMIT' ? 'Degraded' : 'Unavailable',
        availability: 0,
        latencyMs: Date.now() - started,
        errorRate: 1,
        rateLimitRate: normalized.code === 'RATE_LIMIT' ? 1 : 0,
        timeoutRate: normalized.code === 'TIMEOUT' ? 1 : 0,
        checkedAt: new Date().toISOString(),
        detail: normalized.message,
      };
    }
  }

  protected chatPayload(input: AdapterChatRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: input.model,
      messages: input.messages.map((message) => ({
        role: message.role === 'tool' ? 'tool' : message.role,
        content: message.content,
        ...(message.reasoningDetails ? { reasoning_details: message.reasoningDetails } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
      })),
      temperature: input.temperature ?? 0.2,
    };
    if (input.maxTokens) payload.max_tokens = input.maxTokens;
    if (input.model === 'openrouter/free') {
      payload.provider = { allow_fallbacks: true, max_price: { prompt: 0, completion: 0 } };
    }
    if (input.model === 'z-ai/glm-5.3-flash') {
      payload.reasoning = { max_tokens: 512 };
      payload.provider = { allow_fallbacks: true, max_price: { prompt: 0.15, completion: 0.50 } };
    }
    if (input.responseFormat) payload.response_format = input.responseFormat;
    if (input.tools?.length) {
      payload.tools = input.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      }));
    }
    return payload;
  }

  async chat(input: AdapterChatRequest): Promise<AdapterChatResponse> {
    const { data } = await this.requestJson(input.secret, this.chatUrl(), {
      method: 'POST',
      body: JSON.stringify(this.chatPayload(input)),
      signal: input.signal ?? AbortSignal.timeout(platformTimeoutMs()),
    });
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const message = ((choices[0] as Record<string, unknown> | undefined)?.message || {}) as Record<string, unknown>;
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => {
          const row = call as { id?: string; function?: { name?: string; arguments?: string } };
          return { id: row.id, name: row.function?.name || 'unknown', arguments: row.function?.arguments || '{}' };
        })
      : [];
    const usage = usageFromOpenAi(data);
    usage.toolCalls = toolCalls.length;
    const text = typeof message.content === 'string' ? message.content : '';
    // A 2xx response without either text or a tool call is not a completed
    // generation. Treat it as a transient upstream failure so the gateway can
    // apply its bounded retry and quota policy instead of sending an empty
    // answer to downstream workflows.
    if (!text.trim() && toolCalls.length === 0) {
      throw new AiPlatformError('PROVIDER_UNAVAILABLE', `${this.definition.displayName} returned an empty response`, {
        status: 502,
        providerId: this.definition.id,
        retryable: true,
        detail: {
          emptyResponse: true,
          finishReason: String((choices[0] as { finish_reason?: string } | undefined)?.finish_reason || '') || null,
        },
      });
    }
    return {
      text,
      reasoningDetails: Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined,
      toolCalls,
      finishReason: String((choices[0] as { finish_reason?: string } | undefined)?.finish_reason || '') || null,
      usage,
      providerRequestId: typeof data.id === 'string' ? data.id : null,
    };
  }

  async *stream(input: AdapterChatRequest): AsyncGenerator<CanonicalStreamEvent> {
    const response = await fetch(this.chatUrl(), {
      method: 'POST',
      headers: this.headers(input.secret),
      body: JSON.stringify({ ...this.chatPayload(input), stream: true }),
      signal: input.signal ?? AbortSignal.timeout(platformTimeoutMs()),
    });
    if (!response.ok || !response.body) {
      const raw = await response.text();
      const code = classifyProviderMessage(response.status, raw);
      yield { type: 'stream.error', code, message: this.userFacingError(code) };
      return;
    }

    yield {
      type: 'stream.started',
      requestId: '',
      provider: this.definition.id,
      model: input.model,
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let providerRequestId: string | null = null;
    const usage = emptyUsage(true);

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
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            id?: string;
            usage?: Record<string, unknown>;
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          };
          if (json.id) providerRequestId = json.id;
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            yield { type: 'output.delta', text: delta };
          }
          if (json.usage) {
            Object.assign(usage, usageFromOpenAi({ usage: json.usage }));
          }
        } catch {
          /* ignore malformed SSE */
        }
      }
    }

    yield {
      type: 'stream.completed',
      response: {
        requestId: '',
        traceId: '',
        providerRequestId,
        model: input.model,
        provider: this.definition.id,
        credentialSource: 'platform',
        output: fullText,
        toolCalls: [],
        finishReason: 'stop',
        usage,
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

  async embeddings(input: { secret: string; model: string; input: string[] }): Promise<{ vectors: number[][] }> {
    if (!this.definition.supportsEmbeddings) {
      throw new CapabilityError(this.definition.id, 'embeddings');
    }
    const { data } = await this.requestJson(input.secret, this.embeddingsUrl(), {
      method: 'POST',
      body: JSON.stringify({ model: input.model, input: input.input }),
    });
    const rows = Array.isArray(data.data) ? data.data : [];
    return {
      vectors: rows.map((row) => {
        const embedding = (row as { embedding?: number[] }).embedding;
        return Array.isArray(embedding) ? embedding : [];
      }),
    };
  }
}
