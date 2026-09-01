import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { ensureAiPlatformSchema } from './schema';
import type { BillingSource, CanonicalModel, CostBreakdown, UsageBreakdown } from './types';

export function minimumPlatformChargeUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CREDIT_MIN_PLATFORM_CHARGE_USD ?? '0.001');
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Bill at least a small managed-platform charge when token usage occurred on $0 catalog models. */
export function platformMeteringCostUsd(
  model: CanonicalModel,
  usage: UsageBreakdown,
): number {
  const cost = estimateCost(model, usage, 'platform');
  if (cost.providerCostUsd > 0) return cost.providerCostUsd;
  const min = minimumPlatformChargeUsd();
  const tokens = usage.inputTokens + usage.outputTokens;
  return tokens > 0 && min > 0 ? min : 0;
}

export function estimateCost(model: CanonicalModel, usage: UsageBreakdown, billingSource: BillingSource): CostBreakdown {
  const inputRate = model.pricing.inputPerMillionUsd ?? 0;
  const outputRate = model.pricing.outputPerMillionUsd ?? 0;
  const providerCost = (usage.inputTokens / 1_000_000) * inputRate + (usage.outputTokens / 1_000_000) * outputRate;
  if (billingSource === 'byok') {
    return {
      providerCostUsd: Number(providerCost.toFixed(6)),
      platformCostUsd: 0,
      customerChargeUsd: 0,
      billingSource,
      estimated: usage.estimated || model.pricing.source !== 'provider_declared',
    };
  }
  return {
    providerCostUsd: Number(providerCost.toFixed(6)),
    platformCostUsd: 0,
    customerChargeUsd: Number(providerCost.toFixed(6)),
    billingSource,
    estimated: usage.estimated || !model.pricing.inputPerMillionUsd,
  };
}

export async function recordUsage(input: {
  userId: string;
  organizationId: string;
  projectId?: string | null;
  requestId: string;
  providerId: string;
  modelId: string;
  credentialSource: string;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  failClosed?: boolean;
}): Promise<void> {
  try {
    await ensureAiPlatformSchema();
    await query(
      `INSERT INTO ai_usage (
        id, user_id, organization_id, project_id, request_id, provider_id, model_id, credential_source,
        input_tokens, output_tokens, cached_tokens, reasoning_tokens, tool_calls, estimated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.userId,
        input.organizationId,
        input.projectId || null,
        input.requestId,
        input.providerId,
        input.modelId,
        input.credentialSource,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cachedTokens,
        input.usage.reasoningTokens,
        input.usage.toolCalls,
        input.usage.estimated ? 1 : 0,
      ],
    );
    await query(
      `INSERT INTO ai_costs (
        id, user_id, organization_id, request_id, provider_cost_usd, platform_cost_usd, customer_charge_usd, billing_source, estimated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.userId,
        input.organizationId,
        input.requestId,
        input.cost.providerCostUsd,
        input.cost.platformCostUsd,
        input.cost.customerChargeUsd,
        input.cost.billingSource,
        input.cost.estimated ? 1 : 0,
      ],
    );
  } catch (error) {
    if (input.failClosed) throw error;
  }
}

