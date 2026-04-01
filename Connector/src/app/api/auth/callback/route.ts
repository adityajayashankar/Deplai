import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { sessionOptions, SessionData } from '@/lib/session';
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
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const returnedState = String(searchParams.get('state') || '').trim();

    const expectedState = String(session.oauthState || '').trim();
    const stateExpiresAt = Number(session.oauthStateExpiresAt || 0);

    session.oauthState = undefined;
    session.oauthStateExpiresAt = undefined;

    if (!code) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=no_code`);
    }
    if (!expectedState || !returnedState || !stateExpiresAt || Date.now() > stateExpiresAt || !safeStateMatches(expectedState, returnedState)) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=auth_failed`);
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        state: returnedState,
      }),
    });

    const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };

    if (!tokenResponse.ok || tokenData.error) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=token_error`);
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=token_missing`);
    }

    const [githubUserResponse, emailsResponse] = await Promise.all([
      fetchGitHub('/user', accessToken),
      fetchGitHub('/user/emails', accessToken),
    ]);

    if (!githubUserResponse.ok || !emailsResponse.ok) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=auth_failed`);
    }

    const githubUser = await githubUserResponse.json() as GitHubUser;
    const emails = await emailsResponse.json() as GitHubEmail[];

    if (!githubUser?.id || !githubUser?.login) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=auth_failed`);
    }

    const primaryEmail = emails.find((e) => e.primary)?.email || emails[0]?.email;
    if (!primaryEmail) {
      await session.save();
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=no_email`);
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

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard`);
  } catch (error) {
    console.error('Auth callback error:', error);
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=auth_failed`);
  }
}
