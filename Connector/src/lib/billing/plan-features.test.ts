import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlanFeatureMap,
  planIncludesFeature,
  planTierFromId,
} from './plan-features';

test('plan tiers gate paid features', () => {
  assert.equal(planTierFromId('free'), 'free');
  assert.equal(planTierFromId('starter_20'), 'starter');
  assert.equal(planTierFromId('pro_50'), 'pro');

  assert.equal(planIncludesFeature('free', 'deploy', true), false);
  assert.equal(planIncludesFeature('starter_20', 'deploy', true), true);
  assert.equal(planIncludesFeature('starter_20', 'customization', true), false);
  assert.equal(planIncludesFeature('pro_50', 'customization', true), true);
});

test('buildPlanFeatureMap exposes all feature flags', () => {
  const free = buildPlanFeatureMap('free', true);
  const starter = buildPlanFeatureMap('starter_20', true);
  assert.equal(free.customization, false);
  assert.equal(free.deploy, false);
  assert.equal(starter.deploy, true);
  assert.equal(starter.customization, false);
});
