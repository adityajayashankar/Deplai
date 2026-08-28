import { getBalance, getSubscription } from '@/lib/billing/credits';
import { FREE_PLAN_ID } from '@/lib/billing/credits-policy';
import { ensureAiPlatformSchema } from '@/lib/ai-platform/schema';
import { listCredentials, platformSecretFor } from '@/lib/ai-platform/credentials';
import { listModels } from '@/lib/ai-platform/catalog/store';
import { listAdapters } from '@/lib/ai-platform/providers/registry';
import { LOGICAL_ALIASES } from '@/lib/ai-platform/types';
import {
  defaultRemediationAccessMode,
  defaultRemediationModel,
  isBillingEnforced,
  isPaidPlanId,
  platformAliasesForPlan,
  planAllowsCatalogModels,
} from '@/lib/ai-platform/subscription-access';

export async function userModelSetup(userId: string) {
  await ensureAiPlatformSchema();

  const [balance, subscription, credentials, models] = await Promise.all([
    getBalance(userId).catch(() => null),
    getSubscription(userId).catch(() => null),
    listCredentials(userId).catch(() => []),
    listModels().catch(() => []),
  ]);

  const planId = subscription?.planId || balance?.planId || FREE_PLAN_ID;
  const usableCredentials = credentials.filter(
    (item) => item.status === 'VALID' || item.status === 'PENDING',
  );
  const accessMode = defaultRemediationAccessMode({
    planId,
    hasByok: usableCredentials.length > 0,
  });

  return {
    plan_id: planId,
    plan_name: balance?.planName || planId,
    credits_remaining: balance?.total ?? 0,
    subscription_status: subscription?.status || null,
    paid_plan: !isBillingEnforced() || isPaidPlanId(planId),
    platform_aliases: platformAliasesForPlan(planId),
    catalog_allowed: planAllowsCatalogModels(planId),
    default_access_mode: accessMode,
    default_model: defaultRemediationModel(planId),
    aliases: [...LOGICAL_ALIASES],
    credentials: usableCredentials.map((item) => ({
      id: item.id,
      providerId: item.providerId,
      name: item.name,
      status: item.status,
      secretMasked: item.secretMasked,
      environment: item.environment,
    })),
    models: models
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
    providers: listAdapters().map((adapter) => ({
      id: adapter.definition.id,
      displayName: adapter.definition.displayName,
      platformConfigured: Boolean(platformSecretFor(adapter.definition.id)),
      supportsByok: adapter.definition.supportsByok,
    })),
  };
}
