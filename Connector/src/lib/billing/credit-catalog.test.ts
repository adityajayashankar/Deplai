import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREDIT_PACKS,
  CREDIT_PLANS,
  catalogEconomics,
  creditsToUnits,
  providerCostUsdToUnits,
  splitGstInclusive,
  unitsToCredits,
  assertStarterContributionSafe,
} from './credit-catalog';

test('v3 catalog has rounded low pricing with proportionally reduced grants', () => {
  const free = CREDIT_PLANS.find((plan) => plan.id === 'free');
  const starter = CREDIT_PLANS.find((plan) => plan.id === 'starter_20');
  const pro = CREDIT_PLANS.find((plan) => plan.id === 'pro_50');
  assert.equal(free?.monthlyCredits, 0);
  assert.equal(starter?.monthlyPricePaise, 59_900);
  assert.equal(starter?.annualPricePaise, 649_900);
  assert.equal(starter?.monthlyCredits, 25);
  assert.equal(pro?.monthlyPricePaise, 139_900);
  assert.equal(pro?.annualPricePaise, 1_519_900);
  assert.equal(pro?.monthlyCredits, 62.5);
  assert.deepEqual(CREDIT_PACKS.map((pack) => [pack.id, pack.credits, pack.pricePaise]), [
    ['topup_100_v2', 25, 56_225],
  ]);
});

test('starter GST and contribution math is exact to paise', () => {
  assert.deepEqual(splitGstInclusive(59_900), {
    taxablePaise: 50_763,
    gstPaise: 9_137,
    totalPaise: 59_900,
  });
  const economics = catalogEconomics(59_900, 25);
  assert.equal(economics.processorFeePaise, 1_288);
  assert.equal(economics.providerBudgetPaise, 32_500);
  assert.equal(economics.contributionPaise, 16_975);
});

test('fractional credit units round provider spend upward', () => {
  assert.equal(creditsToUnits(1), 1_000_000n);
  assert.equal(unitsToCredits(123_456n), 0.123456);
  assert.equal(providerCostUsdToUnits(1, 95), 7_307_693n);
  assert.equal(providerCostUsdToUnits(0, 95), 0n);
});

test('pricing safety preserves the ₹450 contribution floor per 100 credits', () => {
  assert.doesNotThrow(() => assertStarterContributionSafe({ BILLING_GST_RATE: '18', BILLING_PROCESSOR_FEE_BPS: '215' }));
  assert.throws(
    () => assertStarterContributionSafe({ BILLING_GST_RATE: '30', BILLING_PROCESSOR_FEE_BPS: '1000' }),
    /temporarily paused/,
  );
});
