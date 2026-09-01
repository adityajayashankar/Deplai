import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SEED_MODELS } from './catalog/seed';
import { canonicalizeRequestedModel, modelMatchesRequest } from './model-resolution';
import { rankModels, defaultRoutingPolicy } from './routing';
import { DEFAULT_ORGANIZATION_POLICY } from './types';

describe('model resolution', () => {
  const glmFree = SEED_MODELS.find((model) => model.id === 'glm:glm-5.2-free');
  assert.ok(glmFree);

  it('matches OpenRouter slugs and catalog ids to glm-5.2-free', () => {
    for (const candidate of ['glm-5.2-free', 'glm:glm-5.2-free', 'z-ai/glm-5.2:free', 'openrouter:z-ai/glm-5.2:free']) {
      assert.equal(canonicalizeRequestedModel(candidate, SEED_MODELS), 'glm-5.2-free', candidate);
      assert.equal(modelMatchesRequest(glmFree!, candidate), true, candidate);
    }
  });

  it('ranks the requested remediation model instead of rejecting the whole chain', () => {
    const policy = { ...DEFAULT_ORGANIZATION_POLICY, userId: 'user-1' };
    const routing = defaultRoutingPolicy('user-1');
    const providers = new Set(['glm', 'openrouter', 'anthropic', 'openai', 'gemini', 'minimax', 'groq', 'kimi', 'xai']);
    const result = rankModels({
      requested: canonicalizeRequestedModel('openrouter:z-ai/glm-5.2:free', SEED_MODELS),
      models: SEED_MODELS,
      policy,
      routing,
      health: new Map(),
      providersWithCredentials: providers,
    });
    assert.equal(result.winner?.model.id, 'glm:glm-5.2-free');
  });

  it('routes Nemotron via OpenRouter slug without skipping the provider', () => {
    const nemotron = SEED_MODELS.find((model) => model.id === 'openrouter:nemotron-3.5-content-safety-free');
    assert.ok(nemotron);
    const requested = canonicalizeRequestedModel('nvidia/nemotron-3.5-content-safety:free', SEED_MODELS);
    assert.equal(requested, 'nemotron-3.5-content-safety-free');
    const policy = { ...DEFAULT_ORGANIZATION_POLICY, userId: 'user-1' };
    const routing = defaultRoutingPolicy('user-1');
    const result = rankModels({
      requested,
      models: SEED_MODELS,
      policy,
      routing,
      health: new Map(),
      providersWithCredentials: new Set(['openrouter']),
    });
    assert.equal(result.winner?.model.id, 'openrouter:nemotron-3.5-content-safety-free');
    assert.equal(
      result.skipped.find((item) => item.model.id === 'openrouter:nemotron-3.5-content-safety-free'),
      undefined,
    );
  });
});
