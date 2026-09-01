import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '@/lib/db';
import { getBalance, getOrganizationSubscription, getSubscription, grantPaidCredits } from '@/lib/billing/credits';
import {
  getOrganizationCreditBalance,
  reconcileOrganizationSubscriptionCredits,
} from '@/lib/billing/organization-credits';
import { planDisplayName, unitsToCredits } from '@/lib/billing/credit-catalog';
import { resolveActiveOrganization } from '@/lib/organizations/store';
import { listRoutingPolicies, saveRoutingPolicy, defaultRoutingPolicy } from '@/lib/ai-platform/routing';
import { listModels } from '@/lib/ai-platform/catalog/store';
import { PROVIDER_IDS, type ProviderId } from '@/lib/ai-platform/types';
import { LOGIN_HREF } from '@/lib/auth-providers';
import {
  AUTO_TOPUP_DEFAULT_ADD,
  AUTO_TOPUP_DEFAULT_THRESHOLD,
  type EfficientPoolEntry,
  type ProfilePatch,
  type RoutingModeId,
  routingModeById,
  validateEfficientPool,
  validateProfilePatch,
  validatePromoCode,
} from './logic';
import { allocateUniqueReferralCode, ensureUserReferralCode } from '@/lib/referrals/codes';
import { decryptApiToken, encryptApiToken, generateApiToken, hashApiToken } from './crypto';
import { ensureProfileSchema } from './schema';

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  contact_email: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  routing_mode: string;
  efficient_pool_json: unknown;
  auto_topup_enabled: number | boolean;
  auto_topup_threshold_usd: number;
  auto_topup_add_usd: number;
  payment_method_last4: string | null;
  referral_code: string;
};

type TokenRow = {
  user_id: string;
  token_hash: string;
  token_encrypted: string;
  token_prefix: string;
  token_last4: string;
  last_used_at: Date | string | null;
  last_used_client: string | null;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  login?: string;
  avatarUrl?: string;
};

function asBool(value: number | boolean): boolean {
  return Boolean(value);
}

function parsePool(value: unknown): EfficientPoolEntry[] {
  try {
    const raw = Array.isArray(value) ? value : typeof value === 'string' ? JSON.parse(value) : [];
    const parsed = validateEfficientPool(raw);
    return parsed.ok ? parsed.value : [];
  } catch {
    return [];
  }
}

