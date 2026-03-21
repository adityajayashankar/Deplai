import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: repoId } = await context.params;
    const { user, error } = await requireAuth();
    if (error) return error;

    // Verify the repo belongs to this user via the installations join
    const rows = await query<any[]>(
      `SELECT r.id, r.full_name
       FROM github_repositories r
       JOIN github_installations i ON i.id = r.installation_id
       WHERE r.id = ? AND i.user_id = ?`,
      [repoId, user.id]
    );

    if (!rows || rows.length === 0) {
      return NextResponse.json(
        { error: 'Repository not found or access denied' },
        { status: 404 }
      );
    }

    const repo = rows[0];
    // Soft-delete: mark as hidden so the background GitHub sync doesn't re-add it
    await query('UPDATE github_repositories SET user_hidden = true WHERE id = ?', [repoId]);

    return NextResponse.json({
      success: true,
      message: `Repository "${repo.full_name}" removed from DeplAI`,
    });
  } catch (err: any) {
    console.error('Error removing repository:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to remove repository' },
      { status: 500 }
    );
  }
}
