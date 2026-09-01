import { query } from '@/lib/db';

export async function listApiKeys(input: { search?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const search = input.search?.trim().toLowerCase() || '';
  const params: unknown[] = [];
  let where = '1=1';
  if (search) {
    where += ' AND (LOWER(u.email) LIKE ? OR t.token_prefix LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern);
  }

  const rows = await query<Array<{
    user_id: string;
    email: string;
    token_prefix: string;
    token_last4: string;
    last_used_at: Date | string | null;
    created_at: Date | string;
  }>>(
    `SELECT t.user_id, u.email, t.token_prefix, t.token_last4, t.last_used_at, t.created_at
     FROM user_api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE ${where}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    masked: `${row.token_prefix}••••${row.token_last4}`,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function revokeApiKey(userId: string): Promise<void> {
  await query(`DELETE FROM user_api_tokens WHERE user_id = ?`, [userId]);
}

export async function listProviderKeys(input: { search?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const search = input.search?.trim().toLowerCase() || '';
  const params: unknown[] = [];
  let where = '1=1';
  if (search) {
    where += ' AND (LOWER(u.email) LIKE ? OR c.provider_id LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern);
  }

  const rows = await query<Array<{
    id: string;
    user_email: string;
    provider_id: string;
    name: string;
    status: string;
    secret_masked: string;
    created_at: Date | string;
    last_used_at: Date | string | null;
  }>>(
    `SELECT c.id, u.email AS user_email, c.provider_id, c.name, c.status, c.secret_masked, c.created_at, c.last_used_at
     FROM ai_provider_credentials c
     JOIN users u ON u.id = c.user_id
     WHERE ${where}
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return rows.map((row) => ({
    id: row.id,
    email: row.user_email,
    provider: row.provider_id,
    label: row.name,
    status: row.status,
    masked: row.secret_masked,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }));
}
