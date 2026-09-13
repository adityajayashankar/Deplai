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
import { ENTERPRISE_COMING_SOON_MESSAGE, FALLBACK_PLANS, planIsAvailableForCheckout } from './credits';

test('v4 catalog uses the approved INR plan and top-up prices', () => {
  const free = CREDIT_PLANS.find((plan) => plan.id === 'free');
  const starter = CREDIT_PLANS.find((plan) => plan.id === 'starter_20');
  const pro = CREDIT_PLANS.find((plan) => plan.id === 'pro_50');
  assert.equal(free?.monthlyCredits, 0);
  assert.equal(starter?.monthlyPricePaise, 49_900);
  assert.equal(starter?.annualPricePaise, 539_900);
  assert.equal(starter?.monthlyCredits, 25);
  assert.equal(pro?.monthlyPricePaise, 99_900);
  assert.equal(pro?.annualPricePaise, 1_079_900);
  assert.equal(pro?.monthlyCredits, 62.5);
  assert.deepEqual(CREDIT_PACKS.map((pack) => [pack.id, pack.credits, pack.pricePaise]), [
    ['topup_100_v2', 25, 39_900],
  ]);
});

test('starter GST and contribution math is exact to paise', () => {
  assert.deepEqual(splitGstInclusive(49_900), {
    taxablePaise: 42_288,
    gstPaise: 7_612,
    totalPaise: 49_900,
  });
  const economics = catalogEconomics(49_900, 25);
  assert.equal(economics.processorFeePaise, 1_073);
  assert.equal(economics.providerBudgetPaise, 32_500);
  assert.equal(economics.contributionPaise, 8_715);
});

test('enterprise is shown but cannot enter self-serve checkout', () => {
  const enterprise = FALLBACK_PLANS.find((plan) => plan.id === 'enterprise');
  assert.equal(planIsAvailableForCheckout('starter_20'), true);
  assert.equal(planIsAvailableForCheckout('enterprise'), false);
  assert.equal(enterprise?.isAvailable, false);
  assert.equal(enterprise?.availabilityMessage, ENTERPRISE_COMING_SOON_MESSAGE);
});

test('fractional credit units round provider spend upward', () => {
  assert.equal(creditsToUnits(1), 1_000_000n);
  assert.equal(unitsToCredits(123_456n), 0.123456);
  assert.equal(providerCostUsdToUnits(1, 95), 7_307_693n);
  assert.equal(providerCostUsdToUnits(0, 95), 0n);
});

test('pricing safety preserves the ₹300 contribution floor per 100 credits', () => {
  assert.doesNotThrow(() => assertStarterContributionSafe({ BILLING_GST_RATE: '18', BILLING_PROCESSOR_FEE_BPS: '215' }));
  assert.throws(
    () => assertStarterContributionSafe({ BILLING_GST_RATE: '30', BILLING_PROCESSOR_FEE_BPS: '1000' }),
    /temporarily paused/,
  );
});
