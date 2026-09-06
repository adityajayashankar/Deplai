import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { dispatchSecurityEvents } from '@/lib/security/sdlc-events';

export async function POST(request: NextRequest) {
  const expected = Buffer.from(process.env.DEPLAI_SERVICE_KEY || '');
  const supplied = Buffer.from(request.headers.get('x-deplai-service-key') || '');
  if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await dispatchSecurityEvents());
}
