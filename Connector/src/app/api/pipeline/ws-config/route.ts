import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

function toWsBase(httpOrWsUrl: string): string | null {
  try {
    const parsed = new URL(httpOrWsUrl);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { error } = await requireAuth();
  if (error) return error;

  // AGENTIC_LAYER_URL is a Docker-internal hostname in production. Never send
  // it to the browser. The browser always connects same-origin at /agentic,
  // which Caddy (prod) or the Next.js upgrade proxy (dev) forwards only for
  // /agentic/ws/*. HTTP Agentic APIs are not publicly rewritten.
  const requestOrigin = request.nextUrl.origin;
  const sameOriginWsBase = toWsBase(requestOrigin);
  const wsBase = sameOriginWsBase ? `${sameOriginWsBase}/agentic` : null;
  if (!wsBase) {
    return NextResponse.json(
      { success: false, error: 'Unable to resolve the public WebSocket base URL.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, ws_base: wsBase });
}