async function loadRow(userId: string): Promise<ProfileRow | null> {
  const rows = await query<ProfileRow[]>(
    `SELECT * FROM user_profiles WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

async function ensureRow(user: SessionUser): Promise<ProfileRow> {
  await ensureProfileSchema();
  const existing = await loadRow(user.id);
  if (existing) {
    await ensureUserReferralCode({
      userId: user.id,
      login: user.login,
      displayName: user.name,
      email: user.email,
    });
    const refreshed = await loadRow(user.id);
    if (refreshed) return refreshed;
    return existing;
  }
  const referral = await allocateUniqueReferralCode({
    userId: user.id,
    login: user.login,
    displayName: user.name,
    email: user.email,
  });
  const githubUrl = user.login ? `https://github.com/${user.login}` : '';
  try {
    await query(
      `INSERT INTO user_profiles (
        user_id, display_name, contact_email, linkedin_url, github_url, routing_mode, efficient_pool_json,
        auto_topup_enabled, auto_topup_threshold_usd, auto_topup_add_usd, referral_code
      ) VALUES (?, ?, ?, '', ?, 'default', CAST('[]' AS JSON), 0, ?, ?, ?)`,
      [
        user.id,
        user.name || user.login || '',
        user.email,
        githubUrl,
        AUTO_TOPUP_DEFAULT_THRESHOLD,
        AUTO_TOPUP_DEFAULT_ADD,
        referral,
      ],
    );
  } catch {
    /* concurrent insert */
  }
  const created = await loadRow(user.id);
  if (!created) throw new Error('Failed to provision profile');
  return created;
}

function publicProfile(user: SessionUser, row: ProfileRow) {
  return {
    id: user.id,
    displayName: row.display_name || user.name || user.login || 'DeplAI user',
    email: row.contact_email || user.email,
    authEmail: user.email,
    login: user.login || '',
    avatarUrl: user.avatarUrl || '',
    linkedinUrl: row.linkedin_url || '',
    githubUrl: row.github_url || (user.login ? `https://github.com/${user.login}` : ''),
    referralCode: row.referral_code,
  };
}

export async function getProfileBundle(user: SessionUser) {
  const row = await ensureRow(user);
  const [balance, subscription, token, organizationBilling] = await Promise.all([
    getBalance(user.id).catch(() => null),
    getSubscription(user.id).catch(() => null),
    getMaskedApiToken(user.id).catch(() => ({ configured: false, masked: '', lastUsedAt: null, lastUsedClient: null })),
    loadOrganizationBilling(user).catch(() => null),
  ]);
  const enrichedSubscription = subscription
    ? { ...subscription, planName: planDisplayName(subscription.planId) }
    : organizationBilling?.subscription || null;
  const credits = organizationBilling?.credits || (balance
    ? {
        paid_remaining: balance.paidRemaining,
        bonus_remaining: balance.bonusRemaining,
        bonus_unlocked: balance.bonusUnlocked,
        bonus_expires_at: balance.bonusExpiresAt,
        total: balance.total,
        plan_id: balance.planId,
        plan_name: balance.planName,
        cycle_start: balance.cycleStart,
        cycle_end: balance.cycleEnd,
      }
    : null);
  return {
    profile: publicProfile(user, row),
    credits,
    subscription: enrichedSubscription,
    organizationCredits: organizationBilling?.credits || null,
    routing: {
      mode: routingModeById(row.routing_mode).id as RoutingModeId,
      efficientPool: parsePool(row.efficient_pool_json),
    },
    autoTopup: {
      enabled: asBool(row.auto_topup_enabled),
      thresholdUsd: Number(row.auto_topup_threshold_usd) || AUTO_TOPUP_DEFAULT_THRESHOLD,
      addUsd: Number(row.auto_topup_add_usd) || AUTO_TOPUP_DEFAULT_ADD,
      paymentMethodLast4: row.payment_method_last4 || '',
    },
    apiToken: token,
  };
}

async function loadOrganizationBilling(user: SessionUser) {
  const organization = await resolveActiveOrganization(user);
  await reconcileOrganizationSubscriptionCredits(organization.id).catch(() => null);
  const [subscription, wallet] = await Promise.all([
    getOrganizationSubscription(organization.id).catch(() => null),
    getOrganizationCreditBalance(organization.id).catch(() => null),
  ]);
  if (!wallet) return null;
  const planId = subscription?.planId || 'free';
  return {
    organizationId: organization.id,
    subscription: subscription
      ? { ...subscription, planName: planDisplayName(subscription.planId) }
      : null,
    credits: {
      paid_remaining: unitsToCredits(wallet.availableUnits),
      bonus_remaining: 0,
      bonus_unlocked: false,
      bonus_expires_at: null,
      total: unitsToCredits(wallet.availableUnits),
      plan_id: planId,
      plan_name: planDisplayName(planId),
      cycle_start: null,
      cycle_end: null,
      organization_id: organization.id,
      never_expires: true,
    },
  };
}

export async function updateProfile(user: SessionUser, patch: ProfilePatch) {
  const validated = validateProfilePatch(patch);
  if (!validated.ok) {
    const error = new Error('Invalid profile');
    (error as Error & { details?: Record<string, string> }).details = validated.errors;
    throw error;
  }
  const row = await ensureRow(user);
  await query(
    `UPDATE user_profiles
     SET display_name = ?, contact_email = ?, linkedin_url = ?, github_url = ?
     WHERE user_id = ?`,
    [
      validated.value.displayName,
      validated.value.email,
      validated.value.linkedinUrl,
      validated.value.githubUrl,
      row.user_id,
    ],
  );
  await query(`UPDATE users SET name = ? WHERE id = ?`, [validated.value.displayName, user.id]);
  const next = await loadRow(user.id);
  if (!next) throw new Error('Failed to save profile');
  return publicProfile({ ...user, name: validated.value.displayName }, next);
}

export async function saveRoutingPreferences(
  user: SessionUser,
  input: { mode?: string; efficientPool?: unknown },
) {
  const row = await ensureRow(user);
  const mode = routingModeById(String(input.mode || row.routing_mode));
  const pool = validateEfficientPool(input.efficientPool ?? parsePool(row.efficient_pool_json));
  if (!pool.ok) throw new Error(pool.error);
  await query(
    `UPDATE user_profiles SET routing_mode = ?, efficient_pool_json = CAST(? AS JSON) WHERE user_id = ?`,
    [mode.id, JSON.stringify(pool.value), user.id],
  );

  const policies = await listRoutingPolicies(user.id);
  const current = policies.find((policy) => policy.isDefault) || policies[0] || defaultRoutingPolicy(user.id);
  const fromPool = Array.from(new Set(
    pool.value
      .map((entry) => entry.modelId.split(':')[0])
      .filter((id): id is ProviderId => (PROVIDER_IDS as readonly string[]).includes(id)),
  ));
  await saveRoutingPolicy(user.id, {
    id: current.id,
    name: current.name,
    taskType: current.taskType,
    primaryAlias: mode.primaryAlias,
    secondaryAlias: current.secondaryAlias || 'best_fast',
    fallbackModelId: current.fallbackModelId || pool.value[0]?.modelId || null,
    accessMode: current.accessMode,
    allowedProviders: fromPool.length ? fromPool : current.allowedProviders,
    weights: current.weights,
    isDefault: true,
  });

  return {
    mode: mode.id as RoutingModeId,
    efficientPool: pool.value,
  };
}

export async function listSelectableModels() {
  const models = await listModels();
  return models
    .filter((model) => model.lifecycle === 'ACTIVE' || model.lifecycle === 'PREVIEW')
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      providerId: model.providerId,
      variant: model.version || 'default',
      family: model.family,
    }));
}

