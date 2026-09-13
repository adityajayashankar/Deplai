import { query } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

import { requireServiceKey } from '@/lib/auth';
import {
  InsufficientOrganizationCreditsError,
} from '@/lib/billing/organization-credits';
import {
  settleProductUsage,
  type ProductUsageKind,
  type ProductUsageOutcome,
  type ProductUsageTokens,
} from '@/lib/billing/product-usage';
import { unitsToCredits } from '@/lib/billing/credit-catalog';

const usageKinds = new Set<ProductUsageKind>([
  'security_scan',
  'dast',
  'remediation',
  'deployment',
  'uiux',
]);

function isUsageKind(value: unknown): value is ProductUsageKind {
  return typeof value === 'string' && usageKinds.has(value as ProductUsageKind);
}

function isOutcome(value: unknown): value is ProductUsageOutcome {
  return value === 'succeeded' || value === 'failed';
}

export async function POST(request: NextRequest) {
  const denied = requireServiceKey(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as {
    kind?: unknown;
    outcome?: unknown;
    organization_id?: unknown;
    user_id?: unknown;
    project_id?: unknown;
    run_id?: unknown;
    dast_only?: unknown;
    usage?: ProductUsageTokens | null;
  };
  if (!isUsageKind(body.kind) || !isOutcome(body.outcome)) {
    return NextResponse.json({ error: 'A supported product usage kind and outcome are required.' }, { status: 400 });
  }

  const organizationId = String(body.organization_id || '').trim();
  const runId = String(body.run_id || '').trim();
  if (!organizationId || !runId) {
    return NextResponse.json({ error: 'organization_id and run_id are required.' }, { status: 400 });
  }

  try {
    const result = await settleProductUsage({
      kind: body.kind,
      outcome: body.outcome,
      organizationId,
      userId: String(body.user_id || '').trim() || null,
      projectId: String(body.project_id || '').trim() || null,
      runId,
      dastOnly: body.dast_only === true,
      usage: body.usage || null,
    });
    if (body.kind === 'remediation') {
      // Server-owned completion persists even if the browser has disconnected.
      await query(`UPDATE workspace_sessions SET status = ?, completed_at = NOW(),
        metadata_json = JSON_SET(COALESCE(metadata_json, JSON_OBJECT()), '$.settlement_recorded', true)
        WHERE external_id = ? AND user_id = ? AND organization_id = ? AND service = 'security_agent'`,
      [body.outcome === 'succeeded' ? 'completed' : 'failed', runId, String(body.user_id || ''), organizationId]);
    }
    return NextResponse.json({
      kind: body.kind,
      outcome: body.outcome,
      credits: result.credits,
      debited: result.debited,
      available: result.available,
      duplicate: result.duplicate,
      reason: result.reason,
    });
  } catch (error) {
    if (error instanceof InsufficientOrganizationCreditsError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        available_credits: unitsToCredits(error.availableUnits),
        required_credits: unitsToCredits(error.requiredUnits),
        top_up_path: error.topUpPath,
      }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Could not settle product usage.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
