import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleSecurityRow } from './security-model-catalog';

const row = { id: 'vendor/coder:free', pricing: { prompt: '0', completion: '0' }, context_length: 32768,
  top_provider: { max_completion_tokens: 8192 }, supported_parameters: [],
  benchmarks: { artificial_analysis: { coding_index: 50 } } };

test('free eligibility requires a zero-priced OpenRouter free coding variant', () => {
  assert.equal(eligibleSecurityRow(row), true);
  assert.equal(eligibleSecurityRow({ ...row, id: 'vendor/coder', pricing: { prompt: '0', completion: '0' } }), false);
  assert.equal(eligibleSecurityRow({ ...row, pricing: { prompt: '0.01', completion: '0' } }), false);
  assert.equal(eligibleSecurityRow({ ...row, benchmarks: {} }), false);
  assert.equal(eligibleSecurityRow({ ...row, id: 'vendor/content-safety:free' }), false);
  assert.equal(eligibleSecurityRow({ ...row, pricing: { prompt: null, completion: '0' } }), false);
});
test('free eligibility rejects paid surcharges', () => {
  assert.equal(eligibleSecurityRow({ ...row, pricing: { prompt: '0', completion: '0', request: '0.10' } }), false);
});
