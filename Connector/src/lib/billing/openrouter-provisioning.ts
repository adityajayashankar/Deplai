import 'server-only';

import { query } from '@/lib/db';
import { decryptSecret, encryptSecret, maskSecret } from '@/lib/ai-platform/crypto';
import { DEFAULT_METERING_FX_INR_PER_USD } from '@/lib/billing/credit-catalog';
import {
  openRouterManagementKey,
  openRouterProvisioningEnabled,
  providerBudgetPaiseToUsdLimit,
} from '@/lib/ai-platform/platform-upstream';

const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/keys';

type OpenRouterKeyRow = {
  organization_id: string;
  key_hash: string;
  secret_encrypted: string;
  secret_masked: string;
  limit_usd: string | number;
  limit_reset: string;
  disabled: number | boolean;
};

export type OrganizationOpenRouterKey = {
  organizationId: string;
  keyHash: string;
  secretMasked: string;
  limitUsd: number;
  limitReset: 'daily' | 'weekly' | 'monthly';
  disabled: boolean;
};

let schemaReady = false;

export async function ensureOpenRouterProvisioningSchema(): Promise<void> {
  if (schemaReady) return;
  await query(
    `CREATE TABLE IF NOT EXISTS organization_openrouter_keys (
      organization_id VARCHAR(36) PRIMARY KEY,
      key_hash VARCHAR(128) NOT NULL,
      secret_encrypted TEXT NOT NULL,
      secret_masked VARCHAR(32) NOT NULL,
      limit_usd DECIMAL(12,2) NOT NULL DEFAULT 0,
      limit_reset VARCHAR(16) NOT NULL DEFAULT 'monthly',
      disabled TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_org_openrouter_disabled (disabled)
    )`,
  );
  schemaReady = true;
}

