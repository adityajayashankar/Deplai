import { SessionOptions } from 'iron-session';

export interface SessionData {
  user?: {
    id: string;
    githubId: number;
    login: string;
    email: string;
    name: string;
    avatarUrl: string;
  };
  oauthState?: string;
  oauthStateExpiresAt?: number;
  isLoggedIn: boolean;
}

const devSessionSecret = 'deplai-local-dev-session-secret-2026-fallback';

function resolveSessionSecret(): string {
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  const resolvedSessionSecret = sessionSecret || (process.env.NODE_ENV === 'production' ? '' : devSessionSecret);

  if (!resolvedSessionSecret) {
    throw new Error('Missing required environment variable: SESSION_SECRET');
  }

  return resolvedSessionSecret;
}

// Next.js imports route modules while collecting build-time metadata. Resolve the
// secret only when a request needs a session so Docker secrets stay runtime-only.
export function getSessionOptions(): SessionOptions {
  return {
    password: resolveSessionSecret(),
    cookieName: 'deplai_session',
    cookieOptions: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 7,
      sameSite: 'lax',
    },
  };
}

export const defaultSession: SessionData = {
  isLoggedIn: false,
};
