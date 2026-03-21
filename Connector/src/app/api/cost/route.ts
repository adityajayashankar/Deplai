import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface CostEstimateBody {
  architecture_json: Record<string, unknown>;
  provider?: string;
  // AWS credentials — only needed for live AWS Pricing API queries
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  // Optionally scope to a project (ownership check)
  project_id?: string;
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

    if (!body.architecture_json || typeof body.architecture_json !== 'object') {
      return NextResponse.json({ error: 'architecture_json is required' }, { status: 400 });
    }

    // Optional project ownership check
    if (body.project_id) {
      const owned = await verifyProjectOwnership(user.id, String(body.project_id));
      if ('error' in owned) return owned.error;
    }

    const provider = String(body.provider || 'aws').trim().toLowerCase();

    const agenticRes = await fetch(`${AGENTIC_URL}/api/cost/estimate`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        architecture_json: body.architecture_json,
        provider,
        aws_access_key_id: body.aws_access_key_id || null,
        aws_secret_access_key: body.aws_secret_access_key || null,
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
    const msg = err instanceof Error ? err.message : 'Cost estimation error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
