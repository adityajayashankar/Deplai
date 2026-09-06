import { createHash } from 'node:crypto';
import { query, withNamedLock } from '@/lib/db';
import { AiPlatformError } from './errors';
import type { CanonicalModel, NormalizedChatRequest } from './types';
import { estimateOpenRouterInputTokens, openRouterRequestTokenCap } from './openrouter-request-budget';

let ready: Promise<void> | undefined;
function schema() {
  return ready ??= query(`CREATE TABLE IF NOT EXISTS security_provider_budgets (
    id VARCHAR(191) PRIMARY KEY, state_json JSON NOT NULL
  )`).then(() => undefined).catch((error) => { ready = undefined; throw error; });
}
type State = { attempts: number[]; cooldown: number };
function scope(_secret: string) {
  // A configured account id allows multiple credentials for one account to share quota.
  // Conservatively share the default bucket instead of assuming different keys have independent quotas.
  return createHash('sha256').update(process.env.SECURITY_OPENROUTER_ACCOUNT_ID || 'shared-security-account').digest('hex');
}
async function edit(id: string, change: (state: State) => void) {
  await schema();
  await withNamedLock(`security:${createHash('sha256').update(id).digest('hex').slice(0, 40)}`, 5, async () => {
    const rows = await query<Array<{ state_json: State | string }>>('SELECT state_json FROM security_provider_budgets WHERE id = ?', [id]);
    const raw = rows[0]?.state_json;
    const state: State = typeof raw === 'string' ? JSON.parse(raw) : raw || { attempts: [], cooldown: 0 };
    change(state);
    await query('INSERT INTO security_provider_budgets (id, state_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE state_json = VALUES(state_json)', [id, JSON.stringify(state)]);
  });
}
export function fitSecurityRequest(request: NormalizedChatRequest, model: CanonicalModel) {
  // Security JSON schemas are enforced locally, so omit their optional native
  // encoding from the exact OpenRouter free-model request budget.
  const input = estimateOpenRouterInputTokens(request.messages, request.tools, undefined);
  const safetyMargin = 256;
  const contextOutputCap = model.contextWindow - input - safetyMargin;
  const quotaOutputCap = openRouterRequestTokenCap() - input;
  const maxTokens = Math.min(request.maxTokens || 4096, model.maxOutputTokens, contextOutputCap, quotaOutputCap);
  if (maxTokens < 256) {
    throw new AiPlatformError('CONTEXT_LIMIT', 'Remediation context packet must be split before dispatch', { retryable: false,
      detail: { inputTokens: input, contextWindow: model.contextWindow, requestTokenCap: openRouterRequestTokenCap() } });
  }
  return { maxTokens, reservedTokens: input + maxTokens };
}
export async function reserveSecurityRequest(secret: string, model: string) {
  const account = scope(secret), now = Date.now();
  await edit(`${account}:${model}`, (state) => {
    if (state.cooldown > now) throw new AiPlatformError('RATE_LIMIT', 'Selected model is cooling down',
      { detail: { retryAfterSeconds: Math.ceil((state.cooldown - now) / 1000), quotaScope: 'model' } });
  });
  await edit(account, (state) => {
    state.attempts = state.attempts.filter((at) => at > now - 60_000);
    const rpm = Math.max(1, Math.min(20, Number(process.env.SECURITY_OPENROUTER_RPM || 8)));
    if (state.cooldown > now || state.attempts.length >= rpm) {
      throw new AiPlatformError('RATE_LIMIT', 'Remediation paused for shared OpenRouter capacity', {
        detail: { quotaScope: 'account', retryAfterSeconds: Math.max(1, Math.ceil((Math.max(state.cooldown, (state.attempts[0] || now) + 60_000) - now) / 1000)) },
      });
    }
    state.attempts.push(now);
  });
}
export async function coolSecurityRequest(secret: string, model: string, error: AiPlatformError) {
  if (!['RATE_LIMIT', 'QUOTA_EXCEEDED'].includes(error.code)) return;
  const accountWide = error.code === 'QUOTA_EXCEEDED' || error.detail?.quotaScope === 'account';
  const seconds = Math.max(1, Number(error.detail?.retryAfterSeconds || (accountWide ? 3600 : 60)));
  await edit(accountWide ? scope(secret) : `${scope(secret)}:${model}`, (state) => {
    state.cooldown = Math.max(state.cooldown, Date.now() + seconds * 1000);
  });
}
