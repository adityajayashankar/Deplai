import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dedupeSetupModels } from './model-setup';

describe('dedupeSetupModels', () => {
  it('collapses duplicate providerModelId rows and prefers ACTIVE over DISCOVERED', () => {
    const result = dedupeSetupModels([
      {
        id: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
        providerModelId: 'claude-haiku-4-5',
        displayName: 'Claude Haiku 4.5',
        lifecycle: 'ACTIVE',
        coding: true,
        agents: true,
      },
      {
        id: 'anthropic:claude-haiku-4-5:discovered',
        providerId: 'anthropic',
        providerModelId: 'claude-haiku-4-5',
        displayName: 'Claude Haiku 4.5',
        lifecycle: 'DISCOVERED',
        coding: true,
        agents: true,
      },
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.lifecycle, 'ACTIVE');
    assert.equal(result[0]?.id, 'anthropic:claude-haiku-4-5');
  });

  it('keeps distinct provider models separate', () => {
    const result = dedupeSetupModels([
      {
        id: 'anthropic:claude-opus-5',
        providerId: 'anthropic',
        providerModelId: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        lifecycle: 'ACTIVE',
        coding: true,
        agents: true,
      },
      {
        id: 'anthropic:claude-sonnet-5',
        providerId: 'anthropic',
        providerModelId: 'claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        lifecycle: 'ACTIVE',
        coding: true,
        agents: true,
      },
    ]);

    assert.equal(result.length, 2);
  });
});
