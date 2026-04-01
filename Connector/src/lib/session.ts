import { SessionOptions } from 'iron-session';
import { requireEnv } from './env';

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

export const sessionOptions: SessionOptions = {
  password: requireEnv('SESSION_SECRET'),
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
