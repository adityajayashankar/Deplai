import assert from 'node:assert/strict';
import test from 'node:test';
import { modulesForAutomaticSecurityPlan } from './sdlc-events';

test('automatic SDLC coverage follows the subscription entitlement', () => {
  assert.deepEqual(modulesForAutomaticSecurityPlan('push', false), ['sast']);
  assert.deepEqual(modulesForAutomaticSecurityPlan('pull_request', false), ['sast']);
  assert.equal(modulesForAutomaticSecurityPlan('build', false), null);
  assert.equal(modulesForAutomaticSecurityPlan('predeploy', false), null);
  assert.deepEqual(modulesForAutomaticSecurityPlan('build', true), ['sbom', 'sca', 'containers']);
  assert.deepEqual(modulesForAutomaticSecurityPlan('predeploy', true), ['iac', 'kubernetes', 'cicd', 'api']);
});
