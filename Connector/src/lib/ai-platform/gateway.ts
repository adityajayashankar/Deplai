import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { AiPlatformError } from './errors';
import { isAiPlatformEnabled, isFeatureEnabled, defaultAccessMode, maxRequestCostUsd } from './config';
import { ensureAiPlatformSchema } from './schema';
import { listModels } from './catalog/store';
import { getAdapter } from './providers/registry';
import { canonicalizeProviderId } from './providers/definitions';
import { listCredentials, resolveCredential, platformSecretFor } from './credentials';
import { getOrganizationPolicy } from './policies';
import { defaultRoutingPolicy, rankModels, resolveRoutingPolicy } from './routing';
import { getProviderHealthMap, recordProviderHealth } from './health';
import { estimateCost, platformMeteringCostUsd, recordUsage } from './metering';
import { canonicalizeRequestedModel } from './model-resolution';
import { redactUnknown } from './redact';
import {
  InsufficientOrganizationCreditsError,
  releaseOrganizationCreditReservation,
  reserveOrganizationCredits,
  settleOrganizationCreditReservation,
  type CreditReservation,
} from '@/lib/billing/organization-credits';
import { filterModelsForPlatformAccess } from './platform-allowlist';
import { resolvePlatformDispatch } from './openrouter-catalog';
import { constrainOpenRouterRequest } from './openrouter-request-budget';
import {
  expandProvidersForPlatformOpenRouter,
  isPlatformOpenRouterUpstream,
  shouldUsePlatformOpenRouterUpstream,
} from './platform-upstream';
import type {
  AccessMode,
  CanonicalStreamEvent,
  ChatMessage,
  GatewayContext,
  NormalizedChatRequest,
  NormalizedChatResponse,
  OrganizationPolicy,
  ProviderId,
  RoutingCandidate,
  RoutingPolicy,
  UsageBreakdown,
} from './types';

const SECURITY_REQUIRED = ['finding_id', 'severity', 'confidence', 'root_cause', 'recommended_fix'] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  const base = Math.min(2000, 250 * 2 ** attempt);
  return base + Math.floor(Math.random() * 100);
}

function isStrictRemediation(request: NormalizedChatRequest): boolean {
  return request.metadata?.product === 'security'
    && request.metadata?.stage === 'remediation'
    && request.responseFormat?.type === 'json_schema';
}

function validateSecuritySchema(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return 'Security analysis output is not valid JSON';
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    for (const key of SECURITY_REQUIRED) {
      if (parsed[key] == null || parsed[key] === '') return `Missing required field: ${key}`;
    }
    return null;
  } catch {
    return 'Security analysis output is not valid JSON';
  }
}

async function providersWithCredentials(
  userId: string,
  accessMode: AccessMode,
  ephemeralProvider?: ProviderId,
  organizationId?: string,
): Promise<Set<string>> {
  const available = new Set<string>();
  if (ephemeralProvider) available.add(ephemeralProvider);
  if (accessMode !== 'byok') {
    for (const provider of ['openai', 'anthropic', 'minimax', 'xai', 'gemini', 'kimi', 'glm', 'groq', 'openrouter'] as ProviderId[]) {
      if (platformSecretFor(provider)) available.add(provider);
    }
  }
  if (accessMode !== 'platform') {
    const creds = await listCredentials(userId);
    for (const cred of creds) {
      if (cred.status === 'VALID' || cred.status === 'PENDING') available.add(cred.providerId);
    }
  }
  const orgOpenRouter = organizationId
    ? await (async () => {
      const { resolveOrganizationOpenRouterSecret } = await import('@/lib/billing/openrouter-provisioning');
      return resolveOrganizationOpenRouterSecret(organizationId);
    })()
    : null;
  const hasOpenRouter = Boolean(orgOpenRouter || platformSecretFor('openrouter'));
  return expandProvidersForPlatformOpenRouter(accessMode, available, hasOpenRouter);
}

