import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { getSessionOptions, SessionData } from '@/lib/session';
import { query } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
}

interface GitHubOrg {
  login: string;
}

interface GitHubInstallationAccount {
  login: string;
  type: string;
}

interface GitHubInstallation {
  id: number;
  account: GitHubInstallationAccount;
  suspended_at: string | null;
}

interface GitHubInstallationsResponse {
  installations?: GitHubInstallation[];
}

function fetchGitHub(endpoint: string, accessToken: string) {
  return fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
}

function safeStateMatches(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const installationIdParam = String(searchParams.get('installation_id') || '').trim();
    const setupAction = String(searchParams.get('setup_action') || '').trim();
    const returnedState = String(searchParams.get('state') || '').trim();

    // GitHub App "Request user authorization during installation" returns BOTH
    // an OAuth `code` and installation setup params. If we short-circuit on
    // setup_action alone, the one-time code is discarded and the user never
    // gets a session — they bounce back to login/landing.
    //
    // Setup-only callbacks (no code) still bind an install for an existing session.
    if (installationIdParam && setupAction && !code) {
      if (!session.isLoggedIn || !session.user) {
        session.oauthState = undefined;
        session.oauthStateExpiresAt = undefined;
        await session.save();
        return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/api/auth/login?force=1`, 302);
      }

      if (session.isLoggedIn && session.user) {
        await query(
          `UPDATE github_installations
           SET user_id = ?
           WHERE installation_id = ?
             AND (user_id IS NULL OR user_id = ?)` ,
          [session.user.id, Number(installationIdParam), session.user.id]
        ).catch((error) => {
          console.warn('Failed to bind installation ownership during setup callback:', error);
        });
      }

      session.oauthState = undefined;
      session.oauthStateExpiresAt = undefined;
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard`, 302);
    }

    const expectedState = String(session.oauthState || '').trim();
    const stateExpiresAt = Number(session.oauthStateExpiresAt || 0);
    // GitHub App install+authorize can return a code without round-tripping the
    // oauthState we only set when the user starts at /api/auth/login.
    const isInstallOAuth = Boolean(code && installationIdParam && setupAction);

    session.oauthState = undefined;
    session.oauthStateExpiresAt = undefined;

    if (!code) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=no_code`, 302);
    }
    if (
      !isInstallOAuth
      && (
        !expectedState
        || !returnedState
        || !stateExpiresAt
        || Date.now() > stateExpiresAt
        || !safeStateMatches(expectedState, returnedState)
      )
    ) {
      console.error('Auth callback state mismatch', {
        hasExpectedState: Boolean(expectedState),
        hasReturnedState: Boolean(returnedState),
        stateExpiresAt,
        now: Date.now(),
      });
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=state_mismatch`, 302);
    }

    const clientId = String(process.env.GITHUB_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.GITHUB_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) {
      console.error('Auth callback missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET');
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=oauth_config`, 302);
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${String(process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')}/api/auth/callback`,
        state: returnedState || undefined,
      }),
    });

    const tokenData = await tokenResponse.json() as { access_token?: string; error?: string; error_description?: string };

    if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
      console.error('Auth callback token exchange failed', {
        status: tokenResponse.status,
        error: tokenData.error,
        description: tokenData.error_description,
      });
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=token_error`, 302);
    }

    const accessToken = tokenData.access_token;

    const [githubUserResponse, emailsResponse] = await Promise.all([
      fetchGitHub('/user', accessToken),
      fetchGitHub('/user/emails', accessToken),
    ]);

    if (!githubUserResponse.ok) {
      console.error('Auth callback /user failed', { status: githubUserResponse.status });
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=github_profile`, 302);
    }

    const githubUser = await githubUserResponse.json() as GitHubUser & { email?: string | null };
    if (!githubUser?.id || !githubUser?.login) {
      console.error('Auth callback /user payload missing id/login');
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=github_profile`, 302);
    }

    let emails: GitHubEmail[] = [];
    if (emailsResponse.ok) {
      const parsed = await emailsResponse.json();
      emails = Array.isArray(parsed) ? parsed as GitHubEmail[] : [];
    } else {
      console.warn('Auth callback /user/emails failed; falling back to profile email', {
        status: emailsResponse.status,
      });
    }

    const primaryEmail = emails.find((e) => e.primary)?.email
      || emails[0]?.email
      || (typeof githubUser.email === 'string' ? githubUser.email.trim() : '')
      || `${githubUser.id}+${githubUser.login}@users.noreply.github.com`;
    if (!primaryEmail) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=no_email`, 302);
    }

    let [user] = await query<Array<{ id: string }>>(
      'SELECT id FROM users WHERE email = ?',
      [primaryEmail]
    );

    if (!user) {
      const userId = uuidv4();
      await query(
        `INSERT INTO users (id, email, name) VALUES (?, ?, ?)`,
        [userId, primaryEmail, githubUser.name || githubUser.login]
      );
      user = { id: userId };
    }

    session.user = {
      id: user.id,
      githubId: githubUser.id,
      login: githubUser.login,
      email: primaryEmail,
      name: githubUser.name || githubUser.login,
      avatarUrl: githubUser.avatar_url,
    };
    session.isLoggedIn = true;
    await session.save();

    // Installation sync is best-effort. Never fail an otherwise successful login.
    try {
      if (installationIdParam) {
        await query(
          `UPDATE github_installations
           SET user_id = ?
           WHERE installation_id = ?
             AND (user_id IS NULL OR user_id = ?)`,
          [user.id, Number(installationIdParam), user.id]
        );
      }

      await query(
        `UPDATE github_installations
         SET user_id = ?
         WHERE account_login = ? AND user_id IS NULL`,
        [user.id, githubUser.login]
      );

      const orgsResponse = await fetchGitHub('/user/orgs', accessToken);

      if (orgsResponse.ok) {
        const orgs = await orgsResponse.json() as GitHubOrg[];
        for (const org of orgs) {
          await query(
            `UPDATE github_installations
             SET user_id = ?
             WHERE account_login = ? AND account_type = 'Organization' AND user_id IS NULL`,
            [user.id, org.login]
          );
        }
      }

      // Fallback for local/dev environments where webhook delivery may be missing:
      // seed installation rows directly from the authenticated user's visible installs.
      const installsResponse = await fetchGitHub('/user/installations?per_page=100', accessToken);
      if (installsResponse.ok) {
        const installsPayload = await installsResponse.json() as GitHubInstallationsResponse;
        const installs = installsPayload.installations || [];

        for (const installation of installs) {
          if (!installation?.id || !installation.account?.login) continue;

          await query(
            `INSERT INTO github_installations
             (id, installation_id, account_login, account_type, user_id, suspended_at, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               account_login = VALUES(account_login),
               account_type = VALUES(account_type),
               suspended_at = VALUES(suspended_at),
               metadata = VALUES(metadata),
               user_id = IF(user_id IS NULL OR user_id = VALUES(user_id), VALUES(user_id), user_id)`,
            [
              uuidv4(),
              installation.id,
              installation.account.login,
              installation.account.type || 'User',
              user.id,
              installation.suspended_at ? new Date(installation.suspended_at) : null,
              JSON.stringify({ installation }),
            ]
          );
        }
      }
    } catch (syncError) {
      console.warn('Post-login GitHub installation sync failed:', syncError);
    }

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard`, 302);
  } catch (error) {
    console.error('Auth callback error:', error);
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=auth_failed`, 302);
  }
}
