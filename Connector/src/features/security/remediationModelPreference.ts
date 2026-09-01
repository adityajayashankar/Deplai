import type { AccessMode } from '@/lib/ai-platform/types';

const STORAGE_PREFIX = 'deplai.security.remediationModel.';

export type RemediationModelPreference = {
  accessMode: AccessMode;
  model: string;
  provider: string | null;
  credentialId: string | null;
};

export function remediationModelStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function readRemediationModelPreference(projectId: string): RemediationModelPreference | null {
  if (!projectId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(remediationModelStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RemediationModelPreference>;
    if (!parsed || typeof parsed !== 'object') return null;
    const accessMode = parsed.accessMode;
    if (accessMode !== 'platform' && accessMode !== 'byok' && accessMode !== 'auto') return null;
    if (typeof parsed.model !== 'string' || !parsed.model.trim()) return null;
    return {
      accessMode,
      model: parsed.model.trim(),
      provider: typeof parsed.provider === 'string' ? parsed.provider : null,
      credentialId: typeof parsed.credentialId === 'string' ? parsed.credentialId : null,
    };
  } catch {
    return null;
  }
}

export function storeRemediationModelPreference(
  projectId: string,
  preference: RemediationModelPreference,
): void {
  if (!projectId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(remediationModelStorageKey(projectId), JSON.stringify(preference));
  } catch {
    // ignore quota / privacy mode failures
  }
}
