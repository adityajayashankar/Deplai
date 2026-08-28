import { query } from '@/lib/db';
import { isFeatureEnabled } from '../config';
import { ensureAiPlatformSchema } from '../schema';
import { listAdapters, getAdapter } from '../providers/registry';
import { platformSecretFor, listCredentials } from '../credentials';
import { markMissingModels, upsertDiscoveredModel } from './store';
import { writeAudit } from '../audit';
import type { ProviderId } from '../types';

export async function syncProviderModels(input: {
  providerId: ProviderId;
  userId?: string;
  secret?: string;
}): Promise<{ providerId: ProviderId; discovered: number; error?: string }> {
  if (!isFeatureEnabled('ai_dynamic_models')) {
    return { providerId: input.providerId, discovered: 0, error: 'Model sync is disabled' };
  }
  const adapter = getAdapter(input.providerId);
  if (!adapter) return { providerId: input.providerId, discovered: 0, error: 'Unknown provider' };
  const secret = input.secret || platformSecretFor(input.providerId);
  if (!secret) return { providerId: input.providerId, discovered: 0, error: 'No credential available for discovery' };

  try {
    const models = await adapter.listModels(secret);
    const seen = new Set<string>();
    for (const model of models) {
      seen.add(model.providerModelId);
      await upsertDiscoveredModel({
        providerId: input.providerId,
        providerModelId: model.providerModelId,
        displayName: model.displayName,
        ownedBy: model.ownedBy,
        contextWindow: model.contextWindow,
      });
    }
    await markMissingModels(input.providerId, seen);
    if (input.userId) {
      await writeAudit({
        userId: input.userId,
        actor: input.userId,
        action: 'model_enabled',
        resource: input.providerId,
        result: 'success',
        metadata: { discovered: models.length },
      });
    }
    return { providerId: input.providerId, discovered: models.length };
  } catch (error) {
    return {
      providerId: input.providerId,
      discovered: 0,
      error: error instanceof Error ? error.message : 'Discovery failed',
    };
  }
}

export async function syncAllProviders(userId?: string): Promise<{
  providers: number;
  discovered: number;
  results: Array<{ providerId: ProviderId; discovered: number; error?: string }>;
}> {
  await ensureAiPlatformSchema();
  const lockRows = await query<Array<{ got: number }>>("SELECT GET_LOCK('deplai_ai_model_sync', 1) AS got");
  if (!lockRows[0]?.got) {
    return { providers: 0, discovered: 0, results: [] };
  }
  try {
    const results = [];
    for (const adapter of listAdapters()) {
      if (!adapter.definition.supportsModelDiscovery) continue;
      results.push(await syncProviderModels({ providerId: adapter.definition.id, userId }));
    }
    return {
      providers: results.length,
      discovered: results.reduce((sum, item) => sum + item.discovered, 0),
      results,
    };
  } finally {
    await query("SELECT RELEASE_LOCK('deplai_ai_model_sync')");
  }
}

export async function syncWithUserCredential(userId: string, providerId: ProviderId): Promise<{ discovered: number; error?: string }> {
  const creds = await listCredentials(userId, providerId);
  const valid = creds.find((item) => item.status === 'VALID') || creds[0];
  if (!valid) return syncProviderModels({ providerId, userId });
  const { getCredential } = await import('../credentials');
  const row = await getCredential(userId, valid.id);
  if (!row) return syncProviderModels({ providerId, userId });
  const { decryptSecret } = await import('../crypto');
  try {
    const secret = decryptSecret(row.secret_encrypted);
    return syncProviderModels({ providerId, userId, secret });
  } catch {
    return { discovered: 0, error: 'Could not unlock stored credential' };
  }
}
