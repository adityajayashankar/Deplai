import assert from 'node:assert/strict';
import test from 'node:test';
import { fitSecurityRequest } from './security-request-budget';
import { openRouterFreeRemediationModel } from './remediation-platform-models';
import { SEED_MODELS } from './catalog/seed';

test('free router accepts relevant source context beyond the legacy 8K cap', () => {
  const model = openRouterFreeRemediationModel(SEED_MODELS[0]);
  const fitted = fitSecurityRequest({model: model.id, accessMode: 'platform', routingPolicy: 'default', stream: false, messages: [{role: 'user', content: 'a'.repeat(32000)}], maxTokens: 8192}, model);
  assert.equal(fitted.maxTokens, 8192);
  assert.ok(fitted.reservedTokens > 8192);
});

test('free router still refuses context that cannot leave output capacity', () => {
  const model = openRouterFreeRemediationModel(SEED_MODELS[0]);
  assert.throws(() => fitSecurityRequest({model: model.id, accessMode: 'platform', routingPolicy: 'default', stream: false, messages: [{role: 'user', content: 'a'.repeat(600000)}]}, model), /split/);
});

test('router fits long code and accounts for tool arguments and reasoning', () => {
  const model = openRouterFreeRemediationModel(SEED_MODELS[0]);
  const request = {model: model.id, accessMode: 'platform' as const, routingPolicy: 'default', stream: false,
    messages: [{role: 'user' as const, content: 'const value = 42;\n'.repeat(15000)}], maxTokens: 8192};
  assert.equal(fitSecurityRequest(request, model).maxTokens, 8192);
  assert.throws(() => fitSecurityRequest({...request, messages: [{role: 'assistant', content: '',
    toolCalls: [{id: 'edit', name: 'edit_file', arguments: 'x'.repeat(600000)}]}]}, model), /split/);
  assert.throws(() => fitSecurityRequest({...request, messages: [{role: 'assistant', content: '',
    reasoningDetails: [{text: 'x'.repeat(600000)}]}]}, model), /split/);
  assert.throws(() => fitSecurityRequest({...request, messages: [{role: 'user', content: '\u754c'.repeat(70000)}]}, model), /split/);
});
