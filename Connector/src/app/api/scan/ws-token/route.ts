import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { createHmac } from 'crypto';

// WS_TOKEN_SECRET is a server-side-only secret used to sign short-lived WebSocket
// tokens. It MUST NOT be the same as DEPLAI_SERVICE_KEY — keep it separate.
// Falls back to DEPLAI_SERVICE_KEY only so existing single-env deployments still work.
const WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET || process.env.DEPLAI_SERVICE_KEY || '';

export async function GET(request: NextRequest) {
  const { error, user } = await requireAuth();
  if (error) return error;

  if (!WS_TOKEN_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // project_id is required — tokens are scoped per project so they cannot be
  // replayed against a different project's WebSocket endpoint.
  const projectId = request.nextUrl.searchParams.get('project_id');
  if (!projectId) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  }

  // Verify the user actually owns this project before issuing a WS token
  const ownership = await verifyProjectOwnership(user!.id, projectId);
  if ('error' in ownership) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
  }

  // Build a short-lived (5 min) opaque token bound to both the authenticated
  // user and the specific project. The actual service key never leaves the server.
  // sub is always a string so the Python side never sees int/str type mismatch.
  const payload = Buffer.from(
    JSON.stringify({ sub: String(user!.id), project_id: projectId, exp: Math.floor(Date.now() / 1000) + 300 })
  ).toString('base64url');

  const sig = createHmac('sha256', WS_TOKEN_SECRET).update(payload).digest('hex');

  return NextResponse.json({ token: `${payload}.${sig}` });
}
