import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { resolveAgenticWsBaseFromConfig } from '@/lib/agentic-websocket';

export async function GET(request: NextRequest) {
  const { error } = await requireAuth();
  if (error) return error;

  const wsBase = resolveAgenticWsBaseFromConfig({
    requestOrigin: request.nextUrl.origin,
  });
  if (!wsBase) {
    return NextResponse.json(
      { success: false, error: 'Unable to resolve the public WebSocket base URL.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, ws_base: wsBase });
}

