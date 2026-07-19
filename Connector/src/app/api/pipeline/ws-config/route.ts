import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL } from '@/lib/agentic';

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

export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;

  // AGENTIC_LAYER_URL points to the Docker-internal service name. Prefer the
  // public WebSocket URL so clients that fall back to this endpoint never try
  // to connect to `ws://agentic-layer:8000` from the browser.
  const publicWsUrl = String(process.env.NEXT_PUBLIC_AGENTIC_WS_URL || '').trim();
  const wsBase = toWsBase(publicWsUrl || AGENTIC_URL);
  if (!wsBase) {
    return NextResponse.json(
      { success: false, error: 'Unable to resolve websocket base from AGENTIC_LAYER_URL.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, ws_base: wsBase });
}