type PreparedChat = {
  requestId: string;
  traceId: string;
  started: number;
  accessMode: AccessMode;
  policy: OrganizationPolicy;
  routing: RoutingPolicy;
  skipped: Array<{ model: string; reason: string }>;
  chain: RoutingCandidate[];
  primary: RoutingCandidate;
};

function estimatedUsage(messages: ChatMessage[], text: string): UsageBreakdown {
  const inputTokens = Math.max(1, Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4));
  const outputTokens = Math.max(1, Math.ceil((text || '').length / 4));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    estimated: true,
  };
}

function maximumUsage(request: NormalizedChatRequest, policy: OrganizationPolicy): UsageBreakdown {
  const inputTokens = Math.max(1, Math.ceil(request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4));
  const outputTokens = Math.max(1, request.maxTokens || policy.maxTokenLimit || 4096);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
    toolCalls: request.tools?.length || 0,
    estimated: true,
  };
}

function assertManagedPricing(model: RoutingCandidate['model']): void {
  if (
    model.pricing.inputPerMillionUsd == null
    || model.pricing.outputPerMillionUsd == null
    || model.pricing.inputPerMillionUsd < 0
    || model.pricing.outputPerMillionUsd < 0
  ) {
    throw new AiPlatformError('POLICY_DENIED', 'Managed-key pricing is unavailable for this model', {
      status: 503,
      retryable: false,
    });
  }
  const maxAgeHours = Math.max(1, Number(process.env.CREDIT_MODEL_PRICING_MAX_AGE_HOURS || 720));
  const updatedAt = model.updatedAt ? new Date(model.updatedAt).getTime() : null;
  if (updatedAt && Date.now() - updatedAt > maxAgeHours * 3_600_000) {
    throw new AiPlatformError('POLICY_DENIED', 'Managed-key pricing is stale for this model', {
      status: 503,
      retryable: false,
    });
  }
}

function insufficientCreditsError(error: InsufficientOrganizationCreditsError): AiPlatformError {
  return new AiPlatformError('QUOTA_EXCEEDED', error.message, {
    status: 402,
    retryable: false,
    detail: {
      available_credits: Number(error.availableUnits) / 1_000_000,
      required_credits: Number(error.requiredUnits) / 1_000_000,
      organization_id: error.organizationId,
      top_up_path: error.topUpPath,
      upgrade_required: error.availableUnits <= 0,
    },
  });
}

async function prepareChat(context: GatewayContext, request: NormalizedChatRequest): Promise<PreparedChat> {
  if (!isAiPlatformEnabled()) {
    throw new AiPlatformError('POLICY_DENIED', 'AI platform is disabled');
  }
  await ensureAiPlatformSchema();

  const requestId = randomUUID();
  const traceId = randomUUID();
  const started = Date.now();
  const accessMode = request.accessMode || defaultAccessMode();
  const policy = await getOrganizationPolicy(context.userId);

  if (policy.byokRequired && accessMode === 'platform') {
    throw new AiPlatformError('POLICY_DENIED', 'Organization policy requires BYOK');
  }
  if (!policy.platformCredentialsAllowed && accessMode === 'platform') {
    throw new AiPlatformError('POLICY_DENIED', 'Platform credentials are disabled for this workspace');
  }
  if (!policy.allowedCredentialModes.includes(accessMode) && accessMode !== 'auto') {
    throw new AiPlatformError('POLICY_DENIED', 'Requested access mode is not allowed');
  }

  const routing = await resolveRoutingPolicy(context.userId, request.routingPolicy || 'default', request.task);
  const platformUpstream = isPlatformOpenRouterUpstream();
  const models = filterModelsForPlatformAccess(
    await listModels(),
    accessMode,
    platformUpstream,
  );
  const health = await getProviderHealthMap();
  const ephemeralProvider = request.ephemeralProvider || (request.ephemeralApiKey ? canonicalizeProviderId(String(request.metadata?.provider || '')) || undefined : undefined);
  const available = await providersWithCredentials(
    context.userId,
    accessMode,
    ephemeralProvider || undefined,
    context.organizationId,
  );
  const ranked = rankModels({
    requested: canonicalizeRequestedModel(request.model, models),
    models,
    policy,
    routing,
    health,
    providersWithCredentials: available,
    preferredProvider: request.ephemeralProvider || undefined,
  });

  const skipped = ranked.skipped.map((item) => ({
    model: item.model.displayName,
    reason: item.skipReason || 'Skipped',
  }));

  const chain = ranked.ranked.slice(0, isFeatureEnabled('ai_fallback') && policy.fallbackAllowed ? 4 : 1);
  if (routing.fallbackModelId) {
    const fallback = models.find((model) => model.id === routing.fallbackModelId);
    if (fallback && !chain.some((item) => item.model.id === fallback.id)) {
      chain.push({ model: fallback, score: 0, reasons: ['Configured fallback'] });
    }
  }

  if (!chain.length) {
    throw new AiPlatformError('MODEL_NOT_FOUND', 'No eligible model is available for this request', {
      sanitizedProviderDetail: skipped.map((item) => `${item.model}: ${item.reason}`).join('; '),
    });
  }

  return {
    requestId,
    traceId,
    started,
    accessMode,
    policy,
    routing,
    skipped,
    chain,
    primary: chain[0],
  };
}

