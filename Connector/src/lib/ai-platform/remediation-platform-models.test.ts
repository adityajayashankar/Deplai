import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_REMEDIATION_PLATFORM_MODEL,
  REMEDIATION_PLATFORM_MODEL_IDS,
  filterRemediationPlatformModels,
} from './remediation-platform-models';
import { resolveOpenRouterSlug } from './openrouter-catalog';

describe('remediation platform models', () => {
  it('defaults to GLM 5.2 free on OpenRouter', () => {
    assert.equal(DEFAULT_REMEDIATION_PLATFORM_MODEL, 'glm-5.2-free');
    assert.equal(resolveOpenRouterSlug('glm:glm-5.2-free'), 'z-ai/glm-5.2:free');
  });

  it('limits remediation picker to curated platform models', () => {
    const models = [
      { id: 'minimax:MiniMax-M3-free' },
      { id: 'minimax:MiniMax-M3' },
      { id: 'glm:glm-5' },
      { id: 'glm:glm-5.2-free' },
      { id: 'openrouter:nemotron-3.5-content-safety-free' },
      { id: 'xai:grok-4.6' },
      { id: 'anthropic:claude-sonnet-5' },
    ];
    const filtered = filterRemediationPlatformModels(models);
    assert.equal(filtered.length, 5);
    assert.deepEqual(filtered.map((item) => item.id), [...REMEDIATION_PLATFORM_MODEL_IDS]);
  });

  it('maps MiniMax M3 free to OpenRouter slug', () => {
    assert.equal(resolveOpenRouterSlug('minimax:MiniMax-M3-free'), 'minimax/minimax-m3:free');
  });

  it('maps Nemotron content safety free to OpenRouter slug', () => {
    assert.equal(
      resolveOpenRouterSlug('openrouter:nemotron-3.5-content-safety-free'),
      'nvidia/nemotron-3.5-content-safety:free',
    );
  });
});
