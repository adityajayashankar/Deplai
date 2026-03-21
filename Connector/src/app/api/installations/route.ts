import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

export async function GET() {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const installations = await query<any[]>(
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