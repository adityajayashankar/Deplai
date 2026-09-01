import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLATFORM_MODEL_ALLOWLIST,
  filterPlatformAllowlistedModels,
  isPlatformModelAllowed,
} from './platform-allowlist';
import {
  OPENROUTER_MODEL_SLUGS,
  assertAllowlistOpenRouterCoverage,
  resolveOpenRouterSlug,
  resolvePlatformDispatch,
} from './openrouter-catalog';
import { SEED_MODELS } from './catalog/seed';
import { providerBudgetPaiseToUsdLimit, shouldUsePlatformOpenRouterUpstream } from './platform-upstream';
import { SEED_MODELS } from './catalog/seed';
import { platformMeteringCostUsd } from './metering';

describe('platform model allowlist', () => {
  it('includes only ACTIVE catalog models', () => {
    for (const id of PLATFORM_MODEL_ALLOWLIST) {
      const model = SEED_MODELS.find((item) => item.id === id);
      assert.ok(model, `missing catalog model ${id}`);
      assert.notEqual(model?.lifecycle, 'DEPRECATED', id);
      assert.notEqual(model?.lifecycle, 'RETIRED', id);
    }
  });

  it('filters routing candidates to the allowlist', () => {
    const filtered = filterPlatformAllowlistedModels(SEED_MODELS);
    assert.equal(filtered.length, PLATFORM_MODEL_ALLOWLIST.length);
    assert.ok(filtered.every((model) => isPlatformModelAllowed(model.id)));
    assert.ok(!filtered.some((model) => model.id === 'anthropic:claude-fable-5'));
  });
});

describe('openrouter catalog mapping', () => {
  it('maps every allowlisted model to an OpenRouter slug', () => {
    assert.doesNotThrow(() => assertAllowlistOpenRouterCoverage());
    for (const id of PLATFORM_MODEL_ALLOWLIST) {
      assert.ok(OPENROUTER_MODEL_SLUGS[id], id);
      assert.match(resolveOpenRouterSlug(id), /\/.+/);
    }
  });

  it('dispatches platform traffic through OpenRouter while preserving billing ids', () => {
    const model = SEED_MODELS.find((item) => item.id === 'openai:gpt-5.3-codex');
    assert.ok(model);
    const dispatch = resolvePlatformDispatch(model!, true);
    assert.equal(dispatch.adapterProviderId, 'openrouter');
    assert.equal(dispatch.upstreamModelId, 'openai/gpt-5.3-codex');
    assert.equal(dispatch.billingModelId, 'openai:gpt-5.3-codex');
    assert.equal(dispatch.billingProviderId, 'openai');
  });
});

describe('openrouter budget conversion', () => {
  it('converts provider budget paise to a USD key cap', () => {
    assert.equal(providerBudgetPaiseToUsdLimit(32_500, 95), 3.42);
  });
});

describe('platform openrouter upstream routing', () => {
  it('uses OpenRouter upstream for allowlisted platform models without native provider keys', () => {
    const prevUpstream = process.env.AI_PLATFORM_UPSTREAM_OPENROUTER;
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.AI_PLATFORM_UPSTREAM_OPENROUTER = 'true';
    process.env.OPENROUTER_API_KEY = 'sk-test';
    try {
      assert.equal(
        shouldUsePlatformOpenRouterUpstream({
          accessMode: 'platform',
          modelId: 'glm:glm-5.2-free',
        }),
        true,
      );
      assert.equal(
        shouldUsePlatformOpenRouterUpstream({
          accessMode: 'byok',
          modelId: 'glm:glm-5.2-free',
        }),
        false,
      );
    } finally {
      if (prevUpstream === undefined) delete process.env.AI_PLATFORM_UPSTREAM_OPENROUTER;
      else process.env.AI_PLATFORM_UPSTREAM_OPENROUTER = prevUpstream;
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });
});

describe('platform metering minimum charge', () => {
  it('applies a minimum managed-platform charge for zero-priced models with token usage', () => {
    const model = SEED_MODELS.find((item) => item.id === 'glm:glm-5.2-free');
    assert.ok(model);
    assert.equal(
      platformMeteringCostUsd(model!, {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cachedTokens: 0,
        reasoningTokens: 0,
        toolCalls: 0,
        estimated: false,
      }),
      0.001,
    );
  });
});
