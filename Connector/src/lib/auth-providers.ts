/**
 * Single source of truth for how the auth screens reach the backend.
 *
 * GitHub OAuth is the only live path today. Google and email/password are
 * rendered by the UI kit already, so they stay visible and keep their design;
 * flipping `enabled` here (plus adding the route) turns them on without
 * touching any of the auth screens.
 */

export const LOGIN_HREF = '/auth/login';
export const SIGNUP_HREF = '/auth/signup';
export const FORGOT_PASSWORD_HREF = '/auth/forgot-password';
export const THANK_YOU_HREF = '/auth/thank-you';

/** Entry point for the existing GitHub OAuth flow. `force=1` skips the post-logout guard. */
export const GITHUB_OAUTH_HREF = '/api/auth/login?force=1';

/** Where `/api/auth/callback` drops an authenticated user. */
export const POST_LOGIN_HREF = '/dashboard';

export type OAuthProviderId = 'google' | 'github';

export interface OAuthProvider {
  id: OAuthProviderId;
  label: string;
  /** Redirect target that starts the flow, or null while the provider is disabled. */
  href: string | null;
  enabled: boolean;
}

export const oauthProviders: Record<OAuthProviderId, OAuthProvider> = {
  google: {
    id: 'google',
    label: 'Google',
    href: null,
    enabled: false,
  },
  github: {
    id: 'github',
    label: 'GitHub',
    href: GITHUB_OAUTH_HREF,
    enabled: true,
  },
};

/** Platform-side email/password auth. Off until the credential routes exist. */
export const isEmailPasswordAuthEnabled = false;

export function providerUnavailableMessage(label: string) {
  return `${label} sign-in isn't available yet. Continue with GitHub for now.`;
}

export const EMAIL_AUTH_UNAVAILABLE_MESSAGE =
  "Email and password sign-in isn't available yet. Continue with GitHub for now.";

type EmailAuthAction = 'login' | 'signup' | 'forgot-password';

const emailAuthEndpoints: Record<EmailAuthAction, string> = {
  login: '/api/auth/password/login',
  signup: '/api/auth/password/signup',
  'forgot-password': '/api/auth/password/forgot',
};

export interface EmailAuthResult {
  ok: boolean;
  /** Message safe to surface in the existing error summary UI. */
  error?: string;
}

/**
 * Submits credentials to the platform auth API. While
 * `isEmailPasswordAuthEnabled` is false this short-circuits with a message
 * instead of firing a request at a route that does not exist yet.
 */
export async function submitEmailAuth(
  action: EmailAuthAction,
  payload: Record<string, unknown>,
): Promise<EmailAuthResult> {
  if (!isEmailPasswordAuthEnabled) {
    return { ok: false, error: EMAIL_AUTH_UNAVAILABLE_MESSAGE };
  }

  try {
    const response = await fetch(emailAuthEndpoints[action], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? 'Something went wrong. Please try again.' };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error. Please check your connection and try again.' };
  }
}
