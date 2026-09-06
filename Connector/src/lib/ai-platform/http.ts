import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireServiceKey } from '@/lib/auth';
import { AiPlatformError } from './errors';
import { ensureAiPlatformSchema } from './schema';
import { isAiPlatformEnabled } from './config';
import { listAdapters, getAdapter, canonicalizeProviderId } from './providers/registry';
import { listModels, getModel } from './catalog/store';
import { syncAllProviders, syncProviderModels, syncWithUserCredential } from './catalog/discovery';
import {
  createCredential,
  deleteCredential,
  listCredentials,
  revokeCredential,
  updateCredential,
  validateStoredCredential,
} from './credentials';
import { listRoutingPolicies, saveRoutingPolicy } from './routing';
import { getOrganizationPolicy, saveOrganizationPolicy } from './policies';
import { refreshProviderHealth, getProviderHealthMap } from './health';
import { summarizeUsage, listRequestLogs } from './metering';
import { listAuditEvents } from './audit';
import { executeChat, streamChat, toGatewayMessages } from './gateway';
import { firstEnv } from './config';
import { getProviderDefinition } from './providers/definitions';
import type { AccessMode, GatewayContext, JsonSchemaResponseFormat } from './types';
import { ALIAS_CAPABILITY } from './catalog/seed';
import { rankModels, defaultRoutingPolicy } from './routing';
import { userModelSetup } from './model-setup';
import {
  ACTIVE_ORGANIZATION_COOKIE,
  requireOrganizationPermission,
  resolveActiveOrganization,
} from '@/lib/organizations/store';

function jsonError(error: unknown) {
  if (error instanceof AiPlatformError) {
    const retryAfterSeconds = Number(error.detail?.retryAfterSeconds);
    return NextResponse.json(
      { error: error.message, code: error.code, detail: error.detail || error.sanitizedProviderDetail || undefined },
      {
        status: error.status,
        headers: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? { 'Retry-After': String(Math.ceil(retryAfterSeconds)) }
          : undefined,
      },
    );
  }
  const message = error instanceof Error ? error.message : 'Unexpected AI platform error';
  return NextResponse.json({ error: message, code: 'UNKNOWN_PROVIDER_ERROR' }, { status: 500 });
}

async function actor(request: NextRequest): Promise<{ context: GatewayContext } | { error: NextResponse }> {
  const serviceError = requireServiceKey(request);
  if (!serviceError) {
    const userId = request.headers.get('x-deplai-user-id')?.trim();
    const organizationId = request.headers.get('x-deplai-organization-id')?.trim();
    if (!userId) {
      return { error: NextResponse.json({ error: 'x-deplai-user-id is required for internal AI calls' }, { status: 400 }) };
    }
    if (!organizationId) {
      return { error: NextResponse.json({ error: 'x-deplai-organization-id is required for internal AI calls' }, { status: 400 }) };
    }
    await requireOrganizationPermission({ userId, organizationId, action: 'ai_provider.use' });
    return { context: { userId, organizationId, actor: 'service', source: 'internal' } };
  }
  const auth = await requireAuth();
  if (auth.error) return { error: auth.error };
  const organization = await resolveActiveOrganization(
    auth.user,
    request.cookies.get(ACTIVE_ORGANIZATION_COOKIE)?.value,
  );
  await requireOrganizationPermission({ userId: auth.user.id, organizationId: organization.id, action: 'ai_provider.use' });
  return {
    context: {
      userId: auth.user.id,
      organizationId: organization.id,
      actor: auth.user.email || auth.user.id,
      source: 'ui',
    },
  };
}

function publicProvider(adapterId: string) {
  const adapter = getAdapter(adapterId);
  const definition = adapter?.definition || getProviderDefinition(adapterId);
  if (!definition) return null;
  return {
    id: definition.id,
    name: definition.name,
    displayName: definition.displayName,
    status: definition.status,
    documentationUrl: definition.documentationUrl,
    apiBaseUrl: definition.apiBaseUrl,
    supportsPlatformCredentials: definition.supportsPlatformCredentials,
    supportsByok: definition.supportsByok,
    supportsModelDiscovery: definition.supportsModelDiscovery,
    supportsStreaming: definition.supportsStreaming,
    supportsTools: definition.supportsTools,
    supportsVision: definition.supportsVision,
    supportsAudio: definition.supportsAudio,
    supportsEmbeddings: definition.supportsEmbeddings,
    supportsReasoning: definition.supportsReasoning,
    supportsStructuredOutput: definition.supportsStructuredOutput,
    authenticationType: definition.authenticationType,
    credentialSchema: definition.credentialSchema,
    platformConfigured: Boolean(firstEnv(definition.envKeyNames)),
    brandColor: definition.brandColor,
  };
}