export async function executeChat(
  context: GatewayContext,
  request: NormalizedChatRequest,
): Promise<NormalizedChatResponse> {
  const { requestId, traceId, started, accessMode, policy, routing, skipped, chain, primary } = await prepareChat(context, request);

  let lastError: AiPlatformError | null = null;
  let fallbackCount = 0;
  let retryCount = 0;

  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index];
    if (index > 0) {
      if (isStrictRemediation(request)) break;
      if (!policy.fallbackAllowed) break;
      if (!policy.crossProviderFallbackAllowed && candidate.model.providerId !== primary.model.providerId) continue;
      fallbackCount += 1;
    }

    const credentialProbe = await resolveCredential({
      userId: context.userId,
      organizationId: context.organizationId,
      providerId: candidate.model.providerId,
      accessMode: request.ephemeralApiKey ? 'byok' : accessMode,
      ephemeralSecret: request.ephemeralApiKey,
      modelId: candidate.model.id,
      credentialId: request.credentialId,
    });
    const platformUpstream = shouldUsePlatformOpenRouterUpstream({
      accessMode: request.ephemeralApiKey ? 'byok' : accessMode,
      modelId: candidate.model.id,
      hasEphemeralApiKey: Boolean(request.ephemeralApiKey),
    });
    const dispatch = resolvePlatformDispatch(candidate.model, platformUpstream);
    const adapter = getAdapter(dispatch.adapterProviderId);
    if (!adapter) continue;

    const credential = dispatch.adapterProviderId === candidate.model.providerId
      ? credentialProbe
      : await resolveCredential({
        userId: context.userId,
        organizationId: context.organizationId,
        providerId: dispatch.adapterProviderId,
        accessMode: request.ephemeralApiKey ? 'byok' : accessMode,
        ephemeralSecret: request.ephemeralApiKey,
        modelId: candidate.model.id,
        credentialId: request.credentialId,
      });
    if ('error' in credential) {
      skipped.push({ model: candidate.model.displayName, reason: credential.error });
      lastError = new AiPlatformError(credential.code, credential.error);
      continue;
    }

    const maximumAttempts = isStrictRemediation(request) ? 1 : 3;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      let reservation: CreditReservation | null = null;
      let providerCompleted = false;
      try {
        const requestedMaxTokens = request.maxTokens || policy.maxTokenLimit || undefined;
        const openRouterBudget = dispatch.adapterProviderId === 'openrouter'
          ? constrainOpenRouterRequest({
            secret: credential.secret,
            model: dispatch.upstreamModelId,
            messages: request.messages,
            requestedMaxTokens,
            tools: request.tools,
            responseFormat: request.responseFormat,
          })
          : null;
        const boundedRequest = openRouterBudget
          ? { ...request, maxTokens: openRouterBudget.maxTokens }
          : request;
        const managed = credential.source === 'platform';
        if (managed) {
          assertManagedPricing(candidate.model);
          const maximumCostUsd = platformMeteringCostUsd(candidate.model, maximumUsage(boundedRequest, policy));
          reservation = await reserveOrganizationCredits({
            organizationId: context.organizationId,
            userId: context.userId,
            projectId: context.projectId || null,
            requestId,
            attemptKey: `${requestId}:${candidate.model.id}:${attempt}`,
            providerId: dispatch.billingProviderId,
            modelId: dispatch.billingModelId,
            maximumProviderCostUsd: maximumCostUsd,
          });
        }
        const result = await adapter.chat({
          secret: credential.secret,
          model: dispatch.upstreamModelId,
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: boundedRequest.maxTokens || policy.maxTokenLimit || undefined,
          tools: request.tools,
          responseFormat: request.responseFormat,
        });
        providerCompleted = true;
        if (request.task === 'security_analysis') {
          const schemaError = validateSecuritySchema(result.text);
          if (schemaError) {
            throw new AiPlatformError('INVALID_REQUEST', schemaError);
          }
        }
        const billingSource = credential.source === 'platform' ? 'platform' : 'byok';
        const cost = estimateCost(candidate.model, result.usage, billingSource);
        const billedProviderCostUsd = billingSource === 'platform'
          ? platformMeteringCostUsd(candidate.model, result.usage)
          : cost.providerCostUsd;
        const billedCost = billedProviderCostUsd !== cost.providerCostUsd
          ? { ...cost, providerCostUsd: billedProviderCostUsd, customerChargeUsd: billedProviderCostUsd }
          : cost;
        const maxCost = policy.maxRequestCostUsd ?? maxRequestCostUsd();
        if (maxCost != null && billedCost.customerChargeUsd > maxCost) {
          throw new AiPlatformError('QUOTA_EXCEEDED', 'Request exceeds the configured cost limit');
        }
        if (reservation) {
          await settleOrganizationCreditReservation({
            reservation,
            actualProviderCostUsd: billedProviderCostUsd,
          });
          reservation = null;
        }
        const latencyMs = Date.now() - started;
        const response: NormalizedChatResponse = {
          requestId,
          traceId,
          providerRequestId: result.providerRequestId,
          model: candidate.model.providerModelId,
          provider: candidate.model.providerId,
          credentialSource: credential.source,
          output: result.text,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
          usage: result.usage,
          cost: billedCost,
          latencyMs,
          timeToFirstTokenMs: null,
          routingExplanation: candidate.reasons,
          skipped,
          fallback: {
            count: fallbackCount,
            primaryProvider: primary.model.providerId,
            primaryModel: primary.model.providerModelId,
            failureReason: lastError?.message || null,
          },
        };
        await recordUsage({
          userId: context.userId,
          organizationId: context.organizationId,
          projectId: context.projectId || null,
          requestId,
          providerId: candidate.model.providerId,
          modelId: candidate.model.id,
          credentialSource: credential.source,
          usage: result.usage,
          cost: billedCost,
          failClosed: billingSource === 'platform',
        });
        await persistLog({
          requestId,
          traceId,
          userId: context.userId,
          organizationId: context.organizationId,
          providerId: candidate.model.providerId,
          modelId: candidate.model.id,
          credentialSource: credential.source,
          routingPolicy: routing.name,
          status: 'success',
          latencyMs,
          retryCount,
          fallbackCount,
          explanation: candidate.reasons,
        });
        void recordProviderHealth({
          providerId: candidate.model.providerId,
          status: 'Healthy',
          availability: 1,
          latencyMs,
          errorRate: 0,
          rateLimitRate: 0,
          timeoutRate: 0,
          checkedAt: new Date().toISOString(),
          detail: null,
        });
        return response;
      } catch (error) {
        if (reservation && !providerCompleted) {
          await releaseOrganizationCreditReservation(reservation).catch(() => undefined);
        }
        if (error instanceof InsufficientOrganizationCreditsError) {
          throw insufficientCreditsError(error);
        }
        if (providerCompleted && !(error instanceof AiPlatformError)) {
          throw new AiPlatformError('PROVIDER_UNAVAILABLE', 'Managed credit accounting is unavailable', {
            status: 503,
            retryable: false,
            cause: error,
          });
        }
        const normalized = adapter.normalizeError(error);
        lastError = normalized;
        retryCount += 1;
        if (normalized.retryable && attempt + 1 < maximumAttempts && isFeatureEnabled('ai_fallback')) {
          await sleep(backoff(attempt));
          continue;
        }
        if (!normalized.retryable) {
          skipped.push({ model: candidate.model.displayName, reason: normalized.message });
          break;
        }
        skipped.push({ model: candidate.model.displayName, reason: normalized.message });
        break;
      }
    }
  }

  await persistLog({
    requestId,
    traceId,
    userId: context.userId,
    organizationId: context.organizationId,
    providerId: primary.model.providerId,
    modelId: primary.model.id,
    credentialSource: null,
    routingPolicy: routing.name,
    status: 'error',
    errorCode: lastError?.code || 'UNKNOWN_PROVIDER_ERROR',
    latencyMs: Date.now() - started,
    retryCount,
    fallbackCount,
    explanation: skipped.map((item) => `${item.model}: ${item.reason}`),
  });
  throw lastError || new AiPlatformError('PROVIDER_UNAVAILABLE', 'All eligible providers failed');
}