export async function saveAutoTopup(
  user: SessionUser,
  input: { enabled?: boolean; thresholdUsd?: number; addUsd?: number },
) {
  const row = await ensureRow(user);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : asBool(row.auto_topup_enabled);
  const thresholdUsd = Number.isFinite(Number(input.thresholdUsd))
    ? Math.max(1, Math.min(500, Math.round(Number(input.thresholdUsd))))
    : Number(row.auto_topup_threshold_usd);
  const addUsd = Number.isFinite(Number(input.addUsd))
    ? Math.max(5, Math.min(500, Math.round(Number(input.addUsd))))
    : Number(row.auto_topup_add_usd);
  await query(
    `UPDATE user_profiles
     SET auto_topup_enabled = ?, auto_topup_threshold_usd = ?, auto_topup_add_usd = ?
     WHERE user_id = ?`,
    [enabled ? 1 : 0, thresholdUsd, addUsd, user.id],
  );
  return {
    enabled,
    thresholdUsd,
    addUsd,
    paymentMethodLast4: row.payment_method_last4 || '',
  };
}

export async function getMaskedApiToken(userId: string) {
  await ensureProfileSchema();
  const rows = await query<TokenRow[]>(`SELECT * FROM user_api_tokens WHERE user_id = ? LIMIT 1`, [userId]);
  const row = rows[0];
  if (!row) {
    return { configured: false, masked: '', lastUsedAt: null as string | null, lastUsedClient: null as string | null };
  }
  return {
    configured: true,
    masked: `${row.token_prefix}${'•'.repeat(16)}${row.token_last4}`,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    lastUsedClient: row.last_used_client,
  };
}

export async function revealApiToken(userId: string): Promise<{ token: string; masked: string } | null> {
  await ensureProfileSchema();
  const rows = await query<TokenRow[]>(`SELECT * FROM user_api_tokens WHERE user_id = ? LIMIT 1`, [userId]);
  if (!rows[0]) return null;
  const token = decryptApiToken(rows[0].token_encrypted);
  return {
    token,
    masked: `${rows[0].token_prefix}${'•'.repeat(16)}${rows[0].token_last4}`,
  };
}

export async function rotateApiToken(userId: string) {
  await ensureProfileSchema();
  const token = generateApiToken();
  const prefix = token.slice(0, 8);
  const last4 = token.slice(-4);
  await query(
    `INSERT INTO user_api_tokens (user_id, token_hash, token_encrypted, token_prefix, token_last4)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       token_hash = VALUES(token_hash),
       token_encrypted = VALUES(token_encrypted),
       token_prefix = VALUES(token_prefix),
       token_last4 = VALUES(token_last4),
       last_used_at = NULL,
       last_used_client = NULL`,
    [userId, hashApiToken(token), encryptApiToken(token), prefix, last4],
  );
  return {
    token,
    masked: `${prefix}${'•'.repeat(16)}${last4}`,
    configured: true,
  };
}

