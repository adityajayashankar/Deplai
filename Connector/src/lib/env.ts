import fs from 'fs';
import path from 'path';
import { loadEnvConfig } from '@next/env';

let envLoaded = false;

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

function hydrateEnvFromFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    const current = process.env[key];
    if (typeof current === 'string' && current.trim().length > 0) continue;

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

  envLoaded = true;
}

export function requireEnv(name: string): string {
  loadWorkspaceEnv();
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
