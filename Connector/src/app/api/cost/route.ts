import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { validateArchitectureJson } from '@/lib/architecture-contract';

interface CostEstimateBody {
  architecture_json: Record<string, unknown>;
  provider?: string;
  // AWS credentials — only needed for live AWS Pricing API queries
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  // Optionally scope to a project (ownership check)
  project_id?: string;
}

function classifyAgenticRouteError(err: unknown, action: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : String(err || 'unknown upstream error');
  const lowered = raw.toLowerCase();
  if (
    lowered.includes('fetch failed') ||
    lowered.includes('econnrefused') ||
    lowered.includes('enotfound') ||
    lowered.includes('network')
  ) {
    return {
      message: `Agentic Layer is unavailable while trying to ${action}. Start the service at ${AGENTIC_URL} and retry.`,
      status: 502,
    };
  }
  return {
    message: raw || `${action} failed.`,
    status: 500,
  };
}

/**
 * POST /api/cost
 * Estimate monthly cloud costs from an architecture JSON.
 * Proxies to Agentic Layer POST /api/cost/estimate.
 *
 * AWS uses live boto3 Pricing API (requires credentials).
 * Azure uses live Azure Retail Prices API (no credentials needed).
 * GCP uses rule-based approximations (no credentials needed).
 */
export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as CostEstimateBody;

    const archValidation = validateArchitectureJson(body.architecture_json);
    if (!archValidation.valid) {
      return NextResponse.json(
        {
          error: `architecture_json contract validation failed: ${archValidation.errors.join('; ')}`,
        },
        { status: 400 },
      );
    }

    // Optional project ownership check
    if (body.project_id) {
      const owned = await verifyProjectOwnership(user.id, String(body.project_id));
      if ('error' in owned) return owned.error;
    }

    const provider = String(body.provider || 'aws').trim().toLowerCase();
    if (!['aws', 'azure', 'gcp'].includes(provider)) {
      return NextResponse.json({ error: 'provider must be one of aws, azure, gcp' }, { status: 400 });
    }

    const awsAccessKey = body.aws_access_key_id?.trim();
    const awsSecretKey = body.aws_secret_access_key?.trim();
    if ((awsAccessKey && !awsSecretKey) || (!awsAccessKey && awsSecretKey)) {
      return NextResponse.json(
        { error: 'aws_access_key_id and aws_secret_access_key must be provided together' },
        { status: 400 },
      );
    }

    const agenticRes = await fetch(`${AGENTIC_URL}/api/cost/estimate`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        architecture_json: archValidation.normalized,
        provider,
        aws_access_key_id: awsAccessKey || null,
        aws_secret_access_key: awsSecretKey || null,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const data = await agenticRes.json();

    if (!agenticRes.ok || !data.success) {
      return NextResponse.json(
        { error: data.error || 'Cost estimation failed' },
        { status: agenticRes.ok ? 500 : agenticRes.status },
      );
    }

    return NextResponse.json({
      success: true,
      provider: data.provider || provider,
      total_monthly_usd: data.total_monthly_usd,
      currency: data.currency || 'USD',
      breakdown: data.breakdown || [],
      note: data.note || null,
      errors: data.errors || [],
    });
  } catch (err) {
    const classified = classifyAgenticRouteError(err, 'estimate infrastructure cost');
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}
