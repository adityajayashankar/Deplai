import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_ENV_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_MODE',
] as const;

function adminConsoleRoot(): string {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), 'admin-console'),
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(candidate, 'package.json'), 'utf8')) as { name?: string };
        if (pkg.name === 'deplai-admin-console') return candidate;
      } catch {
        // continue
      }
    }
  }
  return process.cwd();
}

function connectorEnvPath(root: string): string | null {
  const candidates = [
    resolve(root, '../Connector/.env.local'),
    resolve(root, 'Connector/.env.local'),
  ];
  return candidates.find((path) => existsSync(path)) || null;
}

function parseEnvFile(path: string, options?: { override?: boolean; onlyKeys?: readonly string[] }) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  const override = options?.override ?? false;
  const onlyKeys = options?.onlyKeys;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (onlyKeys && !onlyKeys.includes(key)) continue;

    const existing = process.env[key];
    if (!override && existing != null && existing !== '') continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

let loaded = false;

/** Load env for CLI scripts and the Next.js runtime (Connector DB fallback in dev). */
export function loadAdminEnv(): void {
  if (loaded) return;
  loaded = true;

  // Production configuration must come from the deployment environment.
  if (process.env.NODE_ENV === 'production') return;

  const root = adminConsoleRoot();
  parseEnvFile(resolve(root, '.env'));
  parseEnvFile(resolve(root, '.env.local'), { override: true });

  const connectorEnv = connectorEnvPath(root);
  if (connectorEnv) {
    parseEnvFile(connectorEnv, { onlyKeys: SHARED_ENV_KEYS });
  }

  // Fill any still-empty shared DB keys from Connector.
  if (connectorEnv) {
    for (const key of SHARED_ENV_KEYS) {
      if (!process.env[key]) {
        parseEnvFile(connectorEnv, { onlyKeys: [key], override: true });
      }
    }
  }
}

export function resetAdminEnvCache(): void {
  loaded = false;
}