export async function resolveUserFromApiToken(
  token: string,
  clientHint?: string | null,
): Promise<SessionUser | null> {
  const trimmed = token.trim();
  if (!trimmed.startsWith('dpl_live_')) return null;

  await ensureProfileSchema();
  const rows = await query<Array<{
    user_id: string;
    email: string;
    name: string | null;
    display_name: string | null;
    github_url: string | null;
  }>>(
    `SELECT u.id AS user_id, u.email, u.name, p.display_name, p.github_url
     FROM user_api_tokens t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN user_profiles p ON p.user_id = u.id
     WHERE t.token_hash = ?
     LIMIT 1`,
    [hashApiToken(trimmed)],
  );
  const row = rows[0];
  if (!row) return null;

  const client = clientHint?.trim().slice(0, 32) || 'api';
  await query(
    `UPDATE user_api_tokens SET last_used_at = NOW(), last_used_client = ? WHERE user_id = ?`,
    [client, row.user_id],
  );

  const login = row.github_url?.match(/github\.com\/([^/?#]+)/i)?.[1] || '';
  return {
    id: row.user_id,
    email: row.email,
    name: row.display_name || row.name || 'DeplAI user',
    login,
    avatarUrl: '',
  };
}

export async function integrationStatus(userId: string) {
  let installationCount = 0;
  try {
    const rows = await query<Array<{ n: number }>>(
      `SELECT COUNT(*) AS n
       FROM github_installations
       WHERE user_id = ?
         AND (suspended_at IS NULL)`,
      [userId],
    );
    installationCount = Number(rows[0]?.n || 0);
  } catch {
    installationCount = 0;
  }
  const connected = installationCount > 0;
  return {
    github: { connected, installationCount },
    connectors: [
      { id: 'github', name: 'GitHub', comingSoon: false, connected },
      { id: 'gitlab', name: 'GitLab', comingSoon: true, connected: false },
      { id: 'slack', name: 'Slack', comingSoon: true, connected: false },
      { id: 'linear', name: 'Linear', comingSoon: true, connected: false },
      { id: 'jira', name: 'Jira', comingSoon: true, connected: false },
    ],
  };
}

type PromoRow = {
  code: string;
  credit_amount: number;
  max_redemptions: number | null;
  redeemed_count: number;
  expires_at: Date | string | null;
  active: number | boolean;
};

export async function redeemPromoCode(userId: string, rawCode: string) {
  const parsed = validatePromoCode(rawCode);
  if (!parsed.ok) {
    const error = new Error(parsed.error);
    (error as Error & { status?: number; code?: string }).status = 400;
    (error as Error & { code?: string }).code = 'invalid';
    throw error;
  }
  await ensureProfileSchema();
  return withTransaction(async (exec) => {
    const rows = await exec<PromoRow[]>(
      `SELECT * FROM promo_codes WHERE code = ? LIMIT 1 FOR UPDATE`,
      [parsed.code],
    );
    const promo = rows[0];
    if (!promo || !asBool(promo.active)) {
      const error = new Error('This promotional code is not valid.');
      (error as Error & { status?: number; code?: string }).status = 400;
      (error as Error & { code?: string }).code = 'invalid';
      throw error;
    }
    const expires = promo.expires_at ? new Date(promo.expires_at) : null;
    if (expires && expires.getTime() < Date.now()) {
      const error = new Error('This promotional code has expired.');
      (error as Error & { status?: number; code?: string }).status = 410;
      (error as Error & { code?: string }).code = 'expired';
      throw error;
    }
    if (promo.max_redemptions != null && Number(promo.redeemed_count) >= Number(promo.max_redemptions)) {
      const error = new Error('This promotional code has already been fully redeemed.');
      (error as Error & { status?: number; code?: string }).status = 409;
      (error as Error & { code?: string }).code = 'used';
      throw error;
    }
    const existing = await exec<Array<{ id: string }>>(
      `SELECT id FROM promo_redemptions WHERE user_id = ? AND code = ? LIMIT 1`,
      [userId, parsed.code],
    );
    if (existing[0]) {
      const error = new Error('You have already redeemed this promotional code.');
      (error as Error & { status?: number; code?: string }).status = 409;
      (error as Error & { code?: string }).code = 'used';
      throw error;
    }

    await exec(
      `INSERT INTO promo_redemptions (id, user_id, code, credit_amount) VALUES (?, ?, ?, ?)`,
      [randomUUID(), userId, parsed.code, Number(promo.credit_amount)],
    );
    await exec(
      `UPDATE promo_codes SET redeemed_count = redeemed_count + 1 WHERE code = ?`,
      [parsed.code],
    );
    return { code: parsed.code, creditAmount: Number(promo.credit_amount) };
  }).then(async (result) => {
    const balance = await grantPaidCredits(userId, result.creditAmount, { source: `promo:${result.code}`.slice(0, 64) });
    return { ...result, balance };
  });
}

export async function deleteAccount(user: SessionUser, confirmation: string) {
  if (confirmation.trim() !== 'DELETE') {
    const error = new Error('Type DELETE to confirm account deletion.');
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const subscription = await getSubscription(user.id).catch(() => null);
  const paidActive = Boolean(
    subscription
    && subscription.status === 'active'
    && subscription.planId
    && subscription.planId !== 'free',
  );
  if (paidActive) {
    const error = new Error('Cancel your active subscription before deleting this account.');
    (error as Error & { status?: number; code?: string }).status = 409;
    (error as Error & { code?: string }).code = 'subscription_active';
    throw error;
  }

  await ensureProfileSchema();
  const anonymizedEmail = `deleted+${user.id.replace(/-/g, '').slice(0, 12)}@users.invalid`;
  await query(`DELETE FROM user_api_tokens WHERE user_id = ?`, [user.id]);
  await query(`DELETE FROM user_profiles WHERE user_id = ?`, [user.id]);
  await query(`UPDATE users SET email = ?, name = ? WHERE id = ?`, [anonymizedEmail, 'Deleted User', user.id]);
  return { redirectTo: LOGIN_HREF };
}
