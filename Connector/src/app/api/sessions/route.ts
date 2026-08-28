import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { createSession, listSessions } from '@/lib/sessions/store';
import {
  isSessionService,
  isSessionStatus,
  type SessionService,
  type SessionStatus,
} from '@/lib/sessions/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const params = request.nextUrl.searchParams;
  const serviceRaw = params.get('service') || '';
  const statusRaw = params.get('status') || '';
  const service = isSessionService(serviceRaw) ? serviceRaw : undefined;
  const status = isSessionStatus(statusRaw) ? statusRaw : undefined;

  try {
    const result = await listSessions(auth.user.id, {
      search: params.get('search') || '',
      service,
      status,
      limit: Number(params.get('limit') || 20),
      offset: Number(params.get('offset') || 0),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[sessions] list failed', error);
    return NextResponse.json({ error: 'Could not load sessions.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    service?: string;
    project_id?: string;
    title?: string;
    repo?: string;
    status?: string;
    current_stage?: string;
    external_id?: string;
    metadata?: Record<string, unknown>;
  };

  if (!isSessionService(body.service)) {
    return NextResponse.json({ error: 'A valid service is required.' }, { status: 400 });
  }
  const service: SessionService = body.service;
  const projectId = String(body.project_id || '').trim();
  if (projectId) {
    const owned = await verifyProjectOwnership(auth.user.id, projectId);
    if ('error' in owned) return owned.error;
  }

  const status: SessionStatus | undefined = isSessionStatus(body.status) ? body.status : undefined;
  const title = String(body.title || '').trim()
    || `${service} run${body.repo ? ` · ${body.repo}` : ''}`;

  try {
    const session = await createSession({
      userId: auth.user.id,
      projectId: projectId || null,
      service,
      title,
      repo: String(body.repo || '').trim() || null,
      status,
      currentStage: String(body.current_stage || '').trim() || null,
      triggeredBy: auth.user.id,
      externalId: String(body.external_id || '').trim() || null,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    console.error('[sessions] create failed', error);
    return NextResponse.json({ error: 'Could not create session.' }, { status: 500 });
  }
}
