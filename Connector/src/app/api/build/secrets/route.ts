import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { isAllowedBrowserOrigin } from '@/lib/agentic-websocket';
import { buildSecretEditor, buildSecretMetadata } from '@/lib/deplai-build/secret-store';
import { assertScope } from '@/lib/deplai-build/contracts';

export const runtime = 'nodejs';
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function handle(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return reply({ error: 'Authentication required' }, 401);
  try {
    const scope = { owner_user_id: user.id, organization_id: request.nextUrl.searchParams.get('organization_id') || '', project_id: request.nextUrl.searchParams.get('project_id') || '', session_id: request.nextUrl.searchParams.get('session_id') || '' };
    assertScope(scope);
    if (request.method === 'GET') return reply({ secrets: await buildSecretMetadata.listRequiredSecrets(user.id, scope) });
    const origin = request.headers.get('origin');
    if (!origin || !isAllowedBrowserOrigin(origin, { hostHeader: request.headers.get('host'), forwardedHost: request.headers.get('x-forwarded-host'), forwardedProto: request.headers.get('x-forwarded-proto'), requestOrigin: request.nextUrl.origin })) return reply({ error: 'Invalid request origin' }, 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'JSON required' }, 415);
    // Bound reads before buffering; never log request bodies.
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: 'Request body required' }, 400);
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 20000) { await reader.cancel(); return reply({ error: 'Request too large' }, 413); }
      chunks.push(next.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['reference', 'value'].includes(k)) || typeof body.reference !== 'string') return reply({ error: 'Invalid secret request' }, 400);
    if (request.method === 'DELETE') { await buildSecretEditor.deleteSecret(user.id, scope, body.reference); return reply({ deleted: true }); }
    if (typeof body.value !== 'string') return reply({ error: 'Secret value required' }, 400);
    return reply({ secret: await buildSecretEditor.updateSecret(user.id, scope, body.reference, body.value) });
  } catch { return reply({ error: 'Secret request failed. Verify session access, declared secret metadata and vault configuration.' }, 400); }
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
