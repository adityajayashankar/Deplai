import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

function isBackendConnectivityError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    || (error as { cause?: { code?: string } })?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT';
}

function isBackendTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return (error instanceof Error && error.name === 'TimeoutError') || message.includes('aborted due to timeout') || message.includes('timed out');
}

export async function GET(request: NextRequest) {
  try {
    const { error, user } = await requireAuth();
    if (error) return error;

    const projectId = request.nextUrl.searchParams.get('project_id');
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const { error: ownershipError } = await verifyProjectOwnership(user!.id, projectId);
    if (ownershipError) {
      if (ownershipError.status === 404) {
        return NextResponse.json({
          status: 'not_initiated',
          detail: 'Project not found in Connector ownership context',
        });
      }
      return ownershipError;
    }

    const response = await fetch(`${AGENTIC_URL}/api/scan/status/${projectId}`, {
      headers: agenticHeaders(),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { detail?: string; error?: string } | null;
      console.warn(`Scan status backend returned ${response.status} for ${projectId}`);
      return NextResponse.json({
        status: 'error',
        backend: 'agentic',
        backend_status: response.status,
        detail: detail?.detail || detail?.error || 'Scan status backend request failed',
      });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: unknown) {
    if (isBackendTimeoutError(error)) {
      return NextResponse.json({
        status: 'error',
        backend: 'agentic',
        detail: `Agentic Layer timed out at ${AGENTIC_URL}. The backend is likely paused or hung.`,
      }, { status: 504 });
    }
    if (isBackendConnectivityError(error)) {
      return NextResponse.json({
        status: 'error',
        backend: 'agentic',
        detail: `Agentic Layer is unreachable at ${AGENTIC_URL}`,
      }, { status: 502 });
    }
    console.error('Scan status error:', error);
    return NextResponse.json({ status: 'error', detail: 'Unexpected scan status error' }, { status: 500 });
  }
}
