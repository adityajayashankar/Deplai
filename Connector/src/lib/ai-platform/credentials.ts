import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { firstEnv } from './config';
import { decryptSecret, encryptSecret, maskSecret } from './crypto';
import { ensureAiPlatformSchema } from './schema';
import { getProviderDefinition } from './providers/definitions';
import { getAdapter } from './providers/registry';
import { writeAudit } from './audit';
import type {
  AccessMode,
  CredentialRecord,
  CredentialState,
  CredentialType,
  ProviderId,
  ResolvedCredential,
} from './types';

type CredentialRow = {
  id: string;
  user_id: string;
  provider_id: string;
  name: string;
  type: CredentialType;
  status: CredentialState;
  secret_encrypted: string;
  secret_masked: string;
  environment: CredentialRecord['environment'];
  scope: string | null;
  allowed_model_ids_json: unknown;
  created_by: string;
  last_validated_at: Date | string | null;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
};

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseIds(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id as ProviderId,
    name: row.name,
    type: row.type,
    status: row.status,
    secretMasked: row.secret_masked,
    environment: row.environment,
    scope: row.scope,
    allowedModelIds: parseIds(row.allowed_model_ids_json),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    lastValidatedAt: toIso(row.last_validated_at),
    lastUsedAt: toIso(row.last_used_at),
    expiresAt: toIso(row.expires_at),
  };
}

