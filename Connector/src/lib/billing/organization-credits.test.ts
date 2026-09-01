import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREDIT_UNITS_PER_CREDIT,
  creditsToUnits,
  catalogPlan,
} from './credit-catalog';
import {
  expectedSubscriptionGrantCredits,
  creditMeteringMode,
  publicCreditBalance,
  InsufficientOrganizationCreditsError,
} from './organization-credits';

test('creditMeteringMode defaults to enforce and accepts shadow/off', () => {
  assert.equal(creditMeteringMode({}), 'enforce');
  assert.equal(creditMeteringMode({ CREDIT_METERING_MODE: 'shadow' }), 'shadow');
  assert.equal(creditMeteringMode({ CREDIT_METERING_MODE: 'enforce' }), 'enforce');
  assert.equal(creditMeteringMode({ CREDIT_METERING_MODE: 'off' }), 'off');
  assert.equal(creditMeteringMode({ CREDIT_METERING_MODE: 'invalid' }), 'enforce');
});

test('expectedSubscriptionGrantCredits matches the reduced v3 catalog', () => {
  assert.equal(expectedSubscriptionGrantCredits('free'), 0);
  assert.equal(expectedSubscriptionGrantCredits('starter_20', 'monthly'), 25);
  assert.equal(expectedSubscriptionGrantCredits('starter_20', 'yearly'), 25);
  assert.equal(expectedSubscriptionGrantCredits('pro_50', 'monthly'), 62.5);
  assert.equal(catalogPlan('starter_20')?.monthlyCredits, 25);
});

test('publicCreditBalance exposes fractional credits from bigint units', () => {
  const payload = publicCreditBalance({
    organizationId: 'org-1',
    balanceUnits: 25n * BigInt(CREDIT_UNITS_PER_CREDIT),
    reservedUnits: 2n * BigInt(CREDIT_UNITS_PER_CREDIT),
    availableUnits: 23n * BigInt(CREDIT_UNITS_PER_CREDIT),
    lifetimeGrantedUnits: 100n * BigInt(CREDIT_UNITS_PER_CREDIT),
    lifetimeConsumedUnits: 75n * BigInt(CREDIT_UNITS_PER_CREDIT),
    lifetimeRefundedUnits: 0n,
    debtUnits: 0n,
    status: 'ACTIVE',
  });
  assert.equal(payload.available, 23);
  assert.equal(payload.reserved, 2);
  assert.equal(payload.total, 25);
  assert.equal(payload.never_expires, true);
  assert.equal(creditsToUnits(0.123456), 123_456n);
});

test('free plan grants zero subscription credits', () => {
  assert.equal(expectedSubscriptionGrantCredits('free', 'monthly'), 0);
  assert.equal(expectedSubscriptionGrantCredits('free', 'yearly'), 0);
});

test('InsufficientOrganizationCreditsError exposes structured 402 fields', () => {
  const error = new InsufficientOrganizationCreditsError({
    organizationId: 'org-1',
    availableUnits: creditsToUnits(25),
    requiredUnits: creditsToUnits(100),
  });
  assert.equal(error.code, 'insufficient_organization_credits');
  assert.equal(error.status, 402);
  assert.equal(error.organizationId, 'org-1');
  assert.equal(error.topUpPath, '/dashboard/billing?view=credits');
});