export async function* streamChat(
  context: GatewayContext,
  request: NormalizedChatRequest,
): AsyncGenerator<CanonicalStreamEvent> {
  const { requestId, traceId, started, accessMode, policy, routing, skipped, chain, primary } = await prepareChat(context, request);
  yield {
    type: 'stream.started',
    requestId,
    provider: primary.model.providerId,
    model: primary.model.providerModelId,
  };

  let lastError: AiPlatformError | null = null;
  let fallbackCount = 0;
  let retryCount = 0;

  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index];
    if (index > 0) {
      if (isStrictRemediation(request)) break;
      if (!policy.fallbackAllowed) break;
      if (!policy.crossProviderFallbackAllowed && candidate.model.providerId !== primary.model.providerId) continue;
      fallbackCount += 1;
    }

    const credentialProbe = await resolveCredential({
      userId: context.userId,
      organizationId: context.organizationId,
      providerId: candidate.model.providerId,
      accessMode: request.ephemeralApiKey ? 'byok' : accessMode,
      ephemeralSecret: request.ephemeralApiKey,
      modelId: candidate.model.id,
      credentialId: request.credentialId,
    });
    const platformUpstream = shouldUsePlatformOpenRouterUpstream({
      accessMode: request.ephemeralApiKey ? 'byok' : accessMode,
      modelId: candidate.model.id,
      hasEphemeralApiKey: Boolean(request.ephemeralApiKey),
    });
    const dispatch = resolvePlatformDispatch(candidate.model, platformUpstream);
    const adapter = getAdapter(dispatch.adapterProviderId);
    if (!adapter) continue;

    const credential = dispatch.adapterProviderId === candidate.model.providerId
      ? credentialProbe
      : await resolveCredential({
        userId: context.userId,
        organizationId: context.organizationId,
        providerId: dispatch.adapterProviderId,
        accessMode: request.ephemeralApiKey ? 'byok' : accessMode,
        ephemeralSecret: request.ephemeralApiKey,
        modelId: candidate.model.id,
        credentialId: request.credentialId,
      });
    if ('error' in credential) {
      skipped.push({ model: candidate.model.displayName, reason: credential.error });
      lastError = new AiPlatformError(credential.code, credential.error);
      continue;
    }

    const maximumAttempts = isStrictRemediation(request) ? 1 : 3;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      let reservation: CreditReservation | null = null;
      let providerCompleted = false;
      try {
        const requestedMaxTokens = request.maxTokens || policy.maxTokenLimit || undefined;
        const openRouterBudget = dispatch.adapterProviderId === 'openrouter'
          ? constrainOpenRouterRequest({
            secret: credential.secret,
            model: dispatch.upstreamModelId,
            messages: request.messages,
            requestedMaxTokens,
            tools: request.tools,
            responseFormat: request.responseFormat,
          })
          : null;
        const boundedRequest = openRouterBudget
          ? { ...request, maxTokens: openRouterBudget.maxTokens }
          : request;
        const managed = credential.source === 'platform';
        if (managed) {
          assertManagedPricing(candidate.model);
          const maximumCostUsd = platformMeteringCostUsd(candidate.model, maximumUsage(boundedRequest, policy));
          reservation = await reserveOrganizationCredits({
            organizationId: context.organizationId,
            userId: context.userId,
            projectId: context.projectId || null,
            requestId,
            attemptKey: `${requestId}:${candidate.model.id}:stream:${attempt}`,
            providerId: dispatch.billingProviderId,
            modelId: dispatch.billingModelId,
            maximumProviderCostUsd: maximumCostUsd,
          });
        }
        let text = '';
        let usage: UsageBreakdown | null = null;
        let providerRequestId: string | null = null;
        let timeToFirstTokenMs: number | null = null;
        for await (const event of adapter.stream({
          secret: credential.secret,
          model: dispatch.upstreamModelId,
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: boundedRequest.maxTokens || policy.maxTokenLimit || undefined,
          tools: request.tools,
          responseFormat: request.responseFormat,
        })) {
          if (event.type === 'output.delta' && event.text) {
            if (timeToFirstTokenMs == null) timeToFirstTokenMs = Date.now() - started;
            text += event.text;
            yield event;
          } else if (event.type === 'stream.error') {
            throw new AiPlatformError(event.code, event.message);
          } else if (event.type === 'stream.completed') {
            text = event.response.output || text;
            usage = event.response.usage;
            providerRequestId = event.response.providerRequestId;
          } else if (event.type === 'tool_call.started' || event.type === 'tool_call.delta' || event.type === 'tool_call.completed') {
            yield event;
          }
        }
        providerCompleted = true;
        if (request.task === 'security_analysis') {
          const schemaError = validateSecuritySchema(text);
          if (schemaError) throw new AiPlatformError('INVALID_REQUEST', schemaError);
        }
        const finalUsage = usage && usage.totalTokens > 0 ? usage : estimatedUsage(request.messages, text);
        const billingSource = credential.source === 'platform' ? 'platform' : 'byok';
        const cost = estimateCost(candidate.model, finalUsage, billingSource);
        const billedProviderCostUsd = billingSource === 'platform'
          ? platformMeteringCostUsd(candidate.model, finalUsage)
          : cost.providerCostUsd;
        const billedCost = billedProviderCostUsd !== cost.providerCostUsd
          ? { ...cost, providerCostUsd: billedProviderCostUsd, customerChargeUsd: billedProviderCostUsd }
          : cost;
        const maxCost = policy.maxRequestCostUsd ?? maxRequestCostUsd();
        if (maxCost != null && billedCost.customerChargeUsd > maxCost) {
          throw new AiPlatformError('QUOTA_EXCEEDED', 'Request exceeds the configured cost limit');
        }
        if (reservation) {
          await settleOrganizationCreditReservation({
            reservation,
            actualProviderCostUsd: billedProviderCostUsd,
          });
          reservation = null;
        }
        const latencyMs = Date.now() - started;
        const response: NormalizedChatResponse = {
          requestId,
          traceId,
          providerRequestId,
          model: candidate.model.providerModelId,
          provider: candidate.model.providerId,
          credentialSource: credential.source,
          output: text,
          toolCalls: [],
          finishReason: 'stop',
          usage: finalUsage,
          cost: billedCost,
          latencyMs,
          timeToFirstTokenMs,
          routingExplanation: candidate.reasons,
          skipped,
          fallback: {
            count: fallbackCount,
            primaryProvider: primary.model.providerId,
            primaryModel: primary.model.providerModelId,
            failureReason: lastError?.message || null,
          },
        };
        await recordUsage({
          userId: context.userId,
          organizationId: context.organizationId,
          projectId: context.projectId || null,
          requestId,
          providerId: candidate.model.providerId,
          modelId: candidate.model.id,
          credentialSource: credential.source,
          usage: finalUsage,
          cost: billedCost,
          failClosed: billingSource === 'platform',
        });
        await persistLog({
          requestId,
          traceId,
          userId: context.userId,
          organizationId: context.organizationId,
          providerId: candidate.model.providerId,
          modelId: candidate.model.id,
          credentialSource: credential.source,
          routingPolicy: routing.name,
          status: 'success',
          latencyMs,
          retryCount,
          fallbackCount,
          explanation: candidate.reasons,
        });
        void recordProviderHealth({
          providerId: candidate.model.providerId,
          status: 'Healthy',
          availability: 1,
          latencyMs,
          errorRate: 0,
          rateLimitRate: 0,
          timeoutRate: 0,
          checkedAt: new Date().toISOString(),
          detail: null,
        });
        yield { type: 'stream.completed', response };
        return;
      } catch (error) {
        if (reservation && !providerCompleted) {
          await releaseOrganizationCreditReservation(reservation).catch(() => undefined);
        }
        if (error instanceof InsufficientOrganizationCreditsError) {
          lastError = insufficientCreditsError(error);
          break;
        }
        if (providerCompleted && !(error instanceof AiPlatformError)) {
          lastError = new AiPlatformError('PROVIDER_UNAVAILABLE', 'Managed credit accounting is unavailable', {
            status: 503,
            retryable: false,
            cause: error,
          });
          break;
        }
        const normalized = adapter.normalizeError(error);
        lastError = normalized;
        retryCount += 1;
        if (normalized.retryable && attempt + 1 < maximumAttempts && isFeatureEnabled('ai_fallback')) {
          await sleep(backoff(attempt));
          continue;
        }
        skipped.push({ model: candidate.model.displayName, reason: normalized.message });
        break;
      }
    }
  }

  await persistLog({
    requestId,
    traceId,
    userId: context.userId,
    organizationId: context.organizationId,
    providerId: primary.model.providerId,
    modelId: primary.model.id,
    credentialSource: null,
    routingPolicy: routing.name,
    status: 'error',
    errorCode: lastError?.code || 'UNKNOWN_PROVIDER_ERROR',
    latencyMs: Date.now() - started,
    retryCount,
    fallbackCount,
    explanation: skipped.map((item) => `${item.model}: ${item.reason}`),
  });
  yield {
    type: 'stream.error',
    code: lastError?.code || 'PROVIDER_UNAVAILABLE',
    message: lastError?.message || 'All eligible providers failed',
  };
}

