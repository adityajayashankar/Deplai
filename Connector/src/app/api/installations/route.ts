import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

interface InstallationRow {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  installed_at: string | null;
  created_at: string;
}

export async function GET() {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const installations = await query<InstallationRow[]>(
      `SELECT
        id,
        installation_id,
        account_login,
        account_type,
        installed_at,
        created_at
       FROM github_installations
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [user.id]
    );

    return NextResponse.json({ installations });
  } catch (error) {
    console.error('Error fetching installations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch installations' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as { installation_id?: string };
    const installationId = String(body.installation_id || '').trim();

    if (installationId) {
      const rows = await query<Array<{ id: string }>>(
        `SELECT id
         FROM github_installations
         WHERE id = ? AND user_id = ?
         LIMIT 1`,
        [installationId, user.id],
      );
      if (!rows[0]) {
        return NextResponse.json({ error: 'Installation not found or access denied' }, { status: 404 });
      }

      await query('DELETE FROM github_repositories WHERE installation_id = ?', [installationId]);
      await query('DELETE FROM github_installations WHERE id = ? AND user_id = ?', [installationId, user.id]);

      return NextResponse.json({ success: true, disconnected: 1 });
    }

    const userInstalls = await query<Array<{ id: string }>>(
      `SELECT id FROM github_installations WHERE user_id = ?`,
      [user.id],
    );

    for (const install of userInstalls) {
      await query('DELETE FROM github_repositories WHERE installation_id = ?', [install.id]);
    }
    await query('DELETE FROM github_installations WHERE user_id = ?', [user.id]);

    return NextResponse.json({ success: true, disconnected: userInstalls.length });
  } catch (error) {
    console.error('Error disconnecting installations:', error);
    return NextResponse.json(
      { error: 'Failed to disconnect GitHub installations' },
      { status: 500 }
    );
  }
}
