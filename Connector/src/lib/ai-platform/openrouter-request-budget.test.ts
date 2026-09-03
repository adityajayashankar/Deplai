import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  constrainOpenRouterRequest,
  isOpenRouterLowQuotaModel,
  resetOpenRouterRequestBudgetForTests,
} from './openrouter-request-budget';

function withEnv(values: Record<string, string>, work: () => void) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetOpenRouterRequestBudgetForTests();
  }
}

describe('OpenRouter low-quota request budget', () => {
  it('covers all remediation models that need the conservative request cap', () => {
    assert.equal(isOpenRouterLowQuotaModel('nvidia/nemotron-3.5-content-safety:free'), true);
    assert.equal(isOpenRouterLowQuotaModel('nvidia/nemotron-3-nano-30b-a3b'), true);
    assert.equal(isOpenRouterLowQuotaModel('minimax/minimax-m3:free'), true);
    assert.equal(isOpenRouterLowQuotaModel('minimax/minimax-m3'), true);
    assert.equal(isOpenRouterLowQuotaModel('minimax/minimax-m2.7'), true);
    assert.equal(isOpenRouterLowQuotaModel('z-ai/glm-5.2'), false);
  });

  it('clamps completion tokens so an M3 request stays below the 8K safety ceiling', () => {
    resetOpenRouterRequestBudgetForTests();
    const result = constrainOpenRouterRequest({
      secret: 'sk-test-shared-key',
      model: 'minimax/minimax-m3:free',
      messages: [{ role: 'user', content: 'x'.repeat(4_000) }],
      requestedMaxTokens: 4096,
    });
    assert.ok(result.maxTokens);
    assert.ok(result.reservedTokens < 8_000);
    assert.equal(result.reservedTokens, result.maxTokens! + 4_040);
  });

  it('enforces a shared RPM reservation before a request reaches OpenRouter', () => {
    withEnv({ OPENROUTER_LOW_QUOTA_RPM: '2', OPENROUTER_LOW_QUOTA_TPM: '60000' }, () => {
      resetOpenRouterRequestBudgetForTests();
      const input = {
        secret: 'sk-test-shared-key',
        model: 'nvidia/nemotron-3.5-content-safety:free',
        messages: [{ role: 'user' as const, content: 'classify this patch' }],
        requestedMaxTokens: 512,
      };
      assert.doesNotThrow(() => constrainOpenRouterRequest(input));
      assert.doesNotThrow(() => constrainOpenRouterRequest(input));
      assert.throws(
        () => constrainOpenRouterRequest(input),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'RATE_LIMIT');
          assert.ok(Number((error as { detail?: { retryAfterSeconds?: number } }).detail?.retryAfterSeconds) > 0);
          return true;
        },
      );
    });
  });

  it('includes the strict JSON response schema in the request-token reservation', () => {
    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'remediation_plan',
        strict: true as const,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['summary'],
          properties: { summary: { type: 'string' } },
        },
      },
    };
    const withoutSchema = constrainOpenRouterRequest({
      secret: 'sk-without-schema',
      model: 'minimax/minimax-m3',
      messages: [{ role: 'user', content: '{"stage":"planner"}' }],
      requestedMaxTokens: 512,
    });
    const withSchema = constrainOpenRouterRequest({
      secret: 'sk-with-schema',
      model: 'minimax/minimax-m3',
      messages: [{ role: 'user', content: '{"stage":"planner"}' }],
      requestedMaxTokens: 512,
      responseFormat,
    });
    assert.ok(withSchema.reservedTokens > withoutSchema.reservedTokens);
    assert.ok(withSchema.reservedTokens < 8_000);
  });

  it('rejects a request whose input alone cannot leave a safe completion budget', () => {
    assert.throws(
      () => constrainOpenRouterRequest({
        secret: 'sk-test-shared-key',
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'x'.repeat(30_000) }],
        requestedMaxTokens: 1024,
      }),
      (error: unknown) => (error as { code?: string }).code === 'TOKEN_LIMIT',
    );
  });

  it('counts UTF-8 bytes so non-ASCII source cannot evade the 8K safety ceiling', () => {
    assert.throws(
      () => constrainOpenRouterRequest({
        secret: 'sk-test-shared-key',
        model: 'nvidia/nemotron-3.5-content-safety:free',
        messages: [{ role: 'user', content: '🛡️'.repeat(1_500) }],
        requestedMaxTokens: 512,
      }),
      (error: unknown) => (error as { code?: string }).code === 'TOKEN_LIMIT',
    );
  });
});