async function persistLog(input: {
  requestId: string;
  traceId: string;
  userId: string;
  organizationId: string;
  providerId: string | null;
  modelId: string | null;
  credentialSource: string | null;
  routingPolicy: string;
  status: string;
  errorCode?: string;
  latencyMs: number;
  retryCount: number;
  fallbackCount: number;
  explanation: string[];
}) {
  try {
    await query(
      `INSERT INTO ai_request_logs (
        id, user_id, organization_id, trace_id, provider_id, model_id, credential_source, routing_policy, status, error_code,
        latency_ms, retry_count, fallback_count, routing_explanation_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.requestId,
        input.userId,
        input.organizationId,
        input.traceId,
        input.providerId,
        input.modelId,
        input.credentialSource,
        input.routingPolicy,
        input.status,
        input.errorCode || null,
        input.latencyMs,
        input.retryCount,
        input.fallbackCount,
        JSON.stringify(input.explanation),
        JSON.stringify(redactUnknown({ source: 'gateway' })),
      ],
    );
  } catch {
    /* ignore */
  }
}

export function toGatewayMessages(messages: Array<{ role: string; content: string }>, system?: string): ChatMessage[] {
  const next: ChatMessage[] = [];
  if (system) next.push({ role: 'system', content: system });
  for (const message of messages) {
    const role = message.role === 'assistant' || message.role === 'system' || message.role === 'tool' ? message.role : 'user';
    next.push({ role, content: message.content });
  }
  return next;
}

export { defaultRoutingPolicy };
