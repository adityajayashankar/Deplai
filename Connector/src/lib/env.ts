import fs from 'fs';
import path from 'path';
import { loadEnvConfig } from '@next/env';

let envLoaded = false;

/** Keys that must follow the workspace root `.env` (local testing / unified secrets). */
const WORKSPACE_AUTHORITATIVE_KEYS = new Set([
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_GITHUB_APP_SLUG',
  'NEXT_PUBLIC_GITHUB_APP_INSTALL_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_WEBHOOK_URL',
  'GITHUB_APP_NAME',
]);

function normalizeEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hydrateEnvFromFile(filePath: string, options?: { override?: boolean }): void {
  if (!fs.existsSync(filePath)) return;

  const override = Boolean(options?.override);
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    const current = process.env[key];
    if (!override && typeof current === 'string' && current.trim().length > 0) continue;

    process.env[key] = normalizeEnvValue(line.slice(separator + 1));
  }
}

function hydrateAuthoritativeKeysFromFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!WORKSPACE_AUTHORITATIVE_KEYS.has(key)) continue;

    process.env[key] = normalizeEnvValue(line.slice(separator + 1));
  }
}

function loadWorkspaceEnv(): void {
  if (envLoaded) return;

  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, 'Connector'),
    path.resolve(cwd, '..'),
  ];

  const connectorRoot = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'next.config.ts'))
  ) || cwd;
  const workspaceRoot = path.resolve(connectorRoot, '..');

  // Load both local Connector env files and shared workspace env files.
  loadEnvConfig(connectorRoot);
  loadEnvConfig(workspaceRoot);

  // Fallback parser for workspace-level env files when Next's loader only
  // considers project-local files in certain startup contexts.
  const envFiles = [
    path.join(connectorRoot, '.env.local'),
    path.join(connectorRoot, '.env'),
    path.join(workspaceRoot, '.env.local'),
    path.join(workspaceRoot, '.env'),
  ];
  for (const envFile of envFiles) {
    hydrateEnvFromFile(envFile);
  }

  // Connector/.env.local wins in Next's default order and can still point at an
  // older GitHub App. Workspace root `.env` is the source of truth for Auth/App IDs.
  hydrateAuthoritativeKeysFromFile(path.join(workspaceRoot, '.env'));

  envLoaded = true;
}

export function requireEnv(name: string): string {
  loadWorkspaceEnv();
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}
