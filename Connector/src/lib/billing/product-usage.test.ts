import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCreditAmount } from './credit-format';
import {
  dynamicUsageCredits,
  quoteProductUsage,
  usageTokenCount,
} from './product-usage';

const identity = {
  organizationId: 'org-1',
  userId: 'user-1',
  projectId: 'project-1',
  runId: 'run-1',
};

test('credit display is always constrained to two decimal places', () => {
  assert.equal(formatCreditAmount(124.904996), '124.90');
  assert.equal(formatCreditAmount(5), '5.00');
  assert.equal(formatCreditAmount(null), '—');
});

test('successful standard scans debit the configured half-credit minimum', () => {
  const quote = quoteProductUsage({ ...identity, kind: 'security_scan', outcome: 'succeeded' });
  assert.equal(quote.credits, 0.5);
  assert.equal(quote.source, 'security_scan');
});

test('failed scans and failed DAST runs do not charge credits', () => {
  assert.equal(quoteProductUsage({ ...identity, kind: 'security_scan', outcome: 'failed' }).credits, 0);
  assert.equal(quoteProductUsage({ ...identity, kind: 'dast', outcome: 'failed' }).credits, 0);
});

test('DAST-only scans use the one-credit DAST success rate', () => {
  assert.equal(quoteProductUsage({ ...identity, kind: 'security_scan', outcome: 'succeeded', dastOnly: true }).credits, 0);
  assert.equal(quoteProductUsage({ ...identity, kind: 'dast', outcome: 'succeeded' }).credits, 1);
});

test('remediation uses reported tokens on success and a half-credit charge on failure', () => {
  assert.equal(usageTokenCount({ input_tokens: 12_000, output_tokens: 8_000 }), 20_000);
  assert.equal(dynamicUsageCredits({ input_tokens: 12_000, output_tokens: 8_000 }, 1), 0.02);
  assert.equal(
    quoteProductUsage({
      ...identity,
      kind: 'remediation',
      outcome: 'succeeded',
      usage: { prompt_tokens: 12_000, completion_tokens: 8_000 },
      dynamicCreditsPerMillionTokens: 1,
    }).credits,
    0.02,
  );
  assert.equal(quoteProductUsage({ ...identity, kind: 'remediation', outcome: 'failed' }).credits, 0.5);
});

test('UI/UX only charges verified successful token usage', () => {
  assert.equal(quoteProductUsage({ ...identity, kind: 'uiux', outcome: 'failed' }).credits, 0);
  assert.equal(
    quoteProductUsage({
      ...identity,
      kind: 'uiux',
      outcome: 'succeeded',
      usage: { total_tokens: 45_000 },
      dynamicCreditsPerMillionTokens: 1,
    }).credits,
    0.05,
  );
});

test('verified deployment is charged once per project and UTC day', () => {
  const first = quoteProductUsage({
    ...identity,
    kind: 'deployment',
    outcome: 'succeeded',
    now: new Date('2026-09-07T23:30:00.000Z'),
  });
  const sameDay = quoteProductUsage({
    ...identity,
    runId: 'retry-run',
    kind: 'deployment',
    outcome: 'succeeded',
    now: new Date('2026-09-07T23:59:59.000Z'),
  });
  const nextDay = quoteProductUsage({
    ...identity,
    kind: 'deployment',
    outcome: 'succeeded',
    now: new Date('2026-09-08T00:00:00.000Z'),
  });
  assert.equal(first.credits, 3);
  assert.equal(first.idempotencyKey, sameDay.idempotencyKey);
  assert.notEqual(first.idempotencyKey, nextDay.idempotencyKey);
});
