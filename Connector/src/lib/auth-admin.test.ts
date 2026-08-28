import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { matchesConfiguredAdminUnlockKey } from './auth';

describe('matchesConfiguredAdminUnlockKey', () => {
  const originalAdminKey = process.env.ADMIN_ACCESS_KEY;
  const originalServiceKey = process.env.DEPLAI_SERVICE_KEY;

  beforeEach(() => {
    process.env.ADMIN_ACCESS_KEY = 'workspace-admin-unlock';
    process.env.DEPLAI_SERVICE_KEY = 'connector-to-agentic-service-key';
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_ACCESS_KEY;
    else process.env.ADMIN_ACCESS_KEY = originalAdminKey;
    if (originalServiceKey === undefined) delete process.env.DEPLAI_SERVICE_KEY;
    else process.env.DEPLAI_SERVICE_KEY = originalServiceKey;
  });

  it('accepts ADMIN_ACCESS_KEY and rejects the Connector service key', () => {
    assert.equal(matchesConfiguredAdminUnlockKey('workspace-admin-unlock'), true);
    assert.equal(matchesConfiguredAdminUnlockKey('connector-to-agentic-service-key'), false);
    assert.equal(matchesConfiguredAdminUnlockKey(''), false);
  });
});
