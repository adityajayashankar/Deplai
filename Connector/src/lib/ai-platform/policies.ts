import { query } from '@/lib/db';
import { ensureAiPlatformSchema } from './schema';
import { DEFAULT_ORGANIZATION_POLICY, type OrganizationPolicy } from './types';

export async function getOrganizationPolicy(userId: string): Promise<OrganizationPolicy> {
  await ensureAiPlatformSchema();
  try {
    const rows = await query<Array<{ policy_json: unknown }>>(
      'SELECT policy_json FROM ai_organization_policies WHERE user_id = ? LIMIT 1',
      [userId],
    );
    if (rows[0]) {
      const stored = typeof rows[0].policy_json === 'string'
        ? JSON.parse(rows[0].policy_json)
        : rows[0].policy_json;
      return { ...DEFAULT_ORGANIZATION_POLICY, ...stored, userId };
    }
  } catch {
    /* tests / missing table */
  }
  return { ...DEFAULT_ORGANIZATION_POLICY, userId };
}

export async function saveOrganizationPolicy(userId: string, policy: Partial<OrganizationPolicy>): Promise<OrganizationPolicy> {
  await ensureAiPlatformSchema();
  const current = await getOrganizationPolicy(userId);
  const next: OrganizationPolicy = { ...current, ...policy, userId };
  await query(
    `INSERT INTO ai_organization_policies (user_id, policy_json)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE policy_json = VALUES(policy_json)`,
    [userId, JSON.stringify(next)],
  );
  return next;
}
