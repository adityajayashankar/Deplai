import { PIPELINE_MODULES, type SecurityModuleId } from './types';

const STORAGE_PREFIX = 'deplai.security.dastTarget.';
const ASSET_PREFIX = 'deplai.security.dastAsset.';

export function defaultEnabledModules(): SecurityModuleId[] {
  return PIPELINE_MODULES.filter((item) => item.defaultEnabled).map((item) => item.id);
}

export function modulesForScan(enabled: SecurityModuleId[], dastTargetUrl: string): SecurityModuleId[] {
  const next = [...(enabled.length ? enabled : defaultEnabledModules())];
  if (dastTargetUrl.trim() && !next.includes('dast')) {
    next.push('dast');
  }
  return next;
}

export function dastStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function dastAssetStorageKey(projectId: string): string {
  return `${ASSET_PREFIX}${projectId}`;
}

export function readStoredDastTarget(projectId: string): string {
  if (!projectId || typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(dastStorageKey(projectId)) || '';
  } catch {
    return '';
  }
}

export function storeDastTarget(projectId: string, url: string): void {
  if (!projectId || typeof window === 'undefined') return;
  try {
    const trimmed = url.trim();
    if (trimmed) {
      window.localStorage.setItem(dastStorageKey(projectId), trimmed);
    } else {
      window.localStorage.removeItem(dastStorageKey(projectId));
    }
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function readStoredDastAsset(projectId: string): string {
  if (!projectId || typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(dastAssetStorageKey(projectId)) || '';
  } catch {
    return '';
  }
}

export function storeDastAsset(projectId: string, assetId: string): void {
  if (!projectId || typeof window === 'undefined') return;
  try {
    const trimmed = assetId.trim();
    if (trimmed) {
      window.localStorage.setItem(dastAssetStorageKey(projectId), trimmed);
    } else {
      window.localStorage.removeItem(dastAssetStorageKey(projectId));
    }
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function looksLikePublicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = (parsed.hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || host === 'localhost.localdomain') return false;
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
    return true;
  } catch {
    return false;
  }
}
