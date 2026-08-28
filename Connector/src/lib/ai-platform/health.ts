import { query } from '@/lib/db';
import { ensureAiPlatformSchema } from './schema';
import { getAdapter, listAdapters } from './providers/registry';
import { platformSecretFor } from './credentials';
import type { ProviderHealthSnapshot, ProviderId } from './types';

const cache = new Map<string, { at: number; snapshot: ProviderHealthSnapshot }>();
const TTL_MS = 30_000;

export async function recordProviderHealth(snapshot: ProviderHealthSnapshot): Promise<void> {
  cache.set(snapshot.providerId, { at: Date.now(), snapshot });
  try {
    await ensureAiPlatformSchema();
    await query(
      `INSERT INTO ai_provider_health (provider_id, status, availability, latency_ms, error_rate, rate_limit_rate, timeout_rate, detail, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         availability = VALUES(availability),
         latency_ms = VALUES(latency_ms),
         error_rate = VALUES(error_rate),
         rate_limit_rate = VALUES(rate_limit_rate),
         timeout_rate = VALUES(timeout_rate),
         detail = VALUES(detail),
         checked_at = VALUES(checked_at)`,
      [
        snapshot.providerId,
        snapshot.status,
        snapshot.availability,
        snapshot.latencyMs,
        snapshot.errorRate,
        snapshot.rateLimitRate,
        snapshot.timeoutRate,
        snapshot.detail,
        snapshot.checkedAt.replace('T', ' ').replace('Z', ''),
      ],
    );
  } catch {
    /* health persistence is best-effort */
  }
}

export async function getProviderHealthMap(): Promise<Map<string, ProviderHealthSnapshot>> {
  const map = new Map<string, ProviderHealthSnapshot>();
  try {
    await ensureAiPlatformSchema();
    const rows = await query<Array<{
      provider_id: string;
      status: ProviderHealthSnapshot['status'];
      availability: number;
      latency_ms: number | null;
      error_rate: number;
      rate_limit_rate: number;
      timeout_rate: number;
      detail: string | null;
      checked_at: Date | string;
    }>>('SELECT * FROM ai_provider_health');
    for (const row of rows) {
      map.set(row.provider_id, {
        providerId: row.provider_id as ProviderId,
        status: row.status,
        availability: Number(row.availability),
        latencyMs: row.latency_ms,
        errorRate: Number(row.error_rate),
        rateLimitRate: Number(row.rate_limit_rate),
        timeoutRate: Number(row.timeout_rate),
        checkedAt: row.checked_at instanceof Date ? row.checked_at.toISOString() : String(row.checked_at),
        detail: row.detail,
      });
    }
  } catch {
    /* ignore */
  }
  for (const [id, entry] of cache) {
    if (!map.has(id)) map.set(id, entry.snapshot);
  }
  return map;
}

export async function refreshProviderHealth(providerId?: ProviderId): Promise<ProviderHealthSnapshot[]> {
  const adapters = providerId
    ? [getAdapter(providerId)].filter((adapter): adapter is NonNullable<typeof adapter> => Boolean(adapter))
    : listAdapters();
  const snapshots: ProviderHealthSnapshot[] = [];
  for (const adapter of adapters) {
    const cached = cache.get(adapter.definition.id);
    if (cached && Date.now() - cached.at < TTL_MS) {
      snapshots.push(cached.snapshot);
      continue;
    }
    const secret = platformSecretFor(adapter.definition.id);
    if (!secret) {
      const snapshot: ProviderHealthSnapshot = {
        providerId: adapter.definition.id,
        status: 'Unknown',
        availability: 0,
        latencyMs: null,
        errorRate: 0,
        rateLimitRate: 0,
        timeoutRate: 0,
        checkedAt: new Date().toISOString(),
        detail: 'No platform credential configured',
      };
      await recordProviderHealth(snapshot);
      snapshots.push(snapshot);
      continue;
    }
    const snapshot = await adapter.healthCheck(secret);
    await recordProviderHealth(snapshot);
    snapshots.push(snapshot);
  }
  return snapshots;
}
