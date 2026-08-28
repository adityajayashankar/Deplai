import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { ensureAiPlatformSchema } from './schema';
import type { BillingSource, CanonicalModel, CostBreakdown, UsageBreakdown } from './types';

const PLATFORM_MARGIN = 0.12;

export function estimateCost(model: CanonicalModel, usage: UsageBreakdown, billingSource: BillingSource): CostBreakdown {
  const inputRate = model.pricing.inputPerMillionUsd ?? 0;
  const outputRate = model.pricing.outputPerMillionUsd ?? 0;
  const providerCost = (usage.inputTokens / 1_000_000) * inputRate + (usage.outputTokens / 1_000_000) * outputRate;
  if (billingSource === 'byok') {
    return {
      providerCostUsd: 0,
      platformCostUsd: Number((providerCost * 0.05).toFixed(6)),
      customerChargeUsd: Number((providerCost * 0.05).toFixed(6)),
      billingSource,
      estimated: usage.estimated || model.pricing.source !== 'provider_declared',
    };
  }
  const customer = providerCost * (1 + PLATFORM_MARGIN);
  return {
    providerCostUsd: Number(providerCost.toFixed(6)),
    platformCostUsd: Number((customer - providerCost).toFixed(6)),
    customerChargeUsd: Number(customer.toFixed(6)),
    billingSource,
    estimated: usage.estimated || !model.pricing.inputPerMillionUsd,
  };
}

export async function recordUsage(input: {
  userId: string;
  requestId: string;
  providerId: string;
  modelId: string;
  credentialSource: string;
  usage: UsageBreakdown;
  cost: CostBreakdown;
}): Promise<void> {
  try {
    await ensureAiPlatformSchema();
    await query(
      `INSERT INTO ai_usage (
        id, user_id, request_id, provider_id, model_id, credential_source,
        input_tokens, output_tokens, cached_tokens, reasoning_tokens, tool_calls, estimated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.userId,
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
        id, user_id, request_id, provider_cost_usd, platform_cost_usd, customer_charge_usd, billing_source, estimated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.userId,
        input.requestId,
        input.cost.providerCostUsd,
        input.cost.platformCostUsd,
        input.cost.customerChargeUsd,
        input.cost.billingSource,
        input.cost.estimated ? 1 : 0,
      ],
    );
  } catch {
    /* metering must not fail the user request */
  }
}

export async function summarizeUsage(userId: string) {
  await ensureAiPlatformSchema();
  const windowSql = 'user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
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
    [userId],
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
    [userId],
  );
  const byProvider = await query<Array<{ provider_id: string; requests: number; tokens: number; input_tokens: number; output_tokens: number }>>(
    `SELECT provider_id,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM ai_usage WHERE ${windowSql}
     GROUP BY provider_id ORDER BY requests DESC`,
    [userId],
  );
  const byCredentialSource = await query<Array<{ credential_source: string; requests: number; tokens: number }>>(
    `SELECT credential_source, COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
     FROM ai_usage WHERE ${windowSql}
     GROUP BY credential_source ORDER BY requests DESC`,
    [userId],
  );
  const byModel = await query<Array<{ provider_id: string; model_id: string; requests: number; tokens: number }>>(
    `SELECT provider_id, model_id, COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
     FROM ai_usage WHERE ${windowSql}
     GROUP BY provider_id, model_id ORDER BY requests DESC LIMIT 12`,
    [userId],
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
    [userId],
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
       WHERE c.user_id = ? AND c.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY u.provider_id
       ORDER BY customer_charge_usd DESC`,
      [userId],
    );
    estimatedVsActual = await query<typeof estimatedVsActual>(
      `SELECT estimated, COUNT(*) AS requests, COALESCE(SUM(customer_charge_usd), 0) AS customer_charge_usd
       FROM ai_costs WHERE ${windowSql}
       GROUP BY estimated`,
      [userId],
    );
  } catch {
    /* breakdowns are best-effort */
  }
  return {
    usage: usage || { requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, tool_calls: 0 },
    costs: costs || { provider_cost_usd: 0, platform_cost_usd: 0, customer_charge_usd: 0 },
    byProvider,
    byCredentialSource,
    byModel,
    byBillingSource,
    costsByProvider,
    estimatedVsActual,
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
