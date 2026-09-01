import { getAdminConfig } from '@/lib/config';

export type AuthCookieNames = {
  session: string;
  csrf: string;
  pending: string;
};

export function getAuthCookieNames(): AuthCookieNames {
  if (getAdminConfig().isProduction) {
    return {
      session: '__Host-deplai_admin_session',
      csrf: '__Host-deplai_admin_csrf',
      pending: '__Host-deplai_admin_pending',
    };
  }
  // __Host- cookies require Secure and break on http://127.0.0.1 in development.
  return {
    session: 'deplai_admin_session',
    csrf: 'deplai_admin_csrf',
    pending: 'deplai_admin_pending',
  };
}

export function authCookieOptions(input?: { httpOnly?: boolean; maxAge?: number }) {
  const secure = getAdminConfig().isProduction;
  return {
    httpOnly: input?.httpOnly ?? true,
    secure,
    sameSite: 'strict' as const,
    path: '/',
    ...(input?.maxAge != null ? { maxAge: input.maxAge } : {}),
  };
}
