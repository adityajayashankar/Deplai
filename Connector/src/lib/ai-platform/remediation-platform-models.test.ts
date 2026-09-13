import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_REMEDIATION_PLATFORM_MODEL,
  openRouterFreeRemediationModel,
} from './remediation-platform-models';
import { resolveOpenRouterSlug } from './openrouter-catalog';
import { SEED_MODELS } from './catalog/seed';

test('remediation always uses the OpenRouter free router', () => {
  assert.equal(DEFAULT_REMEDIATION_PLATFORM_MODEL, 'openrouter/free');
  const model = openRouterFreeRemediationModel(SEED_MODELS[0]);
  assert.equal(model.providerId, 'openrouter');
  assert.equal(model.providerModelId, 'openrouter/free');
  assert.equal(model.pricing.inputPerMillionUsd, 0);
  assert.equal(model.pricing.outputPerMillionUsd, 0);
});

test('live catalog provider IDs preserve the exact OpenRouter slug', () => {
  assert.equal(resolveOpenRouterSlug('openrouter:vendor/code-model'), 'vendor/code-model');
});


test('paid remediation has bounded output and explicit capped pricing', async () => {
  const { paidRemediationModel, configuredRemediationModel } = await import('./remediation-platform-models');
  const model = paidRemediationModel(SEED_MODELS[0]);
  assert.equal(model.providerModelId, 'z-ai/glm-5.3-flash');
  assert.equal(model.maxOutputTokens, 4096);
  assert.equal(model.pricing.inputPerMillionUsd, 0.15);
  assert.equal(model.pricing.outputPerMillionUsd, 0.50);
  assert.equal(model.metadata.security_free_router, false);
  const old = process.env.SECURITY_REMEDIATION_MODEL;
  try {
    process.env.SECURITY_REMEDIATION_MODEL = 'unapproved-model';
    assert.equal(configuredRemediationModel(), 'openrouter/free');
    process.env.SECURITY_REMEDIATION_MODEL = 'z-ai/glm-5.3-flash';
    assert.equal(configuredRemediationModel(), 'z-ai/glm-5.3-flash');
  } finally { if (old === undefined) delete process.env.SECURITY_REMEDIATION_MODEL; else process.env.SECURITY_REMEDIATION_MODEL = old; }
});