export async function listCredentials(userId: string, providerId?: string): Promise<CredentialRecord[]> {
  await ensureAiPlatformSchema();
  const rows = providerId
    ? await query<CredentialRow[]>(
      'SELECT * FROM ai_provider_credentials WHERE user_id = ? AND provider_id = ? ORDER BY created_at DESC',
      [userId, providerId],
    )
    : await query<CredentialRow[]>(
      'SELECT * FROM ai_provider_credentials WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    );
  return rows.map(toRecord);
}

export async function getCredential(userId: string, id: string): Promise<CredentialRow | null> {
  await ensureAiPlatformSchema();
  const rows = await query<CredentialRow[]>(
    'SELECT * FROM ai_provider_credentials WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  );
  return rows[0] || null;
}

export async function createCredential(input: {
  userId: string;
  providerId: ProviderId;
  name: string;
  secret: string;
  environment?: CredentialRecord['environment'];
  allowedModelIds?: string[] | null;
}): Promise<{ record: CredentialRecord; validation: { ok: boolean; message: string; modelsDiscovered: number } }> {
  await ensureAiPlatformSchema();
  const adapter = getAdapter(input.providerId);
  if (!adapter) {
    return {
      record: {
        id: '',
        userId: input.userId,
        providerId: input.providerId,
        name: input.name,
        type: 'BYOK',
        status: 'INVALID',
        secretMasked: maskSecret(input.secret),
        environment: input.environment || 'production',
        scope: null,
        allowedModelIds: input.allowedModelIds || null,
        createdBy: input.userId,
        createdAt: new Date().toISOString(),
        lastValidatedAt: null,
        lastUsedAt: null,
        expiresAt: null,
      },
      validation: { ok: false, message: 'Unknown provider', modelsDiscovered: 0 },
    };
  }
  const validation = await adapter.validateCredentials(input.secret);
  const id = randomUUID();
  const status: CredentialState = validation.ok ? 'VALID' : validation.code === 'authentication_failed' ? 'INVALID' : 'ERROR';
  await query(
    `INSERT INTO ai_provider_credentials (
      id, user_id, provider_id, name, type, status, secret_encrypted, secret_masked, environment, allowed_model_ids_json, created_by, last_validated_at
    ) VALUES (?, ?, ?, ?, 'BYOK', ?, ?, ?, ?, ?, ?, ${validation.ok ? 'NOW()' : 'NULL'})`,
    [
      id,
      input.userId,
      input.providerId,
      input.name.trim() || `${adapter.definition.displayName} key`,
      status,
      encryptSecret(input.secret),
      maskSecret(input.secret),
      input.environment || 'production',
      input.allowedModelIds ? JSON.stringify(input.allowedModelIds) : null,
      input.userId,
    ],
  );
  await writeAudit({
    userId: input.userId,
    actor: input.userId,
    action: 'credential_created',
    resource: id,
    result: validation.ok ? 'success' : 'failure',
    metadata: { providerId: input.providerId, modelsDiscovered: validation.modelsDiscovered },
  });
  const row = await getCredential(input.userId, id);
  return {
    record: row ? toRecord(row) : toRecord({
      id,
      user_id: input.userId,
      provider_id: input.providerId,
      name: input.name,
      type: 'BYOK',
      status,
      secret_encrypted: '',
      secret_masked: maskSecret(input.secret),
      environment: input.environment || 'production',
      scope: null,
      allowed_model_ids_json: input.allowedModelIds,
      created_by: input.userId,
      last_validated_at: validation.ok ? new Date() : null,
      last_used_at: null,
      expires_at: null,
      created_at: new Date(),
    }),
    validation: {
      ok: validation.ok,
      message: validation.message,
      modelsDiscovered: validation.modelsDiscovered,
    },
  };
}

export async function validateStoredCredential(userId: string, id: string) {
  const row = await getCredential(userId, id);
  if (!row) return null;
  const adapter = getAdapter(row.provider_id);
  if (!adapter) return { ok: false, message: 'Unknown provider', modelsDiscovered: 0 };
  const secret = decryptSecret(row.secret_encrypted);
  const validation = await adapter.validateCredentials(secret);
  const status: CredentialState = validation.ok ? 'VALID' : validation.code === 'authentication_failed' ? 'INVALID' : 'ERROR';
  await query(
    'UPDATE ai_provider_credentials SET status = ?, last_validated_at = NOW() WHERE id = ? AND user_id = ?',
    [status, id, userId],
  );
  await writeAudit({
    userId,
    actor: userId,
    action: 'credential_validated',
    resource: id,
    result: validation.ok ? 'success' : 'failure',
    metadata: { providerId: row.provider_id },
  });
  return { ok: validation.ok, message: validation.message, modelsDiscovered: validation.modelsDiscovered, status };
}

export async function updateCredential(
  userId: string,
  id: string,
  patch: { name?: string; allowedModelIds?: string[] | null; environment?: CredentialRecord['environment']; secret?: string },
): Promise<CredentialRecord | null> {
  const row = await getCredential(userId, id);
  if (!row) return null;
  const name = patch.name?.trim() || row.name;
  const environment = patch.environment || row.environment;
  const allowed = patch.allowedModelIds === undefined ? row.allowed_model_ids_json : JSON.stringify(patch.allowedModelIds);
  if (patch.secret?.trim()) {
    await query(
      'UPDATE ai_provider_credentials SET name = ?, environment = ?, allowed_model_ids_json = ?, secret_encrypted = ?, secret_masked = ?, status = ? WHERE id = ? AND user_id = ?',
      [name, environment, allowed, encryptSecret(patch.secret.trim()), maskSecret(patch.secret.trim()), 'PENDING', id, userId],
    );
  } else {
    await query(
      'UPDATE ai_provider_credentials SET name = ?, environment = ?, allowed_model_ids_json = ? WHERE id = ? AND user_id = ?',
      [name, environment, allowed, id, userId],
    );
  }
  await writeAudit({ userId, actor: userId, action: 'credential_updated', resource: id, result: 'success' });
  const next = await getCredential(userId, id);
  return next ? toRecord(next) : null;
}

export async function revokeCredential(userId: string, id: string): Promise<boolean> {
  const row = await getCredential(userId, id);
  if (!row) return false;
  await query('UPDATE ai_provider_credentials SET status = ? WHERE id = ? AND user_id = ?', ['REVOKED', id, userId]);
  await writeAudit({ userId, actor: userId, action: 'credential_revoked', resource: id, result: 'success' });
  return true;
}

export async function deleteCredential(userId: string, id: string): Promise<boolean> {
  const row = await getCredential(userId, id);
  if (!row) return false;
  await query('DELETE FROM ai_provider_credentials WHERE id = ? AND user_id = ?', [id, userId]);
  await writeAudit({ userId, actor: userId, action: 'credential_deleted', resource: id, result: 'success' });
  return true;
}

export function platformSecretFor(providerId: ProviderId): string {
  const definition = getProviderDefinition(providerId);
  return definition ? firstEnv(definition.envKeyNames) : '';
}

export async function resolveCredential(input: {
  userId: string;
  providerId: ProviderId;
  accessMode: AccessMode;
  ephemeralSecret?: string;
  modelId?: string;
}): Promise<ResolvedCredential | { error: string; code: 'POLICY_DENIED' | 'AUTHENTICATION_ERROR' }> {
  if (input.ephemeralSecret?.trim()) {
    return {
      source: 'ephemeral',
      credentialId: null,
      providerId: input.providerId,
      secret: input.ephemeralSecret.trim(),
      masked: maskSecret(input.ephemeralSecret),
    };
  }

  if (input.accessMode !== 'platform') {
    const rows = await query<CredentialRow[]>(
      `SELECT * FROM ai_provider_credentials
       WHERE user_id = ? AND provider_id = ? AND type IN ('BYOK', 'ENTERPRISE') AND status IN ('VALID', 'PENDING')
       ORDER BY last_used_at DESC, created_at DESC`,
      [input.userId, input.providerId],
    );
    for (const row of rows) {
      const allowed = parseIds(row.allowed_model_ids_json);
      if (allowed && input.modelId && !allowed.includes(input.modelId)) continue;
      try {
        const secret = decryptSecret(row.secret_encrypted);
        await query('UPDATE ai_provider_credentials SET last_used_at = NOW() WHERE id = ?', [row.id]);
        return {
          source: 'byok',
          credentialId: row.id,
          providerId: input.providerId,
          secret,
          masked: row.secret_masked,
        };
      } catch {
        continue;
      }
    }
    if (input.accessMode === 'byok') {
      return { error: 'No valid BYOK credential is available for this provider', code: 'POLICY_DENIED' };
    }
  }

  const secret = platformSecretFor(input.providerId);
  if (secret) {
    return {
      source: 'platform',
      credentialId: null,
      providerId: input.providerId,
      secret,
      masked: maskSecret(secret),
    };
  }
  if (input.accessMode === 'platform') {
    return { error: 'Platform credentials are not configured for this provider', code: 'POLICY_DENIED' };
  }

  return { error: 'No credential is available for this provider', code: 'POLICY_DENIED' };
}
