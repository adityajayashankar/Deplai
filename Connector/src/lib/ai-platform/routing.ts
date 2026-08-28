import type {
  AccessMode,
  CanonicalModel,
  LogicalAlias,
  OrganizationPolicy,
  ProviderHealthSnapshot,
  ProviderId,
  RoutingCandidate,
  RoutingPolicy,
  RoutingWeights,
} from './types';
import { DEFAULT_ROUTING_WEIGHTS, LOGICAL_ALIASES } from './types';
import { ALIAS_CAPABILITY, isSelectableLifecycle } from './catalog/seed';
import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { ensureAiPlatformSchema } from './schema';

export function isLogicalAlias(value: string): value is LogicalAlias {
  return (LOGICAL_ALIASES as readonly string[]).includes(value);
}

function capabilityMatch(model: CanonicalModel, alias: string): number {
  const key = ALIAS_CAPABILITY[alias] || 'any';
  if (key === 'any') return 0.7;
  if (key === 'long_context') return model.contextWindow >= 500_000 ? 1 : model.contextWindow >= 128_000 ? 0.6 : 0.2;
  if (key === 'vision') return model.capabilities.vision ? 1 : 0;
  if (key === 'structured_output') return model.capabilities.structured_output ? 1 : 0.3;
  const score = model.capabilities.scores[key]?.value;
  if (typeof score === 'number') return score / 10;
  if (key === 'reasoning') return model.capabilities.reasoning ? 0.8 : 0;
  if (key === 'coding') return model.capabilities.coding ? 0.8 : 0;
  if (key === 'agentic') return model.capabilities.agents ? 0.8 : 0;
  return 0.4;
}

function latencyScore(model: CanonicalModel, alias: string): number {
  if (alias === 'best_fast') {
    return model.latencyProfile === 'fast' ? 1 : model.latencyProfile === 'balanced' ? 0.5 : 0.2;
  }
  return model.latencyProfile === 'fast' ? 0.8 : model.latencyProfile === 'balanced' ? 1 : 0.6;
}

function costScore(model: CanonicalModel, alias: string): number {
  const price = model.pricing.outputPerMillionUsd ?? 10;
  const inverted = Math.max(0, 1 - Math.min(price, 40) / 40);
  return alias === 'best_cost' ? inverted : inverted * 0.5 + 0.5;
}

export function rankModels(input: {
  requested: string;
  models: CanonicalModel[];
  policy: OrganizationPolicy;
  routing: RoutingPolicy;
  health: Map<string, ProviderHealthSnapshot>;
  providersWithCredentials: Set<string>;
  preferredProvider?: ProviderId | null;
}): { winner: RoutingCandidate | null; ranked: RoutingCandidate[]; skipped: RoutingCandidate[] } {
  const skipped: RoutingCandidate[] = [];
  const ranked: RoutingCandidate[] = [];
  const weights: RoutingWeights = { ...DEFAULT_ROUTING_WEIGHTS, ...input.routing.weights };
  const requested = input.requested.trim();
  const alias = isLogicalAlias(requested) ? requested : input.routing.primaryAlias;

  for (const model of input.models) {
    const reasons: string[] = [];
    const skip = (reason: string) => {
      skipped.push({ model, score: 0, reasons, skipReason: reason });
    };

    if (!isSelectableLifecycle(model.lifecycle)) {
      skip(`Model ${model.lifecycle.toLowerCase()}`);
      continue;
    }
    if (input.policy.allowedProviders && !input.policy.allowedProviders.includes(model.providerId)) {
      skip('Organization policy blocks provider');
      continue;
    }
    if (input.routing.allowedProviders.length && !input.routing.allowedProviders.includes(model.providerId)) {
      skip('Routing policy blocks provider');
      continue;
    }
    if (input.policy.allowedModels && !input.policy.allowedModels.includes(model.id) && !input.policy.allowedModels.includes(model.providerModelId)) {
      skip('Organization policy blocks model');
      continue;
    }
    if (!input.providersWithCredentials.has(model.providerId)) {
      skip('BYOK unavailable');
      continue;
    }
    const health = input.health.get(model.providerId);
    if (health?.status === 'Unavailable') {
      skip('Provider unavailable');
      continue;
    }

    if (!isLogicalAlias(requested)) {
      const needle = requested.toLowerCase();
      const exact =
        model.id.toLowerCase() === needle
        || model.providerModelId.toLowerCase() === needle
        || model.aliases.some((item) => item.toLowerCase() === needle);
      if (!exact) {
        skip('Does not match requested model');
        continue;
      }
      reasons.push('Exact model match');
    } else {
      reasons.push(`Matches ${alias.replaceAll('_', ' ')} requirement`);
    }

    const cap = capabilityMatch(model, alias);
    const reliability = health?.status === 'Healthy' ? 1 : health?.status === 'Degraded' ? 0.5 : 0.7;
    const policyScore = 1;
    const credentialScore = 1;
    const lat = latencyScore(model, alias);
    const cost = costScore(model, alias);
    const preference = input.preferredProvider === model.providerId ? 1 : 0.4;
    if (health?.status === 'Healthy') reasons.push('Provider healthy');
    reasons.push('Within organization policy');

    const score =
      cap * weights.capability
      + reliability * weights.reliability
      + policyScore * weights.policy
      + credentialScore * weights.credential
      + lat * weights.latency
      + cost * weights.cost
      + preference * weights.preference
      + (input.preferredProvider && input.preferredProvider === model.providerId ? 0.35 : 0);
    if (input.preferredProvider && input.preferredProvider === model.providerId) reasons.push('Preferred provider');

    ranked.push({ model, score, reasons });
  }

  ranked.sort((a, b) => b.score - a.score);
  if (ranked[0] && isLogicalAlias(requested)) {
    ranked[0].reasons.push('Highest eligible score among active models');
  }
  return { winner: ranked[0] || null, ranked, skipped };
}