export async function summarizeUsage(userId: string, organizationId?: string) {
  await ensureAiPlatformSchema();
  const scopeColumn = organizationId ? 'organization_id' : 'user_id';
  const scopeId = organizationId || userId;
  const windowSql = `${scopeColumn} = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
  const [usage] = await query<Array<{
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    tool_calls: number;
  }>>(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
            COALESCE(SUM(tool_calls), 0) AS tool_calls
     FROM ai_usage WHERE ${windowSql}`,
    [scopeId],
  );
  const [costs] = await query<Array<{
    provider_cost_usd: number;
    platform_cost_usd: number;
    customer_charge_usd: number;
  }>>(
    `SELECT COALESCE(SUM(provider_cost_usd), 0) AS provider_cost_usd,
            COALESCE(SUM(platform_cost_usd), 0) AS platform_cost_usd,
            COALESCE(SUM(customer_charge_usd), 0) AS customer_charge_usd
     FROM ai_costs WHERE ${windowSql}`,
    [scopeId],
  );
  const byProvider = await query<Array<{ provider_id: string; requests: number; tokens: number; input_tokens: number; output_tokens: number }>>(
    `SELECT provider_id,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM ai_usage WHERE ${windowSql}
     GROUP BY provider_id ORDER BY requests DESC`,
    [scopeId],
  );
  const byCredentialSource = await query<Array<{ credential_source: string; requests: number; tokens: number }>>(
    `SELECT credential_source, COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
     FROM ai_usage WHERE ${windowSql}
     GROUP BY credential_source ORDER BY requests DESC`,
    [scopeId],
  );
  const byModel = await query<Array<{ provider_id: string; model_id: string; requests: number; tokens: number }>>(
    `SELECT provider_id, model_id, COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
     FROM ai_usage WHERE ${windowSql}
     GROUP BY provider_id, model_id ORDER BY requests DESC LIMIT 12`,
    [scopeId],
  );
  const byBillingSource = await query<Array<{
    billing_source: string;
    requests: number;
    provider_cost_usd: number;
    platform_cost_usd: number;
    customer_charge_usd: number;
  }>>(
    `SELECT billing_source,
            COUNT(*) AS requests,
            COALESCE(SUM(provider_cost_usd), 0) AS provider_cost_usd,
            COALESCE(SUM(platform_cost_usd), 0) AS platform_cost_usd,
            COALESCE(SUM(customer_charge_usd), 0) AS customer_charge_usd
     FROM ai_costs WHERE ${windowSql}
     GROUP BY billing_source ORDER BY customer_charge_usd DESC`,
    [scopeId],
  );
  let costsByProvider: Array<{
    provider_id: string;
    requests: number;
    provider_cost_usd: number;
    platform_cost_usd: number;
    customer_charge_usd: number;
  }> = [];
  let estimatedVsActual: Array<{ estimated: number; requests: number; customer_charge_usd: number }> = [];
  try {
    costsByProvider = await query<typeof costsByProvider>(
      `SELECT u.provider_id,
              COUNT(*) AS requests,
              COALESCE(SUM(c.provider_cost_usd), 0) AS provider_cost_usd,
              COALESCE(SUM(c.platform_cost_usd), 0) AS platform_cost_usd,
              COALESCE(SUM(c.customer_charge_usd), 0) AS customer_charge_usd
       FROM ai_costs c
       INNER JOIN ai_usage u ON u.request_id = c.request_id AND u.user_id = c.user_id
       WHERE c.${scopeColumn} = ? AND c.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY u.provider_id
       ORDER BY customer_charge_usd DESC`,
      [scopeId],
    );
    estimatedVsActual = await query<typeof estimatedVsActual>(
      `SELECT estimated, COUNT(*) AS requests, COALESCE(SUM(customer_charge_usd), 0) AS customer_charge_usd
       FROM ai_costs WHERE ${windowSql}
       GROUP BY estimated`,
      [scopeId],
    );
  } catch {
    /* breakdowns are best-effort */
  }
  const byMember = organizationId ? await query<Array<{ user_id: string; requests: number; tokens: number }>>(
    `SELECT user_id, COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
     FROM ai_usage WHERE ${windowSql} GROUP BY user_id ORDER BY requests DESC LIMIT 25`,
    [scopeId],
  ).catch(() => []) : [];
  const byProject = organizationId ? await query<Array<{ project_id: string | null; requests: number; tokens: number }>>(
    `SELECT project_id, COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
     FROM ai_usage WHERE ${windowSql} GROUP BY project_id ORDER BY requests DESC LIMIT 25`,
    [scopeId],
  ).catch(() => []) : [];
  return {
    usage: usage || { requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, tool_calls: 0 },
    costs: costs || { provider_cost_usd: 0, platform_cost_usd: 0, customer_charge_usd: 0 },
    byProvider,
    byCredentialSource,
    byModel,
    byBillingSource,
    costsByProvider,
    estimatedVsActual,
    byMember,
    byProject,
  };
}

export async function listRequestLogs(userId: string, limit = 50) {
  await ensureAiPlatformSchema();
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  try {
    return await query(
      `SELECT * FROM ai_request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
      [userId],
    );
  } catch {
    return [];
  }
}
