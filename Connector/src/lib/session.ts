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
  isLoggedIn: boolean;
}

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET!,
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