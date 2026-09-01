import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { classifyUpstreamError } from '@/features/deployment/apply-status';

function firstIacOutputString(outputs: unknown, keys: string[]): string | null {
  if (!outputs || typeof outputs !== 'object') return null;
  const rec = outputs as Record<string, unknown>;
  const bags: Record<string, unknown>[] = [rec];
  if (rec.raw && typeof rec.raw === 'object') {
    bags.push(rec.raw as Record<string, unknown>);
  }
  if (Array.isArray(rec.outputs)) {
    const flat: Record<string, unknown> = {};
    for (const item of rec.outputs) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { key?: unknown; value?: unknown };
      if (typeof row.key === 'string') flat[row.key] = row.value;
    }
    bags.push(flat);
  }
  for (const bag of bags) {
    for (const key of keys) {
      const value = bag[key];
      if (typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'n/a' && value.trim().toLowerCase() !== 'null') {
        return value.trim();
      }
    }
  }
  return null;
}

function classifyStatusError(err: unknown): string {
  return classifyUpstreamError(err).error || 'Failed to fetch deployment status.';
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json().catch(() => ({})) as { project_id?: string; project_name?: string; run_id?: string };
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId, 'deployment.read');
    if ('error' in owned) return owned.error;

    const projectName = String(body.project_name || owned.project?.name || projectId).trim();
    const runId = String(body.run_id || '').trim();
    if (runId) {
      const res = await fetch(`${AGENTIC_URL}/api/iac/status/${encodeURIComponent(runId)}`, {
        method: 'GET',
        headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json().catch(() => ({})) as {
        status?: string;
        outputs?: Record<string, unknown>;
        error?: string | null;
        service_type?: string;
        plan_summary?: string;
      };
      if (!res.ok) {
        return NextResponse.json(
          {
            success: false,
            status: 'idle',
            result: null,
            error: String(data.error || 'Failed to fetch IaC pipeline status.'),
          },
          { status: res.status },
        );
      }
      const rawStatus = String(data.status || 'pending');
      const terminalSuccess = rawStatus === 'completed' || rawStatus === 'destroyed';
      const terminalFailure = rawStatus === 'failed';
      const serviceType = String(data.service_type || '');
      const wantsEc2 = /^(ec2|ec2-instance)$/i.test(serviceType);
      const instanceId = firstIacOutputString(data.outputs, ['instance_id', 'ec2_instance_id']);
      const publicIp = firstIacOutputString(data.outputs, ['public_ip', 'ec2_public_ip']);
      const emptyEc2Success = terminalSuccess && wantsEc2 && !instanceId && !publicIp;
      const status = emptyEc2Success
        ? 'error'
        : terminalSuccess ? 'completed' : terminalFailure ? 'error' : rawStatus;
      return NextResponse.json({
        success: true,
        status,
        result: {
          success: terminalSuccess && !emptyEc2Success && !terminalFailure,
          mode: 'iac_pipeline',
          run_id: runId,
          service_type: data.service_type,
          status: emptyEc2Success ? 'failed' : rawStatus,
          plan_summary: data.plan_summary ? { summary: data.plan_summary } : null,
          outputs: data.outputs || {},
          raw_outputs: data.outputs || {},
          error: emptyEc2Success
            ? 'IaC pipeline completed but no EC2 instance was provisioned in AWS.'
            : (data.error || undefined),
        },
        logs: Array.isArray((data as { logs?: unknown }).logs) ? (data as { logs: string[] }).logs : [],
      });
    }

    const res = await fetch(`${AGENTIC_URL}/api/terraform/apply/status`, {
      method: 'POST',
      headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        project_name: projectName,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json().catch(() => ({})) as { success?: boolean; status?: string; result?: unknown; error?: string };
    if (!res.ok || data.success !== true) {
      const message = String(data.error || 'Failed to fetch deployment status.');
      const lowered = message.toLowerCase();
      const isNoActiveState =
        lowered.includes('no active deployment process')
        || lowered.includes('project_id or project_name is required');
      if (res.ok && isNoActiveState) {
        return NextResponse.json({
          success: true,
          status: 'idle',
          result: null,
          warning: message,
        });
      }
      return NextResponse.json(
        {
          success: false,
          status: 'idle',
          result: null,
          error: message,
        },
        { status: res.ok ? 500 : res.status },
      );
    }

    return NextResponse.json({
      success: true,
      status: String(data.status || 'idle'),
      result: (data.result ?? null),
      logs: Array.isArray((data.result as { logs?: unknown } | null)?.logs)
        ? ((data.result as { logs: string[] }).logs)
        : [],
      phase: String((data.result as { phase?: unknown } | null)?.phase || ''),
      phase_message: String((data.result as { phase_message?: unknown } | null)?.phase_message || ''),
    });
  } catch (err) {
    const msg = classifyStatusError(err);
    return NextResponse.json({
      success: true,
      status: 'idle',
      result: null,
      warning: msg,
    });
  }
}
