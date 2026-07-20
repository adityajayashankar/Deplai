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

  // AGENTIC_LAYER_URL is intentionally a Docker-internal service name. Never
  // send it to a browser: use the explicitly configured public endpoint or
  // the same-origin Caddy /agentic proxy instead.
  const publicWsUrl = String(process.env.NEXT_PUBLIC_AGENTIC_WS_URL || '').trim();
  const sameOriginWsBase = toWsBase(request.nextUrl.origin);
  const wsBase = toWsBase(publicWsUrl) || (sameOriginWsBase ? `${sameOriginWsBase}/agentic` : null);
  if (!wsBase) {
    return NextResponse.json(
      { success: false, error: 'Unable to resolve the public WebSocket base URL.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, ws_base: wsBase });
}

