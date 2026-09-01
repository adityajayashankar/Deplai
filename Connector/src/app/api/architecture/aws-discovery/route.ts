import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface DiscoveryBody {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth();
  if (error) return error;
  try {
    const body = await req.json() as DiscoveryBody;
    if (!String(body.aws_access_key_id || '').trim() || !String(body.aws_secret_access_key || '').trim()) {
      return NextResponse.json({ error: 'AWS access key and secret key are required.' }, { status: 400 });
    }
    const upstream = await fetch(`${AGENTIC_URL}/api/architecture/aws-discovery`, {
      method: 'POST',
      headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aws_access_key_id: body.aws_access_key_id,
        aws_secret_access_key: body.aws_secret_access_key,
        aws_session_token: body.aws_session_token || null,
        aws_region: body.aws_region || 'eu-north-1',
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await upstream.json().catch(() => ({})) as { success?: boolean; context?: unknown; error?: string };
    if (!upstream.ok || data.success !== true) {
      return NextResponse.json({ error: data.error || 'AWS discovery failed.' }, { status: upstream.ok ? 500 : upstream.status });
    }
    return NextResponse.json({ success: true, context: data.context || null });
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError';
    return NextResponse.json({ error: timeout ? 'AWS discovery timed out.' : 'AWS discovery is unavailable.' }, { status: timeout ? 504 : 502 });
  }
}
