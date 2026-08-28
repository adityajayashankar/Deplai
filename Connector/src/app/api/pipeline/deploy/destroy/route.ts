import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface DestroyBody {
  project_id?: string;
  run_id?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
}

async function destroyIacRun(params: {
  runId: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const res = await fetch(`${AGENTIC_URL}/api/iac/run/${encodeURIComponent(params.runId)}`, {
      method: 'DELETE',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        access_key_id: params.awsAccessKeyId,
        secret_access_key: params.awsSecretAccessKey,
        region: params.awsRegion,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const data = (await res.json().catch(() => ({}))) as { status?: string; detail?: string; error?: string };
    if (!res.ok) {
      return { ok: false, error: data.detail || data.error || `Terraform destroy failed (${res.status}).` };
    }
    return { ok: true, status: data.status || 'destroyed' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Terraform destroy failed.' };
  }
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
    const awsSessionToken = String(body.aws_session_token || '').trim();
    const awsRegion = String(body.aws_region || 'eu-north-1').trim() || 'eu-north-1';
    const runId = String(body.run_id || '').trim();
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      return NextResponse.json({ error: 'AWS credentials are required.' }, { status: 400 });
    }

    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;

    const iacDestroy = runId
      ? await destroyIacRun({
          runId,
          awsAccessKeyId,
          awsSecretAccessKey,
          awsRegion,
        })
      : null;

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
        aws_session_token: awsSessionToken || undefined,
        aws_region: awsRegion,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    const data = await res.json().catch(() => ({})) as { success?: boolean; details?: unknown; error?: string };
    const runtimeOk = res.ok && data.success === true;
    if (!runtimeOk && !iacDestroy?.ok) {
      return NextResponse.json(
        { error: iacDestroy?.error || data.error || 'Destroy runtime request failed.' },
        { status: res.ok ? 500 : res.status },
      );
    }

    const details = {
      ...((data.details && typeof data.details === 'object') ? data.details as Record<string, unknown> : {}),
      terraform_destroy: iacDestroy
        ? { attempted: true, ok: iacDestroy.ok, status: iacDestroy.status || null, error: iacDestroy.error || null, run_id: runId }
        : { attempted: false },
      runtime_destroy_ok: runtimeOk,
    };

    return NextResponse.json({ success: true, details });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Destroy route failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