export async function handleAiRequest(request: NextRequest, path: string[]): Promise<Response> {
  if (!isAiPlatformEnabled()) {
    return NextResponse.json({ error: 'AI platform is disabled' }, { status: 404 });
  }
  await ensureAiPlatformSchema();
  const method = request.method.toUpperCase();
  const [head, ...rest] = path;
  try {
    if (!head && method === 'GET') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      const models = await listModels();
      const creds = await listCredentials(auth.context.userId);
      const health = await getProviderHealthMap();
      return NextResponse.json({
        providers: listAdapters().map((adapter) => publicProvider(adapter.definition.id)),
        models: models.length,
        credentials: creds.length,
        aliases: Object.keys(ALIAS_CAPABILITY),
        health: [...health.values()],
      });
    }

    if (head === 'model-setup' && method === 'GET') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      return NextResponse.json(await userModelSetup({
        userId: auth.context.userId,
        organizationId: auth.context.organizationId,
      }));
    }

    if (head === 'providers' && method === 'GET') {
      const id = rest[0];
      if (!id) {
        return NextResponse.json({ providers: listAdapters().map((adapter) => publicProvider(adapter.definition.id)) });
      }
      const item = publicProvider(id);
      if (!item) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
      const models = (await listModels()).filter((model) => model.providerId === id);
      return NextResponse.json({ provider: item, models });
    }

    if (head === 'models' && method === 'GET') {
      const id = rest[0];
      const models = await listModels();
      if (!id) {
        const url = new URL(request.url);
        const provider = url.searchParams.get('provider');
        const capability = url.searchParams.get('capability');
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const lifecycle = url.searchParams.get('lifecycle');
        const filtered = models.filter((model) => {
          if (provider && model.providerId !== provider) return false;
          if (lifecycle && model.lifecycle !== lifecycle) return false;
          if (capability === 'reasoning' && !model.capabilities.reasoning) return false;
          if (capability === 'coding' && !model.capabilities.coding) return false;
          if (capability === 'agents' && !model.capabilities.agents) return false;
          if (capability === 'multimodal' && !model.capabilities.multimodal) return false;
          if (q && !`${model.displayName} ${model.providerModelId} ${model.family}`.toLowerCase().includes(q)) return false;
          return true;
        });
        return NextResponse.json({ models: filtered, aliases: Object.keys(ALIAS_CAPABILITY) });
      }
      const model = await getModel(decodeURIComponent(id));
      if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 });
      return NextResponse.json({ model });
    }

    if (head === 'models' && rest[0] === 'sync' && method === 'POST') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      const body = await request.json().catch(() => ({})) as { provider?: string };
      if (body.provider) {
        const providerId = canonicalizeProviderId(body.provider);
        if (!providerId) return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
        const result = await syncWithUserCredential(auth.context.userId, providerId).catch(() => syncProviderModels({ providerId, userId: auth.context.userId }));
        return NextResponse.json(result);
      }
      return NextResponse.json(await syncAllProviders(auth.context.userId));
    }

    if (head === 'credentials') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      const id = rest[0];
      if (method === 'GET' && !id) {
        return NextResponse.json({ credentials: await listCredentials(auth.context.userId) });
      }
      if (method === 'POST' && !id) {
        const body = await request.json() as { provider?: string; name?: string; secret?: string; api_key?: string; environment?: 'production' | 'development' | 'security' | 'other'; allowedModelIds?: string[] };
        const providerId = canonicalizeProviderId(body.provider || '');
        const secret = body.secret || body.api_key;
        if (!providerId || !secret) {
          return NextResponse.json({ error: 'provider and secret are required' }, { status: 400 });
        }
        const created = await createCredential({
          userId: auth.context.userId,
          providerId,
          name: body.name || '',
          secret,
          environment: body.environment,
          allowedModelIds: body.allowedModelIds,
        });
        if (created.validation.ok) {
          void syncProviderModels({ providerId, userId: auth.context.userId, secret });
        }
        return NextResponse.json({
          credential: created.record,
          validation: created.validation,
          checks: {
            credentialValid: created.validation.ok,
            providerReachable: created.validation.ok,
            modelsDiscovered: created.validation.modelsDiscovered,
          },
        }, { status: created.record.id ? 201 : 400 });
      }
      if (!id) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (rest[1] === 'validate' && method === 'POST') {
        const result = await validateStoredCredential(auth.context.userId, id);
        if (!result) return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
        return NextResponse.json(result);
      }
      if (method === 'PATCH') {
        const body = await request.json() as { name?: string; secret?: string; allowedModelIds?: string[] | null; environment?: 'production' | 'development' | 'security' | 'other' };
        const updated = await updateCredential(auth.context.userId, id, body);
        if (!updated) return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
        return NextResponse.json({ credential: updated });
      }
      if (method === 'DELETE') {
        const url = new URL(request.url);
        const revoke = url.searchParams.get('revoke') === '1';
        const ok = revoke
          ? await revokeCredential(auth.context.userId, id)
          : await deleteCredential(auth.context.userId, id);
        if (!ok) return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
        return NextResponse.json({ ok: true });
      }
    }

    if (head === 'routing-policies') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      if (method === 'GET') {
        return NextResponse.json({ policies: await listRoutingPolicies(auth.context.userId) });
      }
      if (method === 'POST' || (method === 'PUT' && rest[0])) {
        const body = await request.json();
        const saved = await saveRoutingPolicy(auth.context.userId, { ...body, id: rest[0] || body.id, name: body.name || 'custom' });
        return NextResponse.json({ policy: saved });
      }
    }

    if (head === 'policies') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      if (method === 'GET') return NextResponse.json({ policy: await getOrganizationPolicy(auth.context.userId) });
      if (method === 'PUT' || method === 'POST') {
        const body = await request.json();
        return NextResponse.json({ policy: await saveOrganizationPolicy(auth.context.userId, body) });
      }
    }

    if (head === 'usage' && method === 'GET') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      return NextResponse.json(await summarizeUsage(auth.context.userId, auth.context.organizationId));
    }

    if (head === 'costs' && method === 'GET') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      const summary = await summarizeUsage(auth.context.userId, auth.context.organizationId);
      return NextResponse.json({
        ...summary.costs,
        byBillingSource: summary.byBillingSource,
        byProvider: summary.costsByProvider,
        estimatedVsActual: summary.estimatedVsActual,
      });
    }

    if (head === 'health' && method === 'GET') {
      const snapshots = await refreshProviderHealth();
      return NextResponse.json({ providers: snapshots });
    }

    if (head === 'audit' && method === 'GET') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      return NextResponse.json({ events: await listAuditEvents(auth.context.userId) });
    }

    if (head === 'logs' && method === 'GET') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      return NextResponse.json({ logs: await listRequestLogs(auth.context.userId) });
    }

    if ((head === 'chat' || head === 'responses' || head === 'internal') && method === 'POST') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      const body = await request.json() as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        access_mode?: AccessMode;
        routing_policy?: string;
        stream?: boolean;
        temperature?: number;
        max_tokens?: number;
        tools?: NormalizedChatLike['tools'];
        response_format?: JsonSchemaResponseFormat;
        task?: string;
        metadata?: Record<string, unknown>;
        api_key?: string;
        provider?: string;
        credential_id?: string;
        system?: string;
      };
      const securityRemediation = body.metadata?.product === 'security'
        && ['remediation', 'openwiki'].includes(String(body.metadata?.stage));
      const payload = {
        model: body.model || 'best',
        messages: toGatewayMessages(body.messages || [], body.system),
        accessMode: body.access_mode || 'auto',
        routingPolicy: body.routing_policy || 'default',
        stream: Boolean(body.stream),
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        tools: body.tools,
        // Free OpenRouter upstreams can reject json_schema with HTTP 400.
        // Security remediation validates the contract after normal chat.
        responseFormat: securityRemediation ? undefined : normalizeResponseFormat(body.response_format),
        task: body.task,
        metadata: body.metadata,
        ephemeralApiKey: body.api_key,
        ephemeralProvider: canonicalizeProviderId(body.provider || '') || undefined,
        credentialId: typeof body.credential_id === 'string' ? body.credential_id : undefined,
      };
      if (body.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const event of streamChat(auth.context, payload)) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              }
            } catch (error) {
              const message = error instanceof AiPlatformError ? error.message : 'Stream failed';
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'stream.error', message })}\n\n`));
            } finally {
              controller.close();
            }
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }
      const response = await executeChat(auth.context, payload);
      return NextResponse.json(response);
    }

    if (head === 'recommend' && method === 'POST') {
      const auth = await actor(request);
      if ('error' in auth) return auth.error;
      const body = await request.json() as { task?: string; alias?: string };
      const models = await listModels();
      const policy = await getOrganizationPolicy(auth.context.userId);
      const health = await getProviderHealthMap();
      const routing = defaultRoutingPolicy(auth.context.userId);
      routing.primaryAlias = (body.alias as 'best') || (body.task === 'security_analysis' ? 'best_reasoning' : 'best');
      const ranked = rankModels({
        requested: routing.primaryAlias,
        models,
        policy,
        routing,
        health,
        providersWithCredentials: new Set(models.map((model) => model.providerId)),
      });
      return NextResponse.json({
        recommended: ranked.winner?.model || null,
        backups: ranked.ranked.slice(1, 4).map((item) => item.model),
        reasoning: ranked.winner?.reasons || [],
        skipped: ranked.skipped.slice(0, 8).map((item) => ({ model: item.model.displayName, reason: item.skipReason })),
      });
    }

    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}

type NormalizedChatLike = {
  tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
};

function normalizeResponseFormat(value: JsonSchemaResponseFormat | undefined): JsonSchemaResponseFormat | undefined {
  if (!value) return undefined;
  if (value.type !== 'json_schema' || value.json_schema?.strict !== true) {
    throw new AiPlatformError('INVALID_REQUEST', 'Only strict json_schema response_format is supported');
  }
  const name = String(value.json_schema.name || '').trim();
  const schema = value.json_schema.schema;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new AiPlatformError('INVALID_REQUEST', 'Invalid JSON response schema');
  }
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > 16_384) {
    throw new AiPlatformError('INVALID_REQUEST', 'JSON response schema exceeds 16KB');
  }
  return { type: 'json_schema', json_schema: { name, strict: true, schema } };
}
