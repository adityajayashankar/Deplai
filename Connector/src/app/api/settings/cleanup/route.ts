import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

type CleanupRequestBody = {
  confirmation?: string;
};

export async function POST(request: NextRequest) {
  const { error } = await requireAuth();
  if (error) return error;

  const body = await request.json().catch(() => ({})) as CleanupRequestBody;
  const confirmation = String(body.confirmation || '').trim().toUpperCase();

  if (confirmation !== 'DESTROY ALL') {
    return NextResponse.json(
      { error: 'Confirmation phrase must be DESTROY ALL.' },
      { status: 400 }
    );
  }

  try {
    const cleanupResponse = await fetch(`${AGENTIC_URL}/api/cleanup`, {
      method: 'POST',
      headers: agenticHeaders({ 'Content-Type': 'application/json' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({}),
    });

    const payload = await cleanupResponse.json().catch(() => ({})) as {
      detail?: string;
      message?: string;
      success?: boolean;
    };

    if (!cleanupResponse.ok) {
      return NextResponse.json(
        {
          error: payload.detail || payload.message || `Cleanup failed with status ${cleanupResponse.status}`,
        },
        { status: cleanupResponse.status }
      );
    }

    return NextResponse.json({
      success: true,
      message: payload.message || 'Cleanup completed successfully.',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Cleanup endpoint is unreachable';
    return NextResponse.json(
      { error: message },
      { status: 502 }
    );
  }
}
