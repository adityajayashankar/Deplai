import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminConfig } from '@/lib/config';
import { authCookieOptions, getAuthCookieNames } from '@/lib/auth/cookies';
import {
  getSessionByToken,
  hasValidStepUp,
  verifySessionCsrf,
  type AdminSession,
} from '@/lib/auth/sessions';
import { ownerHasPermission, type AdminPermission, type StepUpScope } from '@/lib/authorization/permissions';

export type RequestContext = {
  session: AdminSession;
  sessionToken: string;
  csrfToken: string;
  ip: string | null;
  requestId: string;
};

export function getClientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || null;
  return request.headers.get('x-real-ip');
}

export function isPrivateNetworkRequest(request: NextRequest): boolean {
  const ip = getClientIp(request);
  if (!ip) return process.env.NODE_ENV !== 'production';
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(ip);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return process.env.NODE_ENV !== 'production';
}

export async function readSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(getAuthCookieNames().session)?.value || null;
}

export async function readCsrfToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(getAuthCookieNames().csrf)?.value || null;
}

export function setSessionCookies(
  response: NextResponse,
  input: { sessionToken: string; csrfToken: string },
): void {
  const names = getAuthCookieNames();
  const maxAge = getAdminConfig().sessionAbsoluteHours * 60 * 60;
  response.cookies.set(names.session, input.sessionToken, authCookieOptions({ maxAge }));
  response.cookies.set(names.csrf, input.csrfToken, authCookieOptions({ httpOnly: false, maxAge }));
}

export function clearSessionCookies(response: NextResponse): void {
  const names = getAuthCookieNames();
  const expired = authCookieOptions({ maxAge: 0 });
  response.cookies.set(names.session, '', expired);
  response.cookies.set(names.csrf, '', { ...expired, httpOnly: false });
  response.cookies.set(names.pending, '', expired);
}

export async function requireAdminApi(
  request: NextRequest,
  options?: { permission?: AdminPermission; stepUp?: StepUpScope; requireMfa?: boolean },
): Promise<{ context: RequestContext } | { error: NextResponse }> {
  if (!getAdminConfig().enabled) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }

  if (!isPrivateNetworkRequest(request)) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }

  const sessionToken = await readSessionToken();
  const csrfToken = await readCsrfToken();
  if (!sessionToken || !csrfToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const session = await getSessionByToken(sessionToken);
  if (!session) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  if (options?.requireMfa !== false && !session.mfaVerified) {
    return { error: NextResponse.json({ error: 'MFA required' }, { status: 403 }) };
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const headerToken = request.headers.get('x-csrf-token');
    if (!headerToken || headerToken !== csrfToken) {
      return { error: NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 }) };
    }
    const valid = await verifySessionCsrf(sessionToken, csrfToken);
    if (!valid) {
      return { error: NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 }) };
    }
  }

  if (options?.permission && !ownerHasPermission(options.permission)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  if (options?.stepUp) {
    const elevated = await hasValidStepUp(session.id, options.stepUp);
    if (!elevated) {
      return { error: NextResponse.json({ error: 'Step-up authentication required', code: 'step_up_required', scope: options.stepUp }, { status: 403 }) };
    }
  }

  return {
    context: {
      session,
      sessionToken,
      csrfToken,
      ip: getClientIp(request),
      requestId: request.headers.get('x-request-id') || crypto.randomUUID(),
    },
  };
}
