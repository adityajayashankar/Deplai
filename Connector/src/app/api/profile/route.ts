import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { requireAuth } from '@/lib/auth';
import { getSessionOptions, type SessionData } from '@/lib/session';
import { getProfileBundle, updateProfile } from '@/lib/profile/store';

export const runtime = 'nodejs';

function httpError(error: unknown) {
  const err = error as Error & { details?: Record<string, string> };
  if (err.details) {
    return NextResponse.json({ error: err.message, details: err.details }, { status: 400 });
  }
  return NextResponse.json({ error: err.message || 'Failed to load profile' }, { status: 500 });
}

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const bundle = await getProfileBundle(auth.user);
    return NextResponse.json(bundle);
  } catch (error) {
    return httpError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({})) as {
      displayName?: string;
      email?: string;
      linkedinUrl?: string;
      githubUrl?: string;
    };
    const profile = await updateProfile(auth.user, body);
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());
    if (session.user) {
      session.user.name = profile.displayName;
      await session.save();
    }
    return NextResponse.json({ profile });
  } catch (error) {
    return httpError(error);
  }
}
