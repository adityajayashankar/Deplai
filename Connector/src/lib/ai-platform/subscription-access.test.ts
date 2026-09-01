import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertPlatformModelAllowed,
  DEFAULT_FREE_PLATFORM_MODEL,
  DEFAULT_REMEDIATION_PLATFORM_MODEL,
  defaultRemediationAccessMode,
  defaultRemediationModel,
  isBillingEnforced,
  isPaidPlanId,
  isPlatformModelAllowedForPlan,
  parseAccessMode,
  platformAliasesForPlan,
} from './subscription-access';

function withBillingEnforced<T>(enabled: boolean, fn: () => T): T {
  const prev = process.env.BILLING_ENFORCEMENT;
  const prevPublic = process.env.NEXT_PUBLIC_BILLING_ENFORCEMENT;
  process.env.BILLING_ENFORCEMENT = enabled ? 'true' : 'false';
  process.env.NEXT_PUBLIC_BILLING_ENFORCEMENT = enabled ? 'true' : 'false';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = prev;
    if (prevPublic === undefined) delete process.env.NEXT_PUBLIC_BILLING_ENFORCEMENT;
    else process.env.NEXT_PUBLIC_BILLING_ENFORCEMENT = prevPublic;
  }
}

describe('subscription platform model access', () => {
  it('treats starter, pro, and enterprise as paid plans', () => {
    assert.equal(isPaidPlanId('free'), false);
    assert.equal(isPaidPlanId(null), false);
    assert.equal(isPaidPlanId('starter_20'), true);
    assert.equal(isPaidPlanId('pro_50'), true);
    assert.equal(isPaidPlanId('enterprise'), true);
  });

  it('opens every platform model while billing is not enforced', () => {
    withBillingEnforced(false, () => {
      assert.equal(isBillingEnforced(), false);
      assert.equal(assertPlatformModelAllowed('free', 'claude-sonnet-5').ok, true);
      assert.equal(assertPlatformModelAllowed('free', 'gpt-5.6-sol').ok, true);
      assert.equal(assertPlatformModelAllowed('free', 'best_coding').ok, false);
      assert.equal(defaultRemediationModel('free'), DEFAULT_REMEDIATION_PLATFORM_MODEL);
      assert.ok(platformAliasesForPlan('free').includes('best_coding'));
    });
  });

  it('limits free plans to the free catalog when billing is enforced', () => {
    withBillingEnforced(true, () => {
      assert.equal(isBillingEnforced(), true);
      assert.equal(isPlatformModelAllowedForPlan('free', 'claude-haiku-4-5'), true);
      assert.equal(isPlatformModelAllowedForPlan('free', 'claude-sonnet-5'), false);
      assert.equal(assertPlatformModelAllowed('free', 'claude-haiku-4-5').ok, true);
      assert.equal(assertPlatformModelAllowed('free', 'best_fast').ok, false);
      assert.equal(assertPlatformModelAllowed('free', 'claude-sonnet-5').ok, false);
      assert.equal(assertPlatformModelAllowed('free', 'gpt-5.6-sol').ok, false);
    });
  });

  it('unlocks the full catalog on paid plans', () => {
    withBillingEnforced(true, () => {
      assert.equal(assertPlatformModelAllowed('starter_20', 'claude-sonnet-5').ok, true);
      assert.equal(assertPlatformModelAllowed('pro_50', 'anthropic:claude-sonnet-5').ok, true);
      assert.equal(defaultRemediationModel('pro_50'), DEFAULT_REMEDIATION_PLATFORM_MODEL);
      assert.equal(defaultRemediationModel('free'), DEFAULT_FREE_PLATFORM_MODEL);
    });
  });

  it('defaults paid workspaces to platform and free BYOK users to their keys when billing is enforced', () => {
    withBillingEnforced(true, () => {
      assert.equal(defaultRemediationAccessMode({ planId: 'pro_50', hasByok: false }), 'platform');
      assert.equal(defaultRemediationAccessMode({ planId: 'free', hasByok: true }), 'byok');
      assert.equal(defaultRemediationAccessMode({ planId: 'free', hasByok: false }), 'platform');
    });
    assert.equal(parseAccessMode('byok'), 'byok');
    assert.equal(parseAccessMode('keys'), null);
  });
});
