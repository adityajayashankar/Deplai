import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface RuntimeDetailsBody {
  project_id?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_region?: string;
  instance_id?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as RuntimeDetailsBody;
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const awsAccessKeyId = String(body.aws_access_key_id || '').trim();
    const awsSecretAccessKey = String(body.aws_secret_access_key || '').trim();
    const awsRegion = String(body.aws_region || 'eu-north-1').trim();
    const instanceId = String(body.instance_id || '').trim();

    if (!awsAccessKeyId || !awsSecretAccessKey) {
      return NextResponse.json(
        { error: 'AWS credentials are required to fetch runtime details.' },
        { status: 400 },
      );
    }

    const agenticRes = await fetch(`${AGENTIC_URL}/api/aws/runtime-details`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_name: projectId,
        aws_access_key_id: awsAccessKeyId,
        aws_secret_access_key: awsSecretAccessKey,
        aws_region: awsRegion,
        instance_id: instanceId || undefined,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const data = await agenticRes.json().catch(() => ({})) as {
      success?: boolean;
      details?: Record<string, unknown>;
      error?: string;
    };

    if (!agenticRes.ok || data.success !== true) {
      return NextResponse.json(
        { error: String(data.error || 'Failed to fetch runtime AWS details.') },
        { status: agenticRes.ok ? 500 : agenticRes.status },
      );
    }

    return NextResponse.json({
      success: true,
      details: data.details || null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Runtime details route failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