function managementHeaders(): Record<string, string> {
  const key = openRouterManagementKey();
  if (!key) throw new Error('OPENROUTER_MANAGEMENT_KEY is not configured');
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function createRemoteOpenRouterKey(input: {
  name: string;
  limitUsd: number;
  limitReset: 'daily' | 'weekly' | 'monthly';
}): Promise<{ key: string; hash: string }> {
  const response = await fetch(OPENROUTER_KEYS_URL, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      name: input.name,
      limit: input.limitUsd,
      limit_reset: input.limitReset,
      include_byok_in_limit: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    data?: { hash?: string; key?: string };
    key?: string;
    hash?: string;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenRouter key creation failed (${response.status})`);
  }
  const key = String(payload.data?.key || payload.key || '').trim();
  const hash = String(payload.data?.hash || payload.hash || '').trim();
  if (!key || !hash) {
    throw new Error('OpenRouter key creation response was missing key or hash');
  }
  return { key, hash };
}

async function patchRemoteOpenRouterKey(input: {
  hash: string;
  limitUsd: number;
  disabled?: boolean;
}): Promise<void> {
  const response = await fetch(`${OPENROUTER_KEYS_URL}/${encodeURIComponent(input.hash)}`, {
    method: 'PATCH',
    headers: managementHeaders(),
    body: JSON.stringify({
      limit: input.limitUsd,
      limit_reset: 'monthly',
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(payload.error?.message || `OpenRouter key update failed (${response.status})`);
  }
}

function toRecord(row: OpenRouterKeyRow): OrganizationOpenRouterKey {
  return {
    organizationId: row.organization_id,
    keyHash: row.key_hash,
    secretMasked: row.secret_masked,
    limitUsd: Number(row.limit_usd),
    limitReset: (row.limit_reset as OrganizationOpenRouterKey['limitReset']) || 'monthly',
    disabled: Boolean(row.disabled),
  };
}

export async function getOrganizationOpenRouterKey(
  organizationId: string,
): Promise<OrganizationOpenRouterKey | null> {
  await ensureOpenRouterProvisioningSchema();
  const rows = await query<OpenRouterKeyRow[]>(
    `SELECT organization_id, key_hash, secret_encrypted, secret_masked, limit_usd, limit_reset, disabled
     FROM organization_openrouter_keys WHERE organization_id = ? LIMIT 1`,
    [organizationId],
  );
  const row = rows[0];
  if (!row || row.disabled) return row ? toRecord(row) : null;
  return toRecord(row);
}

export async function resolveOrganizationOpenRouterSecret(organizationId: string): Promise<string | null> {
  await ensureOpenRouterProvisioningSchema();
  const rows = await query<OpenRouterKeyRow[]>(
    `SELECT secret_encrypted, disabled FROM organization_openrouter_keys
     WHERE organization_id = ? AND disabled = 0 LIMIT 1`,
    [organizationId],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    return decryptSecret(row.secret_encrypted);
  } catch {
    return null;
  }
}

export async function syncOrganizationOpenRouterKey(input: {
  organizationId: string;
  providerBudgetPaise: number;
  limitReset?: 'daily' | 'weekly' | 'monthly';
  fxInrPerUsd?: number;
}): Promise<OrganizationOpenRouterKey | null> {
  if (!openRouterProvisioningEnabled()) return null;
  await ensureOpenRouterProvisioningSchema();

  const limitUsd = providerBudgetPaiseToUsdLimit(
    input.providerBudgetPaise,
    input.fxInrPerUsd ?? DEFAULT_METERING_FX_INR_PER_USD,
  );
  if (limitUsd <= 0) return null;

  const existing = await query<OpenRouterKeyRow[]>(
    `SELECT * FROM organization_openrouter_keys WHERE organization_id = ? LIMIT 1`,
    [input.organizationId],
  );
  const current = existing[0];
  const limitReset = input.limitReset || 'monthly';

  if (current) {
    const nextLimit = Math.max(Number(current.limit_usd), limitUsd);
    await patchRemoteOpenRouterKey({
      hash: current.key_hash,
      limitUsd: nextLimit,
      disabled: false,
    });
    await query(
      `UPDATE organization_openrouter_keys
       SET limit_usd = ?, limit_reset = ?, disabled = 0, updated_at = NOW()
       WHERE organization_id = ?`,
      [nextLimit, limitReset, input.organizationId],
    );
    return {
      organizationId: input.organizationId,
      keyHash: current.key_hash,
      secretMasked: current.secret_masked,
      limitUsd: nextLimit,
      limitReset,
      disabled: false,
    };
  }

  const remote = await createRemoteOpenRouterKey({
    name: `deplai-org-${input.organizationId.slice(0, 8)}`,
    limitUsd,
    limitReset,
  });
  await query(
    `INSERT INTO organization_openrouter_keys (
       organization_id, key_hash, secret_encrypted, secret_masked, limit_usd, limit_reset, disabled
     ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [
      input.organizationId,
      remote.hash,
      encryptSecret(remote.key),
      maskSecret(remote.key),
      limitUsd,
      limitReset,
    ],
  );
  return {
    organizationId: input.organizationId,
    keyHash: remote.hash,
    secretMasked: maskSecret(remote.key),
    limitUsd,
    limitReset,
    disabled: false,
  };
}

export async function disableOrganizationOpenRouterKey(organizationId: string): Promise<void> {
  await ensureOpenRouterProvisioningSchema();
  const rows = await query<OpenRouterKeyRow[]>(
    `SELECT key_hash FROM organization_openrouter_keys WHERE organization_id = ? LIMIT 1`,
    [organizationId],
  );
  const row = rows[0];
  if (!row) return;
  if (openRouterProvisioningEnabled()) {
    await patchRemoteOpenRouterKey({ hash: row.key_hash, limitUsd: 0, disabled: true });
  }
  await query(
    `UPDATE organization_openrouter_keys SET disabled = 1, updated_at = NOW() WHERE organization_id = ?`,
    [organizationId],
  );
}

export async function provisionOpenRouterKeyForCreditGrant(input: {
  organizationId: string;
  providerBudgetPaise: number;
}): Promise<void> {
  if (!openRouterProvisioningEnabled()) return;
  try {
    await syncOrganizationOpenRouterKey({
      organizationId: input.organizationId,
      providerBudgetPaise: input.providerBudgetPaise,
    });
  } catch (error) {
    console.error('OpenRouter key provisioning failed for org %s: %s', input.organizationId, error);
  }
}
