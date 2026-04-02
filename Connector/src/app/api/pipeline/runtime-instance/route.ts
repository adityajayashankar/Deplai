import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface RuntimeInstanceBody {
  project_id?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_region?: string;
  instance_id?: string;
  action?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = (await req.json().catch(() => ({}))) as RuntimeInstanceBody;
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const awsAccessKeyId = String(body.aws_access_key_id || '').trim();
    const awsSecretAccessKey = String(body.aws_secret_access_key || '').trim();
    const awsRegion = String(body.aws_region || 'eu-north-1').trim() || 'eu-north-1';
    const instanceId = String(body.instance_id || '').trim();
    const action = String(body.action || '').trim().toLowerCase();

    if (!awsAccessKeyId || !awsSecretAccessKey) {
      return NextResponse.json({ error: 'AWS credentials are required.' }, { status: 400 });
    }
    if (!instanceId) {
      return NextResponse.json({ error: 'instance_id is required.' }, { status: 400 });
    }
    if (!['start', 'stop', 'reboot'].includes(action)) {
      return NextResponse.json({ error: 'action must be one of: start, stop, reboot' }, { status: 400 });
    }

    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;

    const res = await fetch(`${AGENTIC_URL}/api/aws/instance-action`, {
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
        instance_id: instanceId,
        action,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      details?: Record<string, unknown>;
      error?: string;
    };

    if (!res.ok || data.success !== true) {
      return NextResponse.json(
        { error: data.error || 'Runtime instance action failed.' },
        { status: res.ok ? 500 : res.status },
      );
    }

    return NextResponse.json({ success: true, details: data.details || null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Runtime instance route failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
