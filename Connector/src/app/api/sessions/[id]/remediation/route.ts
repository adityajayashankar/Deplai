import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getOwnedSession } from '@/lib/sessions/store';
import { requireOrganizationPermission } from '@/lib/organizations/store';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { query } from '@/lib/db';
import { unitsToCredits } from '@/lib/billing/credit-catalog';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const session = await getOwnedSession(id, auth.user.id);
  if (!session || session.service !== 'security_agent') return NextResponse.json({error:'Session not found'}, {status:404});
  const runId = String(session.metadata.remediation_run_id || '');
  const organizationId = String(session.metadata.organization_id || '');
  if (!runId || !organizationId || !session.project_id) return NextResponse.json({error:'This older session has no linked remediation archive.'}, {status:404});
  try {
    await requireOrganizationPermission({userId:auth.user.id, organizationId, action:'project.read', resource:{scopeType:'PROJECT',scopeId:session.project_id,projectId:session.project_id}});
  } catch { return NextResponse.json({error:'Session not available'}, {status:403}); }
  const params = new URLSearchParams({project_id:session.project_id,user_id:auth.user.id,organization_id:organizationId});
  try {
    const response = await fetch(`${AGENTIC_URL}/api/remediate/archive/${encodeURIComponent(runId)}?${params}`, {headers:agenticHeaders(),cache:'no-store',signal:AbortSignal.timeout(30000)});
    if (!response.ok) return NextResponse.json({error:response.status===404?'Archive unavailable or expired.':'Archive storage is temporarily unavailable.'},{status:response.status===404?404:503});
    const archive = await response.json();
    const rows = await query<Array<{amount_units:string;type:string}>>('SELECT amount_units, type FROM organization_credit_transactions WHERE organization_id = ? AND idempotency_key = ? AND actor_user_id = ?', [organizationId, `product-usage:remediation:${organizationId}:${runId}`, auth.user.id]);
    archive.billing = rows.length ? {status:'settled',credits_debited:Math.max(0,-unitsToCredits(BigInt(rows[0].amount_units))),mode:rows[0].type,label:'Remediation settlement'} : {status:'not_recorded',credits_debited:null,label:'Remediation settlement'};
    const headers: Record<string,string> = {'Cache-Control':'private, no-store'};
    if (request.nextUrl.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="remediation-${id.replace(/[^a-zA-Z0-9_-]/g,'')}.json"`;
    return NextResponse.json(archive,{headers});
  } catch { return NextResponse.json({error:'Could not load the run archive. Please retry.'},{status:503}); }
}
