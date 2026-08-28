import { ASSET_OPTIONS } from './config';
import type { AssetType } from './types';

export function nowStamp(): string {
  return new Date().toLocaleTimeString();
}

export function sanitizeTenantId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

export function buildCustomizationHref(projectId?: string | null, projectName?: string | null): string {
  if (!projectId) return '/dashboard/customization';
  const params = new URLSearchParams();
  params.set('projectId', projectId);
  if (projectName) params.set('projectName', projectName);
  const tenantId = sanitizeTenantId(projectName || '') || sanitizeTenantId(projectId);
  if (tenantId) params.set('tenantId', tenantId);
  return `/dashboard/customization?${params.toString()}`;
}

export function isAssetType(value: string): value is AssetType {
  return ASSET_OPTIONS.some((option) => option.value === value);
}

export function getErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const body = payload as { error?: unknown; detail?: unknown; message?: unknown };
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  if (body.detail && typeof body.detail === 'object') {
    const detail = body.detail as { message?: unknown; errors?: unknown };
    if (typeof detail.message === 'string' && detail.message.trim()) {
      return Array.isArray(detail.errors) && detail.errors.length
        ? `${detail.message} ${detail.errors.join(' | ')}`
        : detail.message;
    }
  }
  return fallback;
}

export function formatUiText(value: string): string {
  return value
    .replace(/Tenant Customization Operator/gi, 'Customization Operator')
    .replace(/\bTenant ID\b/gi, 'Workspace ID')
    .replace(/\bTenant key\b/gi, 'Workspace')
    .replace(/\btenant key\b/gi, 'workspace')
    .replace(/\bTenant repository\b/gi, 'Workspace copy')
    .replace(/\btenant repository\b/gi, 'workspace copy')
    .replace(/\bTenant repo\b/gi, 'Workspace copy')
    .replace(/\btenant repo\b/gi, 'workspace copy')
    .replace(/\bTenant required\b/gi, 'Workspace required')
    .replace(/\btenant assets\b/gi, 'workspace assets')
    .replace(/\bTenant\b/g, 'Workspace')
    .replace(/\btenant\b/g, 'workspace')
    .replace(/SubSpace-/g, 'Edited-')
    .replace(/\bSubSpace\b/g, 'Edited Copy');
}

export function sanitizeManifestForDisplay(manifest: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  if ('tenant_id' in clone) {
    clone.workspace_id = clone.tenant_id;
    delete clone.tenant_id;
  }
  if ('tenant_name' in clone) {
    clone.workspace_name = clone.tenant_name;
    delete clone.tenant_name;
  }
  return clone;
}

export async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function diffLineClassName(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-zinc-500';
  if (line.startsWith('@@')) return 'bg-sky-500/10 text-sky-300';
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-300';
  if (line.startsWith('-')) return 'bg-rose-500/10 text-rose-300';
  return 'text-zinc-400';
}
