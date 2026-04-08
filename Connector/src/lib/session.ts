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
const sessionSecret = process.env.SESSION_SECRET?.trim();
const resolvedSessionSecret = sessionSecret || (process.env.NODE_ENV === 'production' ? '' : devSessionSecret);

if (!resolvedSessionSecret) {
  throw new Error('Missing required environment variable: SESSION_SECRET');
}

export const sessionOptions: SessionOptions = {
  password: resolvedSessionSecret,
  cookieName: 'deplai_session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7,
    sameSite: 'lax',
  },
};

export const defaultSession: SessionData = {
  isLoggedIn: false,
};
