import { getBalance } from '@/lib/billing/credits';
import { listCredentials } from '@/lib/ai-platform/credentials';
import { canonicalizeProviderId } from '@/lib/ai-platform/providers/definitions';
import type { AccessMode } from '@/lib/ai-platform/types';
import {
  assertPlatformModelAllowed,
  defaultRemediationModel,
  parseAccessMode,
} from '@/lib/ai-platform/subscription-access';

export type WorkflowLlmConfig = {
  access_mode: AccessMode;
  model: string;
  provider: string;
  user_id: string;
};

export async function resolveWorkflowLlmConfig(
  userId: string,
  incoming: Record<string, unknown> | null | undefined,
): Promise<{ ok: true; config: WorkflowLlmConfig } | { ok: false; status: number; error: string }> {
  const raw = incoming && typeof incoming === 'object' ? incoming : {};
  const accessMode = parseAccessMode(raw.access_mode ?? raw.accessMode) || 'auto';
  const provider = canonicalizeProviderId(String(raw.provider || '')) || '';
  const model = String(raw.model || raw.modelId || '').trim();

  if (accessMode === 'platform') {
    const balance = await getBalance(userId).catch(() => null);
    const resolvedModel = model || defaultRemediationModel(balance?.planId);
    const allowed = assertPlatformModelAllowed(balance?.planId, resolvedModel);
    if (!allowed.ok) {
      return { ok: false, status: 403, error: allowed.message };
    }
    return {
      ok: true,
      config: {
        access_mode: 'platform',
        model: resolvedModel,
        provider: '',
        user_id: userId,
      },
    };
  }

  if (accessMode === 'byok') {
    const creds = await listCredentials(userId, provider || undefined).catch(() => []);
    const usable = creds.filter((item) => item.status === 'VALID' || item.status === 'PENDING');
    if (!usable.length) {
      return {
        ok: false,
        status: 400,
        error: 'Add a BYOK key in AI Platform credentials before using your own models.',
      };
    }
    return {
      ok: true,
      config: {
        access_mode: 'byok',
        model: model || defaultRemediationModel(null),
        provider: provider || usable[0].providerId,
        user_id: userId,
      },
    };
  }

  return {
    ok: true,
    config: {
      access_mode: 'auto',
      model: model || 'best',
      provider,
      user_id: userId,
    },
  };
}
