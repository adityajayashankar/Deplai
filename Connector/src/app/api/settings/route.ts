import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import {
  cloneDefaultUserSettings,
  mergeUserSettingsPatch,
  parseStoredUserSettings,
  toPublicUserSettings,
  type UserSettingsData,
} from '@/lib/user-settings';

type DbError = {
  code?: string;
  sqlMessage?: string;
  message?: string;
  stack?: string;
};

type SettingsRow = {
  user_id: string;
  data_json: unknown;
  updated_at: Date | string | null;
};

function isConnectivityError(error: unknown): boolean {
  const dbError = error as DbError;
  return (
    dbError?.code === 'ECONNREFUSED' ||
    dbError?.code === 'ENOTFOUND' ||
    dbError?.code === 'ETIMEDOUT' ||
    dbError?.code === 'EHOSTUNREACH' ||
    dbError?.code === 'PROTOCOL_CONNECTION_LOST'
  );
}

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

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function serverConfigSnapshot() {
  return {
    githubAppConfigured: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY),
    githubWebhookConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
    awsRuntimeConfigured: Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    sessionSecretConfigured: Boolean(process.env.SESSION_SECRET),
    serviceKeyConfigured: Boolean(process.env.DEPLAI_SERVICE_KEY),
    cleanupEnabled: String(process.env.ALLOW_GLOBAL_CLEANUP || '').toLowerCase() === 'true',
  };
}

async function ensureSettingsTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS user_settings (
      user_id VARCHAR(36) PRIMARY KEY,
      data_json JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
}

async function loadUserSettings(userId: string): Promise<{ settings: UserSettingsData; updatedAt: string | null }> {
  const rows = await query<SettingsRow[]>(
    `SELECT user_id, data_json, updated_at
     FROM user_settings
     WHERE user_id = ?
     LIMIT 1`,
    [userId]
  );

  const row = rows[0];
  if (!row) {
    return {
      settings: cloneDefaultUserSettings(),
      updatedAt: null,
    };
  }

  return {
    settings: parseStoredUserSettings(parseJsonColumn(row.data_json)),
    updatedAt: toIso(row.updated_at),
  };
}

async function saveUserSettings(userId: string, settings: UserSettingsData) {
  await query(
    `INSERT INTO user_settings (user_id, data_json)
     VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(settings)]
  );
}

export async function GET() {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    await ensureSettingsTable();
    const current = await loadUserSettings(user.id);

    return NextResponse.json({
      settings: toPublicUserSettings(current.settings),
      serverConfig: serverConfigSnapshot(),
      updatedAt: current.updatedAt,
    });
  } catch (error: unknown) {
    const dbError = error as DbError;
    console.error('Error loading user settings:', {
      code: dbError?.code,
      message: dbError?.sqlMessage || dbError?.message,
      stack: dbError?.stack,
    });

    if (isConnectivityError(error)) {
      return NextResponse.json(
        { error: 'Database unavailable. Verify DB_HOST/DB_PORT and that MySQL is running.' },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    await ensureSettingsTable();
    const current = await loadUserSettings(user.id);
    const body = await request.json().catch(() => ({})) as { settings?: unknown } | unknown;
    const incoming = (body as { settings?: unknown })?.settings ?? body;

    const merged = mergeUserSettingsPatch(current.settings, incoming);
    await saveUserSettings(user.id, merged);
    const next = await loadUserSettings(user.id);

    return NextResponse.json({
      success: true,
      settings: toPublicUserSettings(next.settings),
      serverConfig: serverConfigSnapshot(),
      updatedAt: next.updatedAt,
    });
  } catch (error: unknown) {
    const dbError = error as DbError;
    console.error('Error saving user settings:', {
      code: dbError?.code,
      message: dbError?.sqlMessage || dbError?.message,
      stack: dbError?.stack,
    });

    if (isConnectivityError(error)) {
      return NextResponse.json(
        { error: 'Database unavailable. Verify DB_HOST/DB_PORT and that MySQL is running.' },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
