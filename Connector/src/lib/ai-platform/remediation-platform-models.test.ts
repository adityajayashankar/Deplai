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
