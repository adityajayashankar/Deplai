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

function fallbackRuntimeDetails(region: string, error?: string) {
  return {
    region,
    account_id: null,
    lookup_status: 'unavailable',
    lookup_error: error || null,
    instance: {
      instance_id: 'n/a',
      public_ipv4_address: 'n/a',
      private_ipv4_address: 'n/a',
      instance_state: 'n/a',
      instance_type: 'n/a',
      public_dns: 'n/a',
      private_dns: 'n/a',
      vpc_id: 'n/a',
      subnet_id: 'n/a',
      instance_arn: 'n/a',
      launch_time: null,
    },
    resource_counts: {
      ec2_instances_total: 0,
      ec2_instances_running: 0,
      s3_buckets: 0,
      cloudfront_distributions: 0,
    },
  };
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

    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).trim();

    let agenticRes: Response;
    try {
      agenticRes = await fetch(`${AGENTIC_URL}/api/aws/runtime-details`, {
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
          instance_id: instanceId || undefined,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Runtime details request timed out.';
      return NextResponse.json({
        success: true,
        details: fallbackRuntimeDetails(awsRegion, msg),
        warning: msg,
      });
    }

    const data = await agenticRes.json().catch(() => ({})) as {
      success?: boolean;
      details?: Record<string, unknown>;
      error?: string;
    };

    if (!agenticRes.ok || data.success !== true) {
      const reason = String(data.error || `Agentic runtime-details failed with status ${agenticRes.status}`);
      return NextResponse.json({
        success: true,
        details: fallbackRuntimeDetails(awsRegion, reason),
        warning: reason,
      });
    }

    return NextResponse.json({
      success: true,
      details: data.details || fallbackRuntimeDetails(awsRegion, 'Runtime details payload was empty.'),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Runtime details route failed';
    return NextResponse.json({
      success: true,
      details: fallbackRuntimeDetails('eu-north-1', msg),
      warning: msg,
    });
  }
}
