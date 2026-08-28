import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { getProfileBundle } from '@/lib/profile/store';
import { parseStoredUserSettings, toPublicUserSettings } from '@/lib/user-settings';

export const runtime = 'nodejs';

type SettingsRow = {
  data_json: unknown;
  updated_at: Date | string | null;
};

type ProjectRow = {
  id: string;
  name: string;
  project_type: string;
  created_at: Date | string;
};

type InstallationRow = {
  account_login: string;
  account_type: string;
  installed_at: Date | string | null;
  suspended_at: Date | string | null;
};

function parseJsonColumn(value: unknown): unknown {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;

  const bundle = await getProfileBundle(user).catch(() => null);

  let settings: ReturnType<typeof toPublicUserSettings>['user'] | null = null;
  let settingsUpdatedAt: Date | string | null = null;
  try {
    const rows = await query<SettingsRow[]>(
      `SELECT data_json, updated_at FROM user_settings WHERE user_id = ? LIMIT 1`,
      [user.id],
    );
    const row = rows[0];
    if (row) {
      settings = toPublicUserSettings(parseStoredUserSettings(parseJsonColumn(row.data_json))).user;
      settingsUpdatedAt = row.updated_at;
    }
  } catch {
    settings = null;
  }

  let projects: ProjectRow[] = [];
  try {
    projects = await query<ProjectRow[]>(
      `SELECT id, name, project_type, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC`,
      [user.id],
    );
  } catch {
    projects = [];
  }

  let installations: InstallationRow[] = [];
  try {
    installations = await query<InstallationRow[]>(
      `SELECT account_login, account_type, installed_at, suspended_at
       FROM github_installations
       WHERE user_id = ?
       ORDER BY installed_at DESC`,
      [user.id],
    );
  } catch {
    installations = [];
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      login: user.login,
      email: user.email,
      name: user.name,
    },
    profile: bundle?.profile ?? null,
    credits: bundle?.credits ?? null,
    subscription: bundle?.subscription ?? null,
    settings: settings
      ? {
          account: settings.account,
          preferences: settings.preferences,
          privacy: settings.privacy,
          updatedAt: settingsUpdatedAt,
        }
      : null,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      type: project.project_type,
      createdAt: project.created_at,
    })),
    githubInstallations: installations.map((installation) => ({
      account: installation.account_login,
      type: installation.account_type,
      installedAt: installation.installed_at,
      suspended: Boolean(installation.suspended_at),
    })),
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="deplai-data-export.json"',
      'Cache-Control': 'no-store',
    },
  });
}