export function defaultRoutingPolicy(userId: string, name = 'default'): RoutingPolicy {
  return {
    id: `default-${userId}`,
    userId,
    name,
    taskType: 'general',
    primaryAlias: 'best',
    secondaryAlias: 'best_fast',
    fallbackModelId: null,
    accessMode: 'auto',
    allowedProviders: ['openai', 'anthropic', 'gemini', 'xai', 'minimax', 'kimi', 'glm', 'groq'],
    weights: DEFAULT_ROUTING_WEIGHTS,
    isDefault: true,
  };
}

export function securityAnalysisPolicy(userId: string): RoutingPolicy {
  return {
    ...defaultRoutingPolicy(userId, 'security_analysis'),
    id: `security-${userId}`,
    taskType: 'security_analysis',
    primaryAlias: 'best_reasoning',
    secondaryAlias: 'best_coding',
    isDefault: false,
    weights: {
      capability: 0.5,
      reliability: 0.2,
      policy: 0.1,
      credential: 0.05,
      latency: 0.05,
      cost: 0.05,
      preference: 0.05,
    },
  };
}

export async function listRoutingPolicies(userId: string): Promise<RoutingPolicy[]> {
  await ensureAiPlatformSchema();
  try {
    const rows = await query<Array<{
      id: string;
      user_id: string;
      name: string;
      task_type: string;
      primary_alias: string;
      secondary_alias: string | null;
      fallback_model_id: string | null;
      access_mode: AccessMode;
      allowed_providers_json: unknown;
      weights_json: unknown;
      is_default: number;
    }>>('SELECT * FROM ai_routing_policies WHERE user_id = ? ORDER BY is_default DESC, name', [userId]);
    if (rows.length) {
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        taskType: row.task_type,
        primaryAlias: row.primary_alias,
        secondaryAlias: row.secondary_alias,
        fallbackModelId: row.fallback_model_id,
        accessMode: row.access_mode,
        allowedProviders: Array.isArray(row.allowed_providers_json)
          ? row.allowed_providers_json as ProviderId[]
          : JSON.parse(String(row.allowed_providers_json || '[]')),
        weights: typeof row.weights_json === 'object' && row.weights_json
          ? { ...DEFAULT_ROUTING_WEIGHTS, ...(row.weights_json as RoutingWeights) }
          : DEFAULT_ROUTING_WEIGHTS,
        isDefault: Boolean(row.is_default),
      }));
    }
  } catch {
    /* fall through */
  }
  return [defaultRoutingPolicy(userId), securityAnalysisPolicy(userId)];
}

export async function saveRoutingPolicy(userId: string, policy: Partial<RoutingPolicy> & { name: string }): Promise<RoutingPolicy> {
  await ensureAiPlatformSchema();
  const id = policy.id || randomUUID();
  const allowed = policy.allowedProviders || defaultRoutingPolicy(userId).allowedProviders;
  const weights = { ...DEFAULT_ROUTING_WEIGHTS, ...policy.weights };
  await query(
    `INSERT INTO ai_routing_policies (
      id, user_id, name, task_type, primary_alias, secondary_alias, fallback_model_id, access_mode, allowed_providers_json, weights_json, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      task_type = VALUES(task_type),
      primary_alias = VALUES(primary_alias),
      secondary_alias = VALUES(secondary_alias),
      fallback_model_id = VALUES(fallback_model_id),
      access_mode = VALUES(access_mode),
      allowed_providers_json = VALUES(allowed_providers_json),
      weights_json = VALUES(weights_json),
      is_default = VALUES(is_default)`,
    [
      id,
      userId,
      policy.name,
      policy.taskType || 'general',
      policy.primaryAlias || 'best',
      policy.secondaryAlias || null,
      policy.fallbackModelId || null,
      policy.accessMode || 'auto',
      JSON.stringify(allowed),
      JSON.stringify(weights),
      policy.isDefault ? 1 : 0,
    ],
  );
  const all = await listRoutingPolicies(userId);
  return all.find((item) => item.id === id) || { ...defaultRoutingPolicy(userId), ...policy, id, userId, allowedProviders: allowed, weights };
}

export async function resolveRoutingPolicy(userId: string, nameOrId: string, task?: string): Promise<RoutingPolicy> {
  const policies = await listRoutingPolicies(userId);
  if (task === 'security_analysis') {
    return policies.find((policy) => policy.taskType === 'security_analysis' || policy.name === 'security_analysis')
      || securityAnalysisPolicy(userId);
  }
  return policies.find((policy) => policy.id === nameOrId || policy.name === nameOrId)
    || policies.find((policy) => policy.isDefault)
    || defaultRoutingPolicy(userId);
}
