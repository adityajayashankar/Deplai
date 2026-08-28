import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listSelectableModels, saveRoutingPreferences } from '@/lib/profile/store';
import { ROUTING_MODES } from '@/lib/profile/logic';

export const runtime = 'nodejs';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const models = await listSelectableModels();
    return NextResponse.json({ modes: ROUTING_MODES, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load routing options';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({})) as { mode?: string; efficientPool?: unknown };
    const routing = await saveRoutingPreferences(auth.user, body);
    return NextResponse.json({ routing });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to save routing configuration';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
