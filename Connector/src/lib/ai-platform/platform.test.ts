import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decryptSecret, encryptSecret, maskSecret } from './crypto';
import { classifyProviderMessage, sanitizeProviderBody } from './errors';
import { rankModels, defaultRoutingPolicy } from './routing';
import { SEED_MODELS } from './catalog/seed';
import { estimateCost } from './metering';
import { canonicalizeProviderId, listRegisteredProviderIds } from './providers/registry';
import { DEFAULT_ORGANIZATION_POLICY } from './types';

describe('credential crypto', () => {
  it('round-trips secrets and never returns the raw value from the mask', () => {
    const secret = 'sk-ant-test-secret-value-1234';
    const packed = encryptSecret(secret);
    assert.notEqual(packed, secret);
    assert.equal(decryptSecret(packed), secret);
    assert.equal(maskSecret(secret), '********1234');
    assert.equal(maskSecret(secret).includes('sk-ant'), false);
  });
});

describe('error classification', () => {
  it('maps provider failures to canonical codes without leaking secrets', () => {
    assert.equal(classifyProviderMessage(401, 'invalid api key sk-ant-abcdefghijklmnop'), 'AUTHENTICATION_ERROR');
    assert.equal(classifyProviderMessage(429, 'rate limit exceeded'), 'RATE_LIMIT');
    assert.equal(classifyProviderMessage(400, 'maximum context length exceeded'), 'CONTEXT_LIMIT');
    const sanitized = sanitizeProviderBody('Bearer sk-ant-abcdefghijklmnop failed');
    assert.equal(sanitized.includes('sk-ant-abcdefghijklmnop'), false);
  });
});

describe('provider registry', () => {
  it('registers the eight first-class adapters plus OpenRouter', () => {
    const ids = listRegisteredProviderIds();
    for (const id of ['openai', 'anthropic', 'minimax', 'xai', 'gemini', 'kimi', 'glm', 'groq']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    assert.equal(canonicalizeProviderId('claude'), 'anthropic');
    assert.equal(canonicalizeProviderId('google'), 'gemini');
    assert.equal(canonicalizeProviderId('grok'), 'xai');
  });
});

describe('routing engine', () => {
  const policy = { ...DEFAULT_ORGANIZATION_POLICY, userId: 'user-1' };
  const routing = defaultRoutingPolicy('user-1');
  const available = new Set(SEED_MODELS.map((model) => model.providerId));

  it('resolves best_coding to a selectable coding model', () => {
    const result = rankModels({
      requested: 'best_coding',
      models: SEED_MODELS,
      policy,
      routing,
      health: new Map(),
      providersWithCredentials: available,
    });
    assert.ok(result.winner);
    assert.equal(result.winner?.model.capabilities.coding, true);
    assert.notEqual(result.winner?.model.lifecycle, 'RETIRED');
  });

  it('never selects retired models and explains skipped providers', () => {
    const retired = SEED_MODELS.map((model, index) => index === 0 ? { ...model, lifecycle: 'RETIRED' as const } : model);
    const result = rankModels({
      requested: retired[0].providerModelId,
      models: retired,
      policy,
      routing,
      health: new Map(),
      providersWithCredentials: available,
    });
    assert.ok(result.skipped.some((item) => item.skipReason?.includes('retired')));
  });

  it('honors organization provider allowlists', () => {
    const result = rankModels({
      requested: 'best_reasoning',
      models: SEED_MODELS,
      policy: { ...policy, allowedProviders: ['anthropic'] },
      routing,
      health: new Map(),
      providersWithCredentials: available,
    });
    assert.ok(result.winner);
    assert.equal(result.winner?.model.providerId, 'anthropic');
    assert.ok(result.skipped.some((item) => item.skipReason === 'Organization policy blocks provider'));
  });

  it('skips providers without credentials', () => {
    const result = rankModels({
      requested: 'best',
      models: SEED_MODELS,
      policy,
      routing,
      health: new Map(),
      providersWithCredentials: new Set(['groq']),
    });
    assert.equal(result.winner?.model.providerId, 'groq');
    assert.ok(result.skipped.some((item) => item.skipReason === 'BYOK unavailable'));
  });

  it('prefers the requested provider when ranking aliases', () => {
    const result = rankModels({
      requested: 'best_coding',
      models: SEED_MODELS,
      policy,
      routing,
      health: new Map(),
      providersWithCredentials: available,
      preferredProvider: 'anthropic',
    });
    assert.ok(result.winner);
    assert.equal(result.winner?.model.providerId, 'anthropic');
  });
});

describe('cost accounting', () => {
  it('keeps platform and BYOK charges on separate models', () => {
    const model = SEED_MODELS[0];
    const usage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedTokens: 0, reasoningTokens: 0, toolCalls: 0, estimated: false };
    const platform = estimateCost(model, usage, 'platform');
    const byok = estimateCost(model, usage, 'byok');
    assert.ok(platform.providerCostUsd > 0);
    assert.equal(byok.providerCostUsd, 0);
    assert.ok(byok.platformCostUsd > 0);
    assert.notEqual(platform.billingSource, byok.billingSource);
  });
});
