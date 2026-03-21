import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { githubService } from '@/lib/github';

function isConnectivityError(error: unknown): boolean {
  const err = error as { code?: string };
  return (
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ENOTFOUND' ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'EHOSTUNREACH' ||
    err?.code === 'PROTOCOL_CONNECTION_LOST'
  );
}

export async function POST() {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const { removed, added } = await githubService.syncInstallations(user.id);

    return NextResponse.json({ success: true, removed, added });
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    console.error('Sync error:', error);
    if (isConnectivityError(error)) {
      return NextResponse.json(
        { error: 'Database unavailable. Verify DB_HOST/DB_PORT and that MySQL is running.' },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: err.message || 'Sync failed' },
      { status: 500 }
    );
  }
}
