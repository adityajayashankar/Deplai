import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGrant } from './complimentary-policy';
import { permissionForStepUp, requiresStepUp } from '../authorization/permissions';

test('complimentary tiers exclude enterprise and invalid or expired dates', () => {
  for (const planId of ['free', 'starter_20', 'pro_50']) assert.equal(validateGrant(planId, null).planId, planId);
  assert.throws(() => validateGrant('enterprise', null));
  assert.throws(() => validateGrant('pro_50', 'invalid'));
  assert.throws(() => validateGrant('pro_50', '2020-01-01'));
  assert.equal(validateGrant('pro_50', '2030-01-01', 0).expiresAt?.getUTCFullYear(), 2030);
});

test('tier grants require billing permission and scoped step-up', () => {
  assert.equal(requiresStepUp('subscription.grant'), true);
  assert.equal(permissionForStepUp('subscription.grant'), 'ADMIN_BILLING_WRITE');
});
