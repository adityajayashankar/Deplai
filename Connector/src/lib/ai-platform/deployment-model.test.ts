import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentGlmModel } from './security-model-catalog';
import { SEED_MODELS } from './catalog/seed';

test('deployment GLM uses catalog pricing without inheriting security billing exemptions', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{
    id: 'z-ai/glm-5.3-flash', context_length: 1310720,
    top_provider: { max_completion_tokens: 131072 },
    pricing: { prompt: '0.00000015', completion: '0.00000050' },
  }] });
  try {
    const model = await deploymentGlmModel(SEED_MODELS[0]);
    assert.equal(model.providerModelId, 'z-ai/glm-5.3-flash');
    assert.equal(model.providerId, 'openrouter');
    assert.equal(model.maxOutputTokens, 4000);
    assert.equal(model.pricing.inputPerMillionUsd, 0.15);
    assert.equal(model.pricing.outputPerMillionUsd, 0.5);
    assert.equal(model.metadata?.security_paid_remediation, undefined);
    assert.equal(model.metadata?.security_free_router, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
