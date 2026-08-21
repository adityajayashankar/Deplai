import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

type AwsCreds = {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
};

type SecretsBody = AwsCreds & {
  project_id?: string;
  action?: 'list' | 'upsert' | 'delete';
  secrets_manager_prefix?: string;
  environment?: string;
  secrets?: Array<{ key?: string; value?: string }>;
  key?: string;
};

function normalizeKey(key: string): string {
  return String(key || '').trim();
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = (await req.json()) as SecretsBody;
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
    const action = String(body.action || 'list').trim().toLowerCase() as 'list' | 'upsert' | 'delete';
    const environment = String(body.environment || 'prod').trim() || 'prod';
    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).trim();
    const prefix = String(body.secrets_manager_prefix || '').trim();

    if (!awsAccessKeyId || !awsSecretAccessKey) {
      return NextResponse.json(
        { error: 'AWS credentials are required to manage app secrets.' },
        { status: 400 },
      );
    }

    if (!['list', 'upsert', 'delete'].includes(action)) {
      return NextResponse.json({ error: 'action must be list, upsert, or delete' }, { status: 400 });
    }

    let agenticPath = '/api/aws/app-secrets/list';
    let payload: Record<string, unknown> = {
      project_name: projectName,
      aws_access_key_id: awsAccessKeyId,
      aws_secret_access_key: awsSecretAccessKey,
      aws_session_token: awsSessionToken || undefined,
      aws_region: awsRegion,
      secrets_manager_prefix: prefix,
      environment,
    };

    if (action === 'upsert') {
      agenticPath = '/api/aws/app-secrets/upsert';
      const secrets = (Array.isArray(body.secrets) ? body.secrets : [])
        .map((item) => ({
          key: normalizeKey(String(item?.key || '')),
          value: String(item?.value || ''),
        }))
        .filter((item) => item.key && item.value);
      if (secrets.length === 0) {
        return NextResponse.json({ error: 'secrets must include at least one key/value pair' }, { status: 400 });
      }
      payload = { ...payload, secrets };
    } else if (action === 'delete') {
      agenticPath = '/api/aws/app-secrets/delete';
      const key = normalizeKey(String(body.key || ''));
      if (!key) {
        return NextResponse.json({ error: 'key is required for delete' }, { status: 400 });
      }
      payload = { ...payload, key };
    }

    let agenticRes: Response;
    try {
      agenticRes = await fetch(`${AGENTIC_URL}${agenticPath}`, {
        method: 'POST',
        headers: {
          ...agenticHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'App secrets request timed out.';
      return NextResponse.json({ success: false, error: msg }, { status: 502 });
    }

    const data = (await agenticRes.json().catch(() => ({}))) as {
      success?: boolean;
      prefix?: string;
      secrets?: Array<Record<string, unknown>>;
      error?: string;
    };

    if (!agenticRes.ok || data.success === false) {
      return NextResponse.json(
        { success: false, error: data.error || `App secrets ${action} failed` },
        { status: agenticRes.status >= 400 ? agenticRes.status : 502 },
      );
    }

    // Never echo secret values — agentic list/upsert already returns metadata only.
    const secrets = (Array.isArray(data.secrets) ? data.secrets : []).map((item) => ({
      key: String(item.key || ''),
      name: item.name ? String(item.name) : undefined,
      arn: item.arn ? String(item.arn) : undefined,
      updated_at: item.updated_at ? String(item.updated_at) : undefined,
      is_set: item.is_set !== false,
      deleted: Boolean(item.deleted),
    }));

    return NextResponse.json({
      success: true,
      prefix: data.prefix || prefix,
      secrets,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to manage app secrets';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
