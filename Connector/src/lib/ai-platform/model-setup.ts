import { getBalance, getOrganizationSubscription, getSubscription } from '@/lib/billing/credits';
import { FREE_PLAN_ID } from '@/lib/billing/credits-policy';
import { planDisplayName } from '@/lib/billing/credit-catalog';
import {
  getOrganizationCreditBalance,
  publicCreditBalance,
  reconcileOrganizationSubscriptionCredits,
} from '@/lib/billing/organization-credits';
import { ensureAiPlatformSchema } from '@/lib/ai-platform/schema';
import { listCredentials, platformSecretFor } from '@/lib/ai-platform/credentials';
import { listModels } from '@/lib/ai-platform/catalog/store';
import { listAdapters } from '@/lib/ai-platform/providers/registry';
import { LOGICAL_ALIASES } from '@/lib/ai-platform/types';
import {
  defaultRemediationAccessMode,
  isBillingEnforced,
  isPaidPlanId,
  platformAliasesForPlan,
  planAllowsCatalogModels,
} from '@/lib/ai-platform/subscription-access';
import {
  DEFAULT_REMEDIATION_PLATFORM_MODEL,
  filterRemediationPlatformModels,
} from '@/lib/ai-platform/remediation-platform-models';

export type SetupModelRow = {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  lifecycle: string;
  coding: boolean;
  agents: boolean;
};

const LIFECYCLE_RANK: Record<string, number> = {
  ACTIVE: 0,
  PREVIEW: 1,
  DISCOVERED: 2,
};

export function dedupeSetupModels(models: SetupModelRow[]): SetupModelRow[] {
  const byKey = new Map<string, SetupModelRow>();
  for (const model of models) {
    const key = `${model.providerId}:${model.providerModelId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, model);
      continue;
    }
    const existingRank = LIFECYCLE_RANK[existing.lifecycle] ?? 99;
    const nextRank = LIFECYCLE_RANK[model.lifecycle] ?? 99;
    if (nextRank < existingRank) {
      byKey.set(key, model);
    }
  }
  return Array.from(byKey.values());
}

export async function userModelSetup(input: { userId: string; organizationId?: string }) {
  const { userId, organizationId } = input;
  await ensureAiPlatformSchema();

  const [userBalance, userSubscription, credentials, models] = await Promise.all([
    getBalance(userId).catch(() => null),
    getSubscription(userId).catch(() => null),
    listCredentials(userId).catch(() => []),
    listModels().catch(() => []),
  ]);

  let planId = userSubscription?.planId || userBalance?.planId || FREE_PLAN_ID;
  let planName = userBalance?.planName || planDisplayName(planId);
  let creditsRemaining = userBalance?.total ?? 0;
  let subscriptionStatus = userSubscription?.status || null;

  if (organizationId) {
    try {
      await reconcileOrganizationSubscriptionCredits(organizationId).catch(() => null);
      const [orgBalance, orgSubscription] = await Promise.all([
        getOrganizationCreditBalance(organizationId),
        getOrganizationSubscription(organizationId).catch(() => null),
      ]);
      creditsRemaining = publicCreditBalance(orgBalance).available;
      if (orgSubscription?.planId) {
        planId = orgSubscription.planId;
        planName = planDisplayName(orgSubscription.planId);
        subscriptionStatus = orgSubscription.status || subscriptionStatus;
      }
    } catch {
      // Keep user-scoped balance when org wallet is unavailable.
    }
  }

  const usableCredentials = credentials.filter(
    (item) => item.status === 'VALID' || item.status === 'PENDING',
  );
  const accessMode = defaultRemediationAccessMode({
    planId,
    hasByok: usableCredentials.length > 0,
  });

  return {
    plan_id: planId,
    plan_name: planName,
    credits_remaining: creditsRemaining,
    subscription_status: subscriptionStatus,
    paid_plan: !isBillingEnforced() || isPaidPlanId(planId),
    platform_aliases: platformAliasesForPlan(planId),
    catalog_allowed: planAllowsCatalogModels(planId),
    default_access_mode: accessMode,
    default_model: DEFAULT_REMEDIATION_PLATFORM_MODEL,
    aliases: [...LOGICAL_ALIASES],
    credentials: usableCredentials.map((item) => ({
      id: item.id,
      providerId: item.providerId,
      name: item.name,
      status: item.status,
      secretMasked: item.secretMasked,
      environment: item.environment,
      allowedModelIds: item.allowedModelIds,
    })),
    models: dedupeSetupModels(
      models
        .filter((model) => model.lifecycle === 'ACTIVE' || model.lifecycle === 'PREVIEW' || model.lifecycle === 'DISCOVERED')
        .map((model) => ({
          id: model.id,
          providerId: model.providerId,
          providerModelId: model.providerModelId,
          displayName: model.displayName,
          lifecycle: model.lifecycle,
          coding: Boolean(model.capabilities.coding),
          agents: Boolean(model.capabilities.agents),
        })),
    ),
    providers: listAdapters().map((adapter) => ({
      id: adapter.definition.id,
      displayName: adapter.definition.displayName,
      platformConfigured: Boolean(platformSecretFor(adapter.definition.id)),
      supportsByok: adapter.definition.supportsByok,
    })),
  };
}

export async function remediationModelSetup(input: { userId: string; organizationId?: string }) {
  const base = await userModelSetup(input);
  return {
    ...base,
    default_model: DEFAULT_REMEDIATION_PLATFORM_MODEL,
    models: filterRemediationPlatformModels(base.models),
  };
}
