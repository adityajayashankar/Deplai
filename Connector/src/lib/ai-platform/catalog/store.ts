import { query } from '@/lib/db';
import type { CanonicalModel, ModelLifecycle, ProviderId } from '../types';
import { ensureAiPlatformSchema } from '../schema';
import { SEED_MODELS, isSelectableLifecycle, modelIdFor } from './seed';

type ModelRow = {
  id: string;
  provider_id: string;
  provider_model_id: string;
  display_name: string;
  family: string;
  version: string;
  aliases_json: unknown;
  status: string;
  lifecycle: ModelLifecycle;
  release_date: string | Date | null;
  deprecation_date: string | Date | null;
  retirement_date: string | Date | null;
  replacement_model_id: string | null;
  context_window: number;
  max_output_tokens: number;
  capabilities_json: unknown;
  latency_profile: CanonicalModel['latencyProfile'];
  pricing_json: unknown;
  region_support_json: unknown;
  compliance_tags_json: unknown;
  model_owner: string | null;
  metadata_json: unknown;
  discovered_at: string | Date | null;
  updated_at: string | Date | null;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function rowToModel(row: ModelRow): CanonicalModel {
  return {
    id: row.id,
    providerId: row.provider_id as ProviderId,
    providerModelId: row.provider_model_id,
    displayName: row.display_name,
    family: row.family,
    version: row.version,
    aliases: parseJson<string[]>(row.aliases_json, []),
    status: row.status as CanonicalModel['status'],
    lifecycle: row.lifecycle,
    releaseDate: toIso(row.release_date),
    deprecationDate: toIso(row.deprecation_date),
    retirementDate: toIso(row.retirement_date),
    replacementModelId: row.replacement_model_id,
    contextWindow: Number(row.context_window || 0),
    maxOutputTokens: Number(row.max_output_tokens || 0),
    capabilities: parseJson(row.capabilities_json, SEED_MODELS[0].capabilities),
    latencyProfile: row.latency_profile,
    pricing: parseJson(row.pricing_json, { inputPerMillionUsd: null, outputPerMillionUsd: null, currency: 'USD', source: 'unknown' as const }),
    regionSupport: parseJson(row.region_support_json, ['global']),
    complianceTags: parseJson(row.compliance_tags_json, []),
    modelOwner: row.model_owner,
    metadata: parseJson(row.metadata_json, {}),
    discoveredAt: toIso(row.discovered_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listModels(): Promise<CanonicalModel[]> {
  await ensureAiPlatformSchema();
  try {
    const rows = await query<ModelRow[]>('SELECT * FROM ai_models ORDER BY provider_id, display_name');
    if (rows.length) return rows.map(rowToModel);
  } catch {
    /* schema may not be available in tests */
  }
  return SEED_MODELS;
}

export async function getModel(id: string): Promise<CanonicalModel | null> {
  const models = await listModels();
  const needle = id.trim().toLowerCase();
  return models.find((model) => (
    model.id.toLowerCase() === needle
    || model.providerModelId.toLowerCase() === needle
    || model.aliases.some((alias) => alias.toLowerCase() === needle)
  )) || null;
}

export async function upsertDiscoveredModel(input: {
  providerId: ProviderId;
  providerModelId: string;
  displayName?: string;
  ownedBy?: string;
  contextWindow?: number;
}): Promise<void> {
  await ensureAiPlatformSchema();
  const id = modelIdFor(input.providerId, input.providerModelId);
  const existing = await query<Array<{ id: string; lifecycle: ModelLifecycle }>>(
    'SELECT id, lifecycle FROM ai_models WHERE id = ? OR (provider_id = ? AND provider_model_id = ?) LIMIT 1',
    [id, input.providerId, input.providerModelId],
  );
  if (existing[0]) {
    await query(
      `UPDATE ai_models
       SET status = 'active',
           lifecycle = CASE WHEN lifecycle IN ('RETIRED', 'UNAVAILABLE', 'DEPRECATED') THEN 'ACTIVE' ELSE lifecycle END,
           display_name = COALESCE(?, display_name),
           model_owner = COALESCE(?, model_owner),
           discovered_at = COALESCE(discovered_at, NOW())
       WHERE id = ?`,
      [input.displayName || null, input.ownedBy || null, existing[0].id],
    );
    return;
  }
  const seed = SEED_MODELS.find((model) => model.providerId === input.providerId) || SEED_MODELS[0];
  await query(
    `INSERT INTO ai_models (
      id, provider_id, provider_model_id, display_name, family, version, aliases_json, status, lifecycle,
      release_date, deprecation_date, retirement_date, replacement_model_id, context_window, max_output_tokens,
      capabilities_json, latency_profile, pricing_json, region_support_json, compliance_tags_json, model_owner, metadata_json, discovered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'DISCOVERED', NULL, NULL, NULL, NULL, ?, 8192, ?, 'balanced', ?, JSON_ARRAY('global'), JSON_ARRAY(), ?, JSON_OBJECT(), NOW())`,
    [
      id,
      input.providerId,
      input.providerModelId,
      input.displayName || input.providerModelId,
      input.providerId,
      'discovered',
      JSON.stringify([input.providerModelId]),
      input.contextWindow || 0,
      JSON.stringify({ ...seed.capabilities, scores: {} }),
      JSON.stringify({ inputPerMillionUsd: null, outputPerMillionUsd: null, currency: 'USD', source: 'unknown' }),
      input.ownedBy || input.providerId,
    ],
  );
}

export async function markMissingModels(providerId: ProviderId, seenIds: Set<string>): Promise<void> {
  await ensureAiPlatformSchema();
  const rows = await query<Array<{ id: string; provider_model_id: string; lifecycle: ModelLifecycle }>>(
    'SELECT id, provider_model_id, lifecycle FROM ai_models WHERE provider_id = ?',
    [providerId],
  );
  for (const row of rows) {
    if (seenIds.has(row.provider_model_id) || seenIds.has(row.id)) continue;
    if (row.lifecycle === 'RETIRED') continue;
    const next: ModelLifecycle = row.lifecycle === 'DEPRECATED' || row.lifecycle === 'SUNSET_PENDING'
      ? 'RETIRED'
      : 'DEPRECATED';
    await query('UPDATE ai_models SET lifecycle = ?, status = ? WHERE id = ?', [
      next,
      next === 'RETIRED' ? 'unavailable' : 'degraded',
      row.id,
    ]);
  }
}

export function selectableModels(models: CanonicalModel[]): CanonicalModel[] {
  return models.filter((model) => isSelectableLifecycle(model.lifecycle));
}
