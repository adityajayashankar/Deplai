import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface DestroyBody {
  project_id?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_region?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json().catch(() => ({})) as DestroyBody;
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }
    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const awsAccessKeyId = String(body.aws_access_key_id || '').trim();
    const awsSecretAccessKey = String(body.aws_secret_access_key || '').trim();
    const awsRegion = String(body.aws_region || 'eu-north-1').trim() || 'eu-north-1';
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      return NextResponse.json({ error: 'AWS credentials are required.' }, { status: 400 });
    }

    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;

    const res = await fetch(`${AGENTIC_URL}/api/aws/destroy-runtime`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_name: projectName,
        aws_access_key_id: awsAccessKeyId,
        aws_secret_access_key: awsSecretAccessKey,
        aws_region: awsRegion,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    const data = await res.json().catch(() => ({})) as { success?: boolean; details?: unknown; error?: string };
    if (!res.ok || data.success !== true) {
      return NextResponse.json(
        { error: data.error || 'Destroy runtime request failed.' },
        { status: res.ok ? 500 : res.status },
      );
    }

    return NextResponse.json({ success: true, details: data.details || null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Destroy route failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

